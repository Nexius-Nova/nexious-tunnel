import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { importSqlite } from "./migrateSqlite.js";

// 仅由 mysql.test.ts 导入，外层事务回滚所有测试记录。
test("MySQL 合并迁移保留密码、会话、归属和日志，预览与重复执行不增加数据", async () => {
  const root = mkdtempSync(join(tmpdir(), "nexious-import-")), file = join(root, "legacy.db");
  const source = new DatabaseSync(file);
  const rollback = new Error("test-rollback");
  try {
    const existing = await db.prepare("SELECT * FROM users LIMIT 1").get();
    assert.ok(existing);
    const nodeId = `migration-${randomUUID()}`, tunnelId = `migration-${randomUUID()}`;
    const now = new Date().toISOString(), expiry = new Date(Date.now() + 86_400_000).toISOString();
    const tokenHash = "b".repeat(64);
    source.exec(`CREATE TABLE users(id TEXT,username TEXT,password_hash TEXT,role TEXT,status TEXT,must_change_password INTEGER,quota_tunnels INTEGER,created_at TEXT);
      CREATE TABLE nodes(id TEXT,name TEXT,region TEXT,city TEXT,latency INTEGER,load INTEGER,status TEXT,host TEXT,ssh_port INTEGER,deploy_status TEXT);
      CREATE TABLE tunnels(id TEXT,name TEXT,protocol TEXT,local_host TEXT,local_port INTEGER,remote_port INTEGER,node_id TEXT,status TEXT,domain TEXT,created_at TEXT,auto_start INTEGER,owner_id TEXT);
      CREATE TABLE sessions(token_hash TEXT,id TEXT,user_id TEXT,created_at TEXT,expires_at TEXT,absolute_expires_at TEXT,last_seen_at TEXT);
      CREATE TABLE traffic(id INTEGER,tunnel_id TEXT,timestamp TEXT,inbound INTEGER,outbound INTEGER);`);
    source.prepare("INSERT INTO users VALUES(?,?,?,?,?,?,?,?)").run(existing.id, existing.username, "legacy-password-hash", "admin", "active", 0, 5, now);
    source.prepare("INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?,?)").run(nodeId, "导入测试", "默认", "默认", 0, 0, "online", "migration.example.test", 22, "configured");
    source.prepare("INSERT INTO tunnels VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(tunnelId, "导入隧道", "http", "127.0.0.1", 8080, 80, nodeId, "stopped", "migration", now, 0, null);
    source.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?)").run(tokenHash, "migration-session", existing.id, now, expiry, expiry, now);
    source.prepare("INSERT INTO traffic VALUES(?,?,?,?,?)").run(1, tunnelId, now, 123, 456);
    await assert.rejects(db.transaction(async () => {
      await assert.rejects(importSqlite(db, file), /目标 MySQL 非空/);
      const preview = await importSqlite(db, file, { merge: true, dryRun: true });
      assert.equal(preview.tables.users.inserted, 1);
      assert.equal(await db.prepare("SELECT id FROM tunnels WHERE id=?").get(tunnelId), undefined);
      throw rollback;
    }), error => error === rollback);
    assert.equal(await db.prepare("SELECT id FROM tunnels WHERE id=?").get(tunnelId), undefined);
    await assert.rejects(db.transaction(async () => {
      const result = await importSqlite(db, file, { merge: true });
      assert.equal(result.renamedUsers.length, 1);
      assert.match(result.renamedUsers[0].to, /_local\d*$/);
      const imported = await db.prepare("SELECT * FROM users WHERE username=?").get(result.renamedUsers[0].to);
      assert.ok(imported);
      assert.notEqual(imported.id, existing.id);
      assert.equal(imported.password_hash, "legacy-password-hash");
      assert.equal(imported.must_change_password, 0);
      assert.equal((await db.prepare("SELECT * FROM users WHERE id=?").get(existing.id))?.password_hash, existing.password_hash);
      assert.equal((await db.prepare("SELECT owner_id FROM tunnels WHERE id=?").get(tunnelId))?.owner_id, imported.id);
      assert.equal((await db.prepare("SELECT user_id FROM sessions WHERE token_hash=?").get(tokenHash))?.user_id, imported.id);
      assert.deepEqual(await db.prepare("SELECT inbound,outbound FROM traffic WHERE tunnel_id=?").get(tunnelId), { inbound: 123, outbound: 456 });
      assert.equal((await importSqlite(db, file, { merge: true })).alreadyImported, true);
      assert.equal(Number((await db.prepare("SELECT COUNT(*) AS n FROM traffic WHERE tunnel_id=?").get(tunnelId))?.n), 1);
      source.prepare("UPDATE users SET password_hash=?").run("modified-source");
      await assert.rejects(importSqlite(db, file, { merge: true }), /仍发生变化/);
      throw rollback;
    }), error => error === rollback);
    // 唯一键冲突发生在导入用户、节点之后，整个导入仍须回滚。
    const conflictNode = `conflict-${randomUUID()}`;
    await assert.rejects(db.transaction(async () => {
      await db.prepare("INSERT INTO nodes(id,name,region,city,latency,`load`,status,host) VALUES(?,?,?,?,?,?,?,?)")
        .run(conflictNode, "目标节点", "默认", "默认", 0, 0, "online", "conflict.example.test");
      await db.prepare("INSERT INTO tunnels(id,name,protocol,local_host,local_port,remote_port,node_id,status,domain,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(`conflict-${randomUUID()}`, "目标隧道", "http", "127.0.0.1", 8080, 80, conflictNode, "stopped", "migration", now);
      source.prepare("UPDATE tunnels SET node_id=?").run(conflictNode);
      source.prepare("UPDATE users SET password_hash=?").run("legacy-password-hash");
      const before = Number((await db.prepare("SELECT COUNT(*) AS n FROM users").get())?.n);
      await assert.rejects(importSqlite(db, file, { merge: true }), error => (error as { code?: string }).code === "ER_DUP_ENTRY");
      assert.equal(Number((await db.prepare("SELECT COUNT(*) AS n FROM users").get())?.n), before);
      assert.equal(await db.prepare("SELECT id FROM nodes WHERE id=?").get(nodeId), undefined);
      assert.equal(await db.prepare("SELECT source_id FROM sqlite_imports").get(), undefined);
      throw rollback;
    }), error => error === rollback);
  } finally {
    source.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("nexious-import-"));
    rmSync(root, { recursive: true, force: true });
  }
});
