import type { Database } from "./database.js";

export async function initializeAccountFeatures(db: Database, options: { seedPlans?: boolean } = {}) {
  const columns = [
    ["email", "VARCHAR(254)"], ["invite_code", "VARCHAR(24)"], ["invited_by", "VARCHAR(64)"],
    ["bonus_tunnels", "INT NOT NULL DEFAULT 0"], ["membership_plan_id", "VARCHAR(64)"],
    ["membership_until", "CHAR(24)"], ["membership_quota", "INT"]
  ];
  for (const [name, definition] of columns) {
    if (db.driver === "mysql") {
      const existing = await db.prepare("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME=?").get(name);
      if (existing) continue;
    }
    try { await db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`); }
    catch (error) {
      if (db.driver === "mysql" ? (error as { code?: string }).code !== "ER_DUP_FIELDNAME" : !String(error).includes("duplicate column name")) throw error;
    }
  }
  const tables = [
    `CREATE TABLE IF NOT EXISTS verification_challenges (
      id VARCHAR(64) PRIMARY KEY, purpose VARCHAR(32) NOT NULL, subject VARCHAR(384) NOT NULL,
      secret_hash VARCHAR(64), payload TEXT, created_at CHAR(24) NOT NULL, expires_at CHAR(24) NOT NULL,
      attempts INT NOT NULL DEFAULT 0, consumed INT NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS membership_plans (
      id VARCHAR(64) PRIMARY KEY, name VARCHAR(64) NOT NULL, description VARCHAR(500) NOT NULL,
      price_cents INT NOT NULL, duration_days INT NOT NULL, tunnel_quota INT NOT NULL,
      enabled INT NOT NULL DEFAULT 1, created_at CHAR(24) NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS membership_grants (
      request_id VARCHAR(64) PRIMARY KEY, user_id VARCHAR(64) NOT NULL, plan_id VARCHAR(64) NOT NULL,
      expires_at CHAR(24) NOT NULL, created_at CHAR(24) NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS referral_campaigns (
      id VARCHAR(64) PRIMARY KEY, name VARCHAR(64) NOT NULL, inviter_bonus INT NOT NULL,
      invitee_bonus INT NOT NULL, max_rewards INT NOT NULL, starts_at CHAR(24) NOT NULL,
      ends_at CHAR(24) NOT NULL, enabled INT NOT NULL DEFAULT 1, created_at CHAR(24) NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS referral_rewards (
      invitee_id VARCHAR(64) PRIMARY KEY, inviter_id VARCHAR(64) NOT NULL, campaign_id VARCHAR(64) NOT NULL,
      inviter_bonus INT NOT NULL, invitee_bonus INT NOT NULL, created_at CHAR(24) NOT NULL
    )`,
    // 配额流水：任何使用户有效配额变化的事件（购买/开通/到期/邀请/管理员调整）都写一条。
    // ref 用于幂等去重（如同一到期时间只记一次、同一订单只记一次）。
    `CREATE TABLE IF NOT EXISTS billing_records (
      id VARCHAR(64) PRIMARY KEY, user_id VARCHAR(64) NOT NULL, type VARCHAR(32) NOT NULL,
      delta INT NOT NULL, quota_after INT NOT NULL, description VARCHAR(255) NOT NULL,
      operator_id VARCHAR(64), operator_name VARCHAR(64), ref VARCHAR(64),
      created_at CHAR(24) NOT NULL
    )`,
    // 支付宝套餐订单：id 即商户订单号 out_trade_no；request_id 用于免费套餐直开的幂等。
    `CREATE TABLE IF NOT EXISTS payment_orders (
      id VARCHAR(64) PRIMARY KEY, user_id VARCHAR(64) NOT NULL, plan_id VARCHAR(64) NOT NULL,
      amount_cents INT NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'created',
      trade_no VARCHAR(64), qr_code VARCHAR(255), request_id VARCHAR(64),
      created_at CHAR(24) NOT NULL, paid_at CHAR(24)
    )`
  ];
  for (const table of tables) await db.exec(table + (db.driver === "mysql" ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci" : ""));
  if (db.driver === "sqlite") {
    await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email); CREATE UNIQUE INDEX IF NOT EXISTS idx_users_invite_code ON users(invite_code); CREATE INDEX IF NOT EXISTS idx_verification_subject ON verification_challenges(purpose,subject,created_at); CREATE INDEX IF NOT EXISTS idx_billing_user ON billing_records(user_id,created_at); CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_ref ON billing_records(user_id,type,ref); CREATE INDEX IF NOT EXISTS idx_orders_user ON payment_orders(user_id,created_at); CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_request ON payment_orders(request_id)");
  } else {
    const indexes: Array<[table: string, name: string, columns: string, unique: boolean]> = [
      ["users", "idx_users_email", "email", true], ["users", "idx_users_invite_code", "invite_code", true],
      ["verification_challenges", "idx_verification_subject", "purpose,subject,created_at", false],
      ["billing_records", "idx_billing_user", "user_id,created_at", false],
      ["billing_records", "idx_billing_ref", "user_id,type,ref", true],
      ["payment_orders", "idx_orders_user", "user_id,created_at", false],
      ["payment_orders", "idx_orders_request", "request_id", true]
    ];
    for (const [table, name, columns, unique] of indexes) {
      const existing = await db.prepare("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?").get(table, name);
      if (!existing) await db.exec(`CREATE ${unique ? "UNIQUE " : ""}INDEX ${name} ON ${table}(${columns})`);
    }
  }

  // 新安装没有套餐时提供一组可直接编辑的默认方案。已有数据保持不变，
  // 避免升级时覆盖管理员已经配置的价格和权益。
  const planCount = Number((await db.prepare("SELECT COUNT(*) AS plan_count FROM membership_plans").get() as { plan_count?: number | string } | undefined)?.plan_count ?? 0);
  if (options.seedPlans !== false && planCount === 0) {
    const createdAt = new Date().toISOString();
    const defaults = [
      ["plan-free", "免费版", "适合个人试用和轻量服务", 0, 30, 1],
      ["plan-basic", "基础版", "个人项目与小型服务", 990, 30, 5],
      ["plan-pro", "专业版", "团队与多服务场景", 2990, 30, 20],
      ["plan-enterprise", "企业版", "高配额与长期运营", 9990, 30, 100]
    ] as const;
    for (const [id, name, description, priceCents, durationDays, tunnelQuota] of defaults) {
      await db.prepare("INSERT INTO membership_plans(id,name,description,price_cents,duration_days,tunnel_quota,enabled,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, name, description, priceCents, durationDays, tunnelQuota, 1, createdAt);
    }
  }
}
