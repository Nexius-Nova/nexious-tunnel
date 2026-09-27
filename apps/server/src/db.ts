import { openDatabase } from "./database.js";
import { initializeMysql } from "./mysqlSchema.js";
import { initializeAccountFeatures } from "./accountSchema.js";

export const db = await openDatabase();
if (db.driver === "mysql") await initializeMysql(db);
else {

(await db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL, city TEXT NOT NULL,
    latency INTEGER NOT NULL, load INTEGER NOT NULL, status TEXT NOT NULL, host TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tunnels (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL, local_host TEXT NOT NULL,
    local_port INTEGER NOT NULL, remote_port INTEGER NOT NULL, node_id TEXT NOT NULL,
    status TEXT NOT NULL, domain TEXT, created_at TEXT NOT NULL, agent_token TEXT,
    auto_start INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(node_id) REFERENCES nodes(id)
  );
  CREATE TABLE IF NOT EXISTS traffic (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tunnel_id TEXT NOT NULL, timestamp TEXT NOT NULL,
    inbound INTEGER NOT NULL, outbound INTEGER NOT NULL,
    FOREIGN KEY(tunnel_id) REFERENCES tunnels(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tunnel_id TEXT NOT NULL, timestamp TEXT NOT NULL,
    client_ip TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL,
    duration INTEGER NOT NULL, bytes INTEGER NOT NULL,
    FOREIGN KEY(tunnel_id) REFERENCES tunnels(id) ON DELETE CASCADE
  );
  -- 账号体系：角色只有 admin / user 两种，权限差异见服务端的 requireAdmin 与数据作用域。
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
    must_change_password INTEGER NOT NULL DEFAULT 0,
    quota_tunnels INTEGER, created_at TEXT NOT NULL, created_by TEXT, last_login_at TEXT
  );
  -- 会话只保存 token 的 SHA-256，数据库泄露不等于会话泄露。
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, user_agent TEXT,
    id TEXT, absolute_expires_at TEXT, ip TEXT, reauthenticated_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, actor_name TEXT NOT NULL,
    action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT, ip TEXT,
    created_at TEXT NOT NULL
  );
  -- 运行时设置（如默认隧道配额），由管理员调整。
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_attempts (
    bucket TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 1, window_start INTEGER NOT NULL
  );
`));
try {
  (await db.exec("ALTER TABLE tunnels ADD COLUMN agent_token TEXT"));
} catch {
  /* existing database */
}
try {
  (await db.exec(
    "ALTER TABLE tunnels ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0"
  ));
} catch {
  /* existing database */
}
const nodeColumns = [
  ["server_host", "TEXT"],
  ["ssh_user", "TEXT"],
  ["ssh_port", "INTEGER NOT NULL DEFAULT 22"],
  ["controller_url", "TEXT"],
  ["controller_token", "TEXT"],
  ["deploy_status", "TEXT NOT NULL DEFAULT 'unconfigured'"],
  ["last_checked_at", "TEXT"],
  ["last_error", "TEXT"]
] as const;
for (const [name, definition] of nodeColumns) {
  try { (await db.exec(`ALTER TABLE nodes ADD COLUMN ${name} ${definition}`)); } catch { /* existing database */ }
}
// 访问日志/流量表是高频写入的热点，缺索引会让 /api/logs 的过滤查询随数据量线性劣化。
(await db.exec(`
  CREATE INDEX IF NOT EXISTS idx_access_logs_timestamp ON access_logs(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_access_logs_tunnel ON access_logs(tunnel_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_traffic_timestamp ON traffic(timestamp);
`));
// 隧道归属：用户角色的所有读写都必须按 owner_id 过滤；同时建索引避免全表扫描。
try {
  (await db.exec("ALTER TABLE tunnels ADD COLUMN owner_id TEXT"));
} catch {
  /* existing database */
}
(await db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tunnels_owner ON tunnels(owner_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(lower(username));
  CREATE INDEX IF NOT EXISTS idx_tunnels_domain ON tunnels(domain);
`));
// 与 MySQL 的 UNIQUE KEY idx_tunnels_domain(node_id,domain) 对齐：同节点子域名必须唯一，
// 否则并发创建会绕过应用层检查写入重复域名，公网路由出现歧义。
// 存量库可能已有重复数据，建索引失败时明确告警而不是让启动崩溃。
try {
  (await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tunnels_node_domain ON tunnels(node_id, lower(domain))"));
} catch {
  console.warn("[db] 存量隧道存在同节点重复域名，唯一索引未建立；请清理重复域名后重启");
}
for (const name of ["id", "absolute_expires_at", "ip", "reauthenticated_at"]) {
  try { (await db.exec(`ALTER TABLE sessions ADD COLUMN ${name} TEXT`)); } catch { /* existing database */ }
}
(await db.exec("UPDATE sessions SET id=substr(token_hash,1,24),absolute_expires_at=expires_at WHERE id IS NULL OR absolute_expires_at IS NULL"));
(await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_id ON sessions(id)"));
(await db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at)"));
}
await initializeAccountFeatures(db);
// 日志与流量只写不删会让数据库无限膨胀；由服务端定期调用清理。
export async function pruneOldData() {
  await db.prepare("DELETE FROM verification_challenges WHERE expires_at < ?").run(new Date(Date.now() - 86400000).toISOString());
  const retentionDays = Number(process.env.NEXIOUS_LOG_RETENTION_DAYS || 30);
  const trafficDays = Number(process.env.NEXIOUS_TRAFFIC_RETENTION_DAYS || 90);
  (await db.prepare("DELETE FROM access_logs WHERE timestamp < ?").run(new Date(Date.now() - retentionDays * 86400000).toISOString()));
  (await db.prepare("DELETE FROM traffic WHERE timestamp < ?").run(new Date(Date.now() - trafficDays * 86400000).toISOString()));
  (await db.prepare("DELETE FROM audit_logs WHERE created_at < ?").run(new Date(Date.now() - 180 * 86400000).toISOString()));
  (await db.prepare("DELETE FROM auth_attempts WHERE window_start < ?").run(Date.now() - 86400000));
}
(await db.exec(
  db.sql("UPDATE nodes SET host=lower(rtrim(replace(replace(host,'https://',''),'http://',''),'/')) WHERE host LIKE 'http://%' OR host LIKE 'https://%'",
    "UPDATE nodes SET host=lower(TRIM(TRAILING '/' FROM replace(replace(host,'https://',''),'http://',''))) WHERE host LIKE 'http://%' OR host LIKE 'https://%'")
));

async function seed() {
  const count = (
    (await db.prepare("SELECT COUNT(*) count FROM nodes").get()) as { count: number }
  ).count;
  if (count) return;
  const insertNode = db.prepare(
    "INSERT INTO nodes (id,name,region,city,latency,`load`,status,host) VALUES (@id,@name,@region,@city,@latency,@load,@status,@host)"
  );
  await Promise.all([
    {
      id: "n-sh-01",
      name: "华东 · 上海 A",
      region: "华东",
      city: "上海",
      latency: 18,
      load: 32,
      status: "online",
      host: "sh-a.edge.nexious.cn"
    },
    {
      id: "n-hk-01",
      name: "亚太 · 香港 A",
      region: "亚太",
      city: "香港",
      latency: 42,
      load: 58,
      status: "online",
      host: "hk-a.edge.nexious.cn"
    },
    {
      id: "n-sg-01",
      name: "亚太 · 新加坡 A",
      region: "亚太",
      city: "新加坡",
      latency: 73,
      load: 24,
      status: "online",
      host: "sg-a.edge.nexious.cn"
    },
    {
      id: "n-tk-01",
      name: "亚太 · 东京 A",
      region: "亚太",
      city: "东京",
      latency: 89,
      load: 76,
      status: "maintenance",
      host: "tk-a.edge.nexious.cn"
    }
  ].map(async (row) => (await insertNode.run(row))));
  const now = new Date().toISOString();
  const insertTunnel = db.prepare(
    "INSERT INTO tunnels (id,name,protocol,local_host,local_port,remote_port,node_id,status,domain,created_at) VALUES (@id,@name,@protocol,@local_host,@local_port,@remote_port,@node_id,@status,@domain,@created_at)"
  );
  await Promise.all([
    {
      id: "tun-web",
      name: "本地开发站点",
      protocol: "https",
      local_host: "127.0.0.1",
      local_port: 5173,
      remote_port: 443,
      node_id: "n-sh-01",
      status: "running",
      domain: "dev",
      created_at: now
    },
    {
      id: "tun-api",
      name: "测试环境 API",
      protocol: "https",
      local_host: "127.0.0.1",
      local_port: 4000,
      remote_port: 443,
      node_id: "n-hk-01",
      status: "running",
      domain: "api",
      created_at: now
    },
    {
      id: "tun-admin",
      name: "内部管理后台",
      protocol: "http",
      local_host: "127.0.0.1",
      local_port: 3000,
      remote_port: 80,
      node_id: "n-sh-01",
      status: "stopped",
      domain: "admin",
      created_at: now
    }
  ].map(async (row) => (await insertTunnel.run(row))));
  const traffic = db.prepare(
    "INSERT INTO traffic (tunnel_id,timestamp,inbound,outbound) VALUES (?,?,?,?)"
  );
  const logs = db.prepare(
    "INSERT INTO access_logs (tunnel_id,timestamp,client_ip,method,path,status,duration,bytes) VALUES (?,?,?,?,?,?,?,?)"
  );
  for (let i = 23; i >= 0; i--) {
    const time = new Date(Date.now() - i * 3600000).toISOString();
    (await traffic.run(
      "tun-web",
      time,
      1800000 + Math.round(Math.random() * 5400000),
      900000 + Math.round(Math.random() * 2600000)
    ));
    (await traffic.run(
      "tun-api",
      time,
      400000 + Math.round(Math.random() * 900000),
      250000 + Math.round(Math.random() * 600000)
    ));
  }
  await Promise.all([
    "/api/health",
    "/",
    "/assets/index.js",
    "/api/projects",
    "/favicon.ico"
  ].map(async (path, i) =>
    (await logs.run(
      "tun-web",
      new Date(Date.now() - i * 420000).toISOString(),
      `116.24.18.${42 + i}`,
      i === 3 ? "POST" : "GET",
      path,
      i === 4 ? 404 : 200,
      24 + i * 17,
      840 + i * 1320
    ))
  ));
}
// 演示数据默认关闭：裸部署不应出现假节点/假隧道，需要演示时显式设置 NEXIOUS_SEED_DEMO=1。
if (process.env.NEXIOUS_SEED_DEMO === "1") (await seed());

export async function tunnelRows(ownerId?: string | null) {
  // ownerId 为字符串时只返回该用户的隧道（用户角色必须走这条路径）；
  // 传 null/undefined 表示不过滤，仅限管理员与服务凭据（节点同步需要全量）。
  const scoped = typeof ownerId === "string";
  return (await db
    .prepare(
      `
    SELECT t.id, t.name, t.protocol, t.local_host, t.local_port, t.remote_port,
      t.node_id, t.status, t.domain, t.created_at, t.auto_start, t.owner_id,
      t.agent_token, n.controller_url, n.controller_token, n.server_host,
      n.name node_name, n.host node_host,
      u.username owner_name,
      ${db.sql("CASE WHEN t.domain IS NOT NULL AND t.domain != '' THEN 'https://' || t.domain || '.' || n.host || '/' ELSE NULL END",
        "CASE WHEN t.domain IS NOT NULL AND t.domain != '' THEN CONCAT('https://',t.domain,'.',n.host,'/') ELSE NULL END")} access_url
    FROM tunnels t
    JOIN nodes n ON n.id=t.node_id
    LEFT JOIN users u ON u.id=t.owner_id
    ${scoped ? "WHERE t.owner_id = ?" : ""}
    ORDER BY t.created_at DESC
  `
    )
    .all(...(scoped ? [ownerId] : [])));
}

// 用户实际配额：严格按套餐 —— 会员有效期内的配额只来自所开通的套餐；
// 未开通或已过期时套餐部分为 0。管理员直接设置的 quota_tunnels 与邀请奖励
// 按额外授予叠加，两者的每次变化都会写入 billing_records 流水。
export async function effectiveTunnelQuota(userId: string): Promise<number> {
  const row = (await db.prepare("SELECT quota_tunnels,bonus_tunnels,membership_until,membership_quota FROM users WHERE id=?").get(userId)) as
    | { quota_tunnels: number | null; bonus_tunnels: number; membership_until: string | null; membership_quota: number | null }
    | undefined;
  if (!row) return 0;
  const membershipActive = Boolean(row.membership_until && Date.parse(row.membership_until) > Date.now());
  const base = (membershipActive ? Math.max(0, Number(row.membership_quota ?? 0)) : 0) + Math.max(0, Number(row.quota_tunnels ?? 0));
  return Math.min(10000, base + Math.max(0, Number(row.bonus_tunnels || 0)));
}
