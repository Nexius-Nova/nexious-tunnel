import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在导入 ./auth.js（其会打开数据库）之前指向临时库，
// 否则测试会往开发用的数据文件里写入测试账号。
const tempDir = mkdtempSync(join(tmpdir(), "nexious-auth-"));
process.env.NEXIOUS_DB_PATH = join(tempDir, "auth-test.db");
process.env.NEXIOUS_DB_DRIVER = "sqlite";
process.env.NEXIOUS_SQLITE_TEST = "1";
delete process.env.NEXIOUS_NODE_CONTROLLER;

const {
  clearLoginFailures,
  createSession,
  createUser,
  deleteSession,
  deleteUserSessions,
  hashPassword,
  loginThrottle,
  passwordIssue,
  recordLoginFailure,
  resolveSession,
  userCount,
  usernameIssue,
  verifyPassword,
  wastePasswordTime
} = await import("./auth.js");

test("口令哈希可验证且不保存明文", async () => {
  const stored = (await hashPassword("correct-horse-battery"));
  assert.ok(stored.startsWith("scrypt$"));
  assert.ok(!stored.includes("correct-horse-battery"));
  assert.equal((await verifyPassword("correct-horse-battery", stored)), true);
  assert.equal((await verifyPassword("wrong-password", stored)), false);
  // 相同口令每次盐不同，哈希必须不同
  assert.notEqual((await hashPassword("same-password")), (await hashPassword("same-password")));
});

test("口令校验能拒绝畸形哈希而不抛错", async () => {
  for (const bad of ["", "plain", "scrypt$1$2$3", "md5$a$b$c$d$e", "scrypt$16384$8$1$@@@$@@@"])
    assert.equal((await verifyPassword("whatever", bad)), false);
});

test("弱口令与非法用户名被拒绝", () => {
  assert.ok(passwordIssue("short"));
  assert.ok(passwordIssue("Abc!234"));
  assert.equal(passwordIssue("Abc!2345"), null);
  assert.equal(passwordIssue("longenough123"), null);
  assert.ok(usernameIssue("ab"));
  assert.ok(usernameIssue("has space"));
  assert.ok(usernameIssue("a".repeat(33)));
  assert.equal(usernameIssue("good_user-1"), null);
});

test("未知用户的等价开销校验不会抛错", async () => {
  // 用于抵抗基于响应时间的用户名枚举
  await assert.doesNotReject(async () => (await wastePasswordTime("any-password")));
});

test("登录限流在阈值后阻断并可清除", async () => {
  const key = `test-throttle-${Date.now()}`;
  assert.equal((await loginThrottle(key)).blocked, false);
  for (let i = 0; i < 8; i += 1) (await recordLoginFailure(key));
  assert.equal((await loginThrottle(key)).blocked, true);
  assert.ok((await loginThrottle(key)).retryAfterSec > 0);
  (await clearLoginFailures(key));
  assert.equal((await loginThrottle(key)).blocked, false);
});

test("会话可创建、解析、注销，且停用用户立即失效", async () => {
  const name = `t_${Math.random().toString(36).slice(2, 8)}`;
  const id = (await createUser({ username: name, password: "password-123", role: "user" }));
  assert.ok((await userCount()) >= 1);

  const token = (await createSession(id, "node-test"));
  const principal = (await resolveSession(token));
  assert.equal(principal?.kind, "user");
  assert.equal(principal?.id, id);
  assert.equal(principal?.role, "user");

  // 未知 token 不可解析
  assert.equal((await resolveSession("not-a-real-token")), null);
  assert.equal((await resolveSession("")), null);

  // 注销后立即失效
  (await deleteSession(token));
  assert.equal((await resolveSession(token)), null);

  // 停用用户后其会话不可用，即使还没执行全量会话删除。
  const token2 = (await createSession(id, "node-test"));
  assert.ok((await resolveSession(token2)));
  const {db}=await import("./db.js");
  await db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(id);
  assert.equal((await resolveSession(token2)), null);
});

test("管理员角色在会话中被正确保留", async () => {
  const name = `a_${Math.random().toString(36).slice(2, 8)}`;
  const id = (await createUser({ username: name, password: "password-123", role: "admin", mustChangePassword: true }));
  const token = (await createSession(id));
  const principal = (await resolveSession(token));
  assert.equal(principal?.kind, "user");
  assert.equal(principal?.role, "admin");
  // 强制改密标记必须随会话下发，前端据此拦截进入主界面。
  assert.equal(
    principal?.kind === "user" ? principal.mustChangePassword : null,
    true
  );
  (await deleteUserSessions(id));
});

test("会话只保存哈希，绝对过期不会因活跃而延长，每个账号最多十个设备",async()=>{
  const {db}=await import("./db.js");
  const id=await createUser({username:"limits"+Math.random().toString(36).slice(2,7),password:"independent-session-password",role:"user"});
  const first=await createSession(id,"first-device","127.0.0.1",true);
  const row=await db.prepare("SELECT * FROM sessions WHERE user_id=?").get(id);
  assert.ok(row!.token_hash);assert.ok(!JSON.stringify(row).includes(first));
  const absolute=row!.absolute_expires_at;
  await db.prepare("UPDATE sessions SET last_seen_at=? WHERE user_id=?").run(new Date(Date.now()-6*60000).toISOString(),id);
  assert.ok(await resolveSession(first));
  assert.equal((await db.prepare("SELECT absolute_expires_at FROM sessions WHERE user_id=?").get(id))!.absolute_expires_at,absolute);
  await db.prepare("UPDATE sessions SET absolute_expires_at=? WHERE user_id=?").run(new Date(Date.now()-1000).toISOString(),id);
  assert.equal(await resolveSession(first),null);
  for(let i=0;i<11;i++)await createSession(id,"device-"+i);
  assert.equal(Number((await db.prepare("SELECT COUNT(*) count FROM sessions WHERE user_id=?").get(id))!.count),10);
});
