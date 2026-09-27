import type { Database } from "./database.js";

// MySQL 8.0+；ISO UTC 时间保持与本机/边缘节点的数据交换格式一致。
const tables = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at CHAR(24) NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sqlite_imports (
    source_id CHAR(64) PRIMARY KEY, snapshot_hash CHAR(64) NOT NULL,
    details TEXT NOT NULL, completed_at CHAR(24) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS nodes (
    id VARCHAR(64) PRIMARY KEY, name VARCHAR(100) NOT NULL, region VARCHAR(100) NOT NULL, city VARCHAR(100) NOT NULL,
    latency INT NOT NULL, \`load\` INT NOT NULL, status VARCHAR(20) NOT NULL, host VARCHAR(253) NOT NULL,
    server_host VARCHAR(253), ssh_user VARCHAR(64), ssh_port INT NOT NULL DEFAULT 22,
    controller_url VARCHAR(1024), controller_token VARCHAR(256), deploy_status VARCHAR(20) NOT NULL DEFAULT 'unconfigured',
    last_checked_at CHAR(24), last_error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY, username VARCHAR(32) COLLATE utf8mb4_unicode_ci NOT NULL UNIQUE,
    password_hash VARCHAR(256) NOT NULL, role VARCHAR(10) NOT NULL DEFAULT 'user', status VARCHAR(20) NOT NULL DEFAULT 'active',
    must_change_password TINYINT NOT NULL DEFAULT 0, quota_tunnels INT, created_at CHAR(24) NOT NULL,
    created_by VARCHAR(64), last_login_at CHAR(24)
  )`,
  `CREATE TABLE IF NOT EXISTS tunnels (
    id VARCHAR(64) PRIMARY KEY, name VARCHAR(100) NOT NULL, protocol VARCHAR(10) NOT NULL,
    local_host VARCHAR(253) NOT NULL, local_port INT NOT NULL, remote_port INT NOT NULL,
    node_id VARCHAR(64) NOT NULL, status VARCHAR(20) NOT NULL, domain VARCHAR(63), created_at CHAR(24) NOT NULL,
    agent_token VARCHAR(256), auto_start TINYINT NOT NULL DEFAULT 0, owner_id VARCHAR(64),
    INDEX idx_tunnels_owner(owner_id), UNIQUE KEY idx_tunnels_domain(node_id,domain),
    FOREIGN KEY(node_id) REFERENCES nodes(id), FOREIGN KEY(owner_id) REFERENCES users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS traffic (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tunnel_id VARCHAR(64) NOT NULL, timestamp CHAR(24) NOT NULL,
    inbound BIGINT NOT NULL, outbound BIGINT NOT NULL, INDEX idx_traffic_timestamp(timestamp),
    FOREIGN KEY(tunnel_id) REFERENCES tunnels(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS access_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tunnel_id VARCHAR(64) NOT NULL, timestamp CHAR(24) NOT NULL,
    client_ip VARCHAR(64) NOT NULL, method VARCHAR(16) NOT NULL, path TEXT NOT NULL, status INT NOT NULL,
    duration INT NOT NULL, bytes BIGINT NOT NULL,
    INDEX idx_access_logs_timestamp(timestamp), INDEX idx_access_logs_tunnel(tunnel_id,timestamp),
    FOREIGN KEY(tunnel_id) REFERENCES tunnels(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY, id VARCHAR(32) NOT NULL UNIQUE, user_id VARCHAR(64) NOT NULL,
    created_at CHAR(24) NOT NULL, expires_at CHAR(24) NOT NULL, absolute_expires_at CHAR(24) NOT NULL,
    last_seen_at CHAR(24) NOT NULL, user_agent VARCHAR(512), ip VARCHAR(64), reauthenticated_at CHAR(24),
    INDEX idx_sessions_user(user_id), INDEX idx_sessions_expiry(expires_at),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, actor_id VARCHAR(64), actor_name VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL, target_type VARCHAR(64), target_id VARCHAR(64), detail VARCHAR(500), ip VARCHAR(64),
    created_at CHAR(24) NOT NULL, INDEX idx_audit_created(created_at), INDEX idx_audit_actor(actor_id,created_at)
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    \`key\` VARCHAR(64) PRIMARY KEY, value VARCHAR(2048) NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS auth_attempts (
    bucket CHAR(64) PRIMARY KEY, failures INT NOT NULL DEFAULT 1, window_start BIGINT NOT NULL,
    INDEX idx_auth_attempts_window(window_start)
  )`
];

export async function initializeMysql(db: Database) {
  // 每次 DDL 都是幂等的；迁移记录只在全部表成功创建后写入。
  for (const table of tables) await db.exec(`${table} ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await db.prepare("INSERT IGNORE INTO schema_migrations(version,applied_at) VALUES(1,?)").run(new Date().toISOString());
  const column = await db.prepare("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sessions' AND COLUMN_NAME='reauthenticated_at'").get();
  if (!column) {
    try { await db.exec("ALTER TABLE sessions ADD COLUMN reauthenticated_at CHAR(24)"); }
    catch(error) { if ((error as {code?:string}).code !== "ER_DUP_FIELDNAME") throw error; }
  }
  await db.prepare("INSERT IGNORE INTO schema_migrations(version,applied_at) VALUES(2,?)").run(new Date().toISOString());
  await db.prepare("INSERT IGNORE INTO schema_migrations(version,applied_at) VALUES(3,?)").run(new Date().toISOString());
}
