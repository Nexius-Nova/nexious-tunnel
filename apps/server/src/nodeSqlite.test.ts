import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

test("边缘节点在生产模式保留 SQLite，同步、域名冲突、对账和日志级联正常", async () => {
  const root = mkdtempSync(join(tmpdir(), "nexious-node-sqlite-")), file = join(root, "node.db");
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const token = "node-sqlite-test-machine-token", base = `http://127.0.0.1:${port}`;
  const environment = { ...process.env, PORT: String(port), BIND_HOST: "127.0.0.1", NODE_ENV: "production",
    NEXIOUS_NODE_CONTROLLER: "1", NEXIOUS_SQLITE_TEST: "0", NEXIOUS_DB_DRIVER: "sqlite",
    NEXIOUS_DB_PATH: file, NEXIOUS_ADMIN_TOKEN: token };
  const child = spawn(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "index.ts")], { env: environment, stdio: "ignore" });
  let source: DatabaseSync | undefined;
  const sync = (body: Record<string, unknown>, authorized = true) => fetch(`${base}/internal/tunnels/sync`, {
    method: "POST", headers: { "content-type": "application/json", ...(authorized ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
  });
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const health = await fetch(`${base}/api/health`);
        if (health.ok) { assert.equal((await health.json()).database, "sqlite"); ready = true; break; }
      } catch { /* 等待子进程完成初始化。 */ }
      await delay(100);
    }
    assert.ok(ready, "边缘 SQLite 服务应能在未开启测试豁免时启动");
    const tunnel = { id: "edge-sqlite-tunnel", name: "节点隧道", protocol: "http", local_host: "127.0.0.1",
      local_port: 8080, remote_port: 80, node_id: "edge-local", node_host: "edge.example.test", domain: "app", agent_token: "agent-test" };
    assert.equal((await sync({ action: "upsert", tunnel }, false)).status, 401);
    assert.equal((await sync({ action: "upsert", tunnel })).status, 200);
    source = new DatabaseSync(file);
    assert.equal(source.prepare("SELECT COUNT(*) AS n FROM users").get()?.n, 0);
    assert.equal((await sync({ action: "upsert", tunnel: { ...tunnel, local_port: 9000 } })).status, 200);
    assert.equal(source.prepare("SELECT local_port FROM tunnels WHERE id=?").get(tunnel.id)?.local_port, 9000);
    assert.equal((await sync({ action: "upsert", tunnel: { ...tunnel, id: "other-id" } })).status, 409);
    assert.equal(source.prepare("SELECT COUNT(*) AS n FROM tunnels").get()?.n, 1);
    const now = new Date().toISOString();
    source.prepare("INSERT INTO traffic(tunnel_id,timestamp,inbound,outbound) VALUES(?,?,?,?)").run(tunnel.id, now, 123, 456);
    source.prepare("INSERT INTO access_logs(tunnel_id,timestamp,client_ip,method,path,status,duration,bytes) VALUES(?,?,?,?,?,?,?,?)")
      .run(tunnel.id, now, "127.0.0.1", "GET", "/", 200, 1, 456);
    assert.equal((await sync({ action: "reconcile", ids: [tunnel.id] })).status, 200);
    assert.equal(source.prepare("SELECT COUNT(*) AS n FROM traffic").get()?.n, 1);
    assert.equal((await sync({ action: "reconcile", ids: [] })).status, 200);
    for (const table of ["tunnels", "traffic", "access_logs"]) assert.equal(source.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0);
  } finally {
    source?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.kill(); await closed;
    }
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("nexious-node-sqlite-"));
    rmSync(root, { recursive: true, force: true });
  }
});
