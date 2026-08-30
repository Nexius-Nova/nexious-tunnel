import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const dbPath =
  process.env.NEXIOUS_DB_PATH || resolve(process.cwd(), "data/nexious.db");
mkdirSync(dirname(dbPath), { recursive: true });
const require = createRequire(import.meta.url);
let DatabaseConstructor: any;
try {
  DatabaseConstructor = require("node:sqlite").DatabaseSync;
} catch {
  DatabaseConstructor = require("better-sqlite3");
}
export const db: any = new DatabaseConstructor(dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
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
`);
try {
  db.exec("ALTER TABLE tunnels ADD COLUMN agent_token TEXT");
} catch {
  /* existing database */
}
try {
  db.exec(
    "ALTER TABLE tunnels ADD COLUMN auto_start INTEGER NOT NULL DEFAULT 0"
  );
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
  try { db.exec(`ALTER TABLE nodes ADD COLUMN ${name} ${definition}`); } catch { /* existing database */ }
}
// 访问日志/流量表是高频写入的热点，缺索引会让 /api/logs 的过滤查询随数据量线性劣化。
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_access_logs_timestamp ON access_logs(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_access_logs_tunnel ON access_logs(tunnel_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_traffic_timestamp ON traffic(timestamp);
`);
// 日志与流量只写不删会让数据库无限膨胀；由服务端定期调用清理。
export function pruneOldData() {
  const retentionDays = Number(process.env.NEXIOUS_LOG_RETENTION_DAYS || 30);
  const trafficDays = Number(process.env.NEXIOUS_TRAFFIC_RETENTION_DAYS || 90);
  db.prepare("DELETE FROM access_logs WHERE timestamp < datetime('now', ?)").run(`-${retentionDays} days`);
  db.prepare("DELETE FROM traffic WHERE timestamp < datetime('now', ?)").run(`-${trafficDays} days`);
}
db.exec(
  "UPDATE nodes SET host=lower(rtrim(replace(replace(host,'https://',''),'http://',''),'/')) WHERE host LIKE 'http://%' OR host LIKE 'https://%'"
);

function seed() {
  const count = (
    db.prepare("SELECT COUNT(*) count FROM nodes").get() as { count: number }
  ).count;
  if (count) return;
  const insertNode = db.prepare(
    "INSERT INTO nodes (id,name,region,city,latency,load,status,host) VALUES (@id,@name,@region,@city,@latency,@load,@status,@host)"
  );
  [
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
  ].forEach((row) => insertNode.run(row));
  const now = new Date().toISOString();
  const insertTunnel = db.prepare(
    "INSERT INTO tunnels (id,name,protocol,local_host,local_port,remote_port,node_id,status,domain,created_at) VALUES (@id,@name,@protocol,@local_host,@local_port,@remote_port,@node_id,@status,@domain,@created_at)"
  );
  [
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
  ].forEach((row) => insertTunnel.run(row));
  const traffic = db.prepare(
    "INSERT INTO traffic (tunnel_id,timestamp,inbound,outbound) VALUES (?,?,?,?)"
  );
  const logs = db.prepare(
    "INSERT INTO access_logs (tunnel_id,timestamp,client_ip,method,path,status,duration,bytes) VALUES (?,?,?,?,?,?,?,?)"
  );
  for (let i = 23; i >= 0; i--) {
    const time = new Date(Date.now() - i * 3600000).toISOString();
    traffic.run(
      "tun-web",
      time,
      1800000 + Math.round(Math.random() * 5400000),
      900000 + Math.round(Math.random() * 2600000)
    );
    traffic.run(
      "tun-api",
      time,
      400000 + Math.round(Math.random() * 900000),
      250000 + Math.round(Math.random() * 600000)
    );
  }
  [
    "/api/health",
    "/",
    "/assets/index.js",
    "/api/projects",
    "/favicon.ico"
  ].forEach((path, i) =>
    logs.run(
      "tun-web",
      new Date(Date.now() - i * 420000).toISOString(),
      `116.24.18.${42 + i}`,
      i === 3 ? "POST" : "GET",
      path,
      i === 4 ? 404 : 200,
      24 + i * 17,
      840 + i * 1320
    )
  );
}
if (process.env.NEXIOUS_SKIP_SEED !== "1") seed();

export function tunnelRows() {
  return db
    .prepare(
      `
    SELECT t.id, t.name, t.protocol, t.local_host, t.local_port, t.remote_port,
      t.node_id, t.status, t.domain, t.created_at, t.auto_start, t.agent_token, n.controller_url, n.controller_token,
      n.name node_name, n.host node_host,
      CASE WHEN t.domain IS NOT NULL AND t.domain != ''
        THEN 'https://' || t.domain || '.' || n.host || '/'
        ELSE NULL
      END access_url
    FROM tunnels t
    JOIN nodes n ON n.id=t.node_id
    ORDER BY t.created_at DESC
  `
    )
    .all();
}
