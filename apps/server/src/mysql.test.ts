import { after } from "node:test";

// 复用真实 HTTP 权限与账号流程测试，验证同一实现实际运行于 MySQL。
if (process.env.NEXIOUS_DB_DRIVER !== "mysql" || !process.env.NEXIOUS_MYSQL_DATABASE?.endsWith("_test") || process.env.DATABASE_URL)
  throw new Error("MySQL 测试必须使用独立的 *_test 数据库，禁止连接应用数据库");
process.env.NEXIOUS_TEST_MYSQL = "1";
const { db } = await import("./db.js");
await db.transaction(async () => {
  for (const table of ["sqlite_imports", "verification_challenges", "membership_grants", "membership_plans", "referral_rewards", "referral_campaigns", "sessions", "traffic", "access_logs", "tunnels", "nodes", "users", "audit_logs", "settings", "auth_attempts"])
    await db.exec(`DELETE FROM ${table}`);
});
after(() => db.close());
await import("./rbac.test.js");
await import("./migrateSqlite.test.js");
