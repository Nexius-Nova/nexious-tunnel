import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase, type Database } from "./database.js";
import { initializeMysql } from "./mysqlSchema.js";
import { initializeAccountFeatures } from "./accountSchema.js";

const columns: Record<string, string[]> = {
  membership_plans: ["id","name","description","price_cents","duration_days","tunnel_quota","enabled","created_at"],
  referral_campaigns: ["id","name","inviter_bonus","invitee_bonus","max_rewards","starts_at","ends_at","enabled","created_at"],
  users: ["id","username","password_hash","role","status","must_change_password","quota_tunnels","created_at","created_by","last_login_at","email","invite_code","invited_by","bonus_tunnels","membership_plan_id","membership_until","membership_quota"],
  nodes: ["id","name","region","city","latency","load","status","host","server_host","ssh_user","ssh_port","controller_url","controller_token","deploy_status","last_checked_at","last_error"],
  tunnels: ["id","name","protocol","local_host","local_port","remote_port","node_id","status","domain","created_at","agent_token","auto_start","owner_id"],
  membership_grants: ["request_id","user_id","plan_id","expires_at","created_at"],
  referral_rewards: ["invitee_id","inviter_id","campaign_id","inviter_bonus","invitee_bonus","created_at"],
  sessions: ["token_hash","id","user_id","created_at","expires_at","absolute_expires_at","last_seen_at","user_agent","ip","reauthenticated_at"],
  verification_challenges: ["id","purpose","subject","secret_hash","payload","created_at","expires_at","attempts","consumed"],
  auth_attempts: ["bucket","failures","window_start"],
  traffic: ["id","tunnel_id","timestamp","inbound","outbound"],
  access_logs: ["id","tunnel_id","timestamp","client_ip","method","path","status","duration","bytes"],
  audit_logs: ["id","actor_id","actor_name","action","target_type","target_id","detail","ip","created_at"],
  settings: ["key","value"]
};
type Row = Record<string, any>;
export interface ImportResult {
  tables: Record<string, { source: number; inserted: number; reused: number }>;
  renamedUsers: Array<{ from: string; to: string }>;
  alreadyImported: boolean;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export async function importSqlite(db: Database, file: string, options: { merge?: boolean; dryRun?: boolean } = {}): Promise<ImportResult> {
  if (db.driver !== "mysql") throw new Error("迁移目标必须是 MySQL");
  const path = resolve(file), source = new DatabaseSync(path, { readOnly: true });
  const snapshot: Record<string, Row[]> = {};
  try {
    source.exec("BEGIN");
    for (const [table, fields] of Object.entries(columns)) {
      const exists = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      const available = exists ? new Set(source.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name)) : new Set();
      snapshot[table] = exists ? source.prepare(`SELECT ${fields.map(field => available.has(field) ? `\`${field}\`` : `${["bonus_tunnels", "attempts", "consumed"].includes(field) ? "0" : "NULL"} AS \`${field}\``).join(",")} FROM ${table} ORDER BY \`${fields[0]}\``).all() : [];
    }
    source.exec("COMMIT");
  } finally { source.close(); }
  const sourceId = hash(process.platform === "win32" ? path.toLowerCase() : path);
  const snapshotHash = hash(JSON.stringify(snapshot));
  const result: ImportResult = { tables: {}, renamedUsers: [], alreadyImported: false };
  const rollback = new Error("migration-dry-run");
  try {
    await db.transaction(async () => {
      const previous = await db.prepare("SELECT snapshot_hash,details FROM sqlite_imports WHERE source_id=? FOR UPDATE").get(sourceId);
      if (previous) {
        if (previous.snapshot_hash !== snapshotHash) throw new Error("源库在迁移完成后仍发生变化，请停止残留的 SQLite 服务再处理，避免重复导入");
        Object.assign(result, JSON.parse(previous.details), { alreadyImported: true });
        return;
      }
      const target: Record<string, Row[]> = {};
      for (const table of Object.keys(columns)) target[table] = await db.prepare(`SELECT * FROM \`${table}\``).all();
      if (!options.merge && Object.entries(target).some(([table, rows]) => table !== "settings" && rows.length))
        throw new Error("目标 MySQL 非空；请先备份，并使用 --merge 合并导入，已有数据不会被覆盖");
      const maps: Record<string, Map<string, string>> = {};
      const names = new Set(target.users.map(user => String(user.username).toLowerCase()));
      for (const table of ["membership_plans", "referral_campaigns", "users", "nodes", "tunnels"]) {
        maps[table] = new Map();
        const existing = new Map(target[table].map(row => [String(row.id), row]));
        for (const row of snapshot[table]) {
          const id = String(row.id), collision = existing.get(id);
          const same = collision && columns[table].every(field => (collision[field] ?? null) === (row[field] ?? null));
          maps[table].set(id, !collision || same ? id : `import-${hash(`${sourceId}:${table}:${id}`).slice(0, 32)}`);
        }
      }
      const mapped = (table: string, value: unknown) => value == null ? null : maps[table]?.get(String(value)) ?? value;
      const administrator = snapshot.users.find(user => user.role === "admin" && user.status === "active");
      const fallbackOwner = administrator ? mapped("users", administrator.id) : target.users.find(user => user.role === "admin" && user.status === "active")?.id ?? null;
      const userIds = new Set([...target.users.map(row => row.id), ...maps.users.values()]);
      for (const [table, fields] of Object.entries(columns)) {
        result.tables[table] = { source: snapshot[table].length, inserted: 0, reused: 0 };
        const primary = table === "sessions" ? "token_hash" : table === "settings" ? "key" : table === "auth_attempts" ? "bucket" : table === "membership_grants" ? "request_id" : table === "referral_rewards" ? "invitee_id" : "id";
        const existing = new Map(target[table].map(row => [String(row[primary]), row]));
        for (const original of snapshot[table]) {
          const row = { ...original };
          if (maps[table]) row.id = mapped(table, row.id);
          if (table === "users") {
            row.created_by = mapped("users", row.created_by);
            row.invited_by = mapped("users", row.invited_by);
            row.membership_plan_id = mapped("membership_plans", row.membership_plan_id);
            if (!existing.has(String(row.id)) && names.has(String(row.username).toLowerCase())) {
              const from = String(row.username); let suffix = "_local", index = 2;
              while (names.has((from.slice(0, 32 - suffix.length) + suffix).toLowerCase())) suffix = `_local${index++}`;
              row.username = from.slice(0, 32 - suffix.length) + suffix;
              result.renamedUsers.push({ from, to: row.username });
            }
            names.add(String(row.username).toLowerCase());
          }
          if (table === "tunnels") {
            row.node_id = mapped("nodes", row.node_id);
            row.owner_id = mapped("users", row.owner_id);
            if (!row.owner_id || !userIds.has(row.owner_id)) row.owner_id = fallbackOwner;
          }
          if (table === "sessions" || table === "membership_grants") row.user_id = mapped("users", row.user_id);
          if (table === "sessions") {
            row.id ||= hash(`${sourceId}:${row.token_hash}`).slice(0, 24);
            row.absolute_expires_at ||= row.expires_at;
            if (target.sessions.some(value => value.id === row.id && value.token_hash !== row.token_hash)) row.id = hash(`${sourceId}:${row.token_hash}`).slice(0, 24);
          }
          if (table === "membership_grants") row.plan_id = mapped("membership_plans", row.plan_id);
          if (table === "referral_rewards") {
            row.invitee_id = mapped("users", row.invitee_id); row.inviter_id = mapped("users", row.inviter_id);
            row.campaign_id = mapped("referral_campaigns", row.campaign_id);
          }
          if (table === "verification_challenges" && ["email-bind-email", "captcha-node-reset", "proof-node-reset"].includes(row.purpose)) {
            const parts = String(row.subject).split(":"); parts[0] = String(mapped("users", parts[0])); row.subject = parts.join(":");
          }
          if (table === "traffic" || table === "access_logs") row.tunnel_id = mapped("tunnels", row.tunnel_id);
          if (table === "audit_logs") row.actor_id = mapped("users", row.actor_id);
          if (table === "nodes" && row.deploy_status === "deploying") { row.deploy_status = "error"; row.status = "maintenance"; row.last_error = "主控迁移后需重新检查服务器"; }
          const numericId = ["traffic", "access_logs", "audit_logs"].includes(table);
          if (!numericId && existing.has(String(row[primary]))) {
            result.tables[table].reused++;
            continue;
          }
          const insertFields = numericId ? fields.filter(field => field !== "id") : fields;
          await db.prepare(`INSERT INTO \`${table}\` (${insertFields.map(field => `\`${field}\``).join(",")}) VALUES (${insertFields.map(() => "?").join(",")})`).run(...insertFields.map(field => row[field]));
          result.tables[table].inserted++;
        }
      }
      await db.prepare("INSERT INTO sqlite_imports(source_id,snapshot_hash,details,completed_at) VALUES(?,?,?,?)").run(sourceId, snapshotHash, JSON.stringify(result), new Date().toISOString());
      if (options.dryRun) throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  return result;
}

async function main() {
  let db: Database | undefined;
  try {
    const file = process.argv.slice(2).find(value => !value.startsWith("--"));
    if (!file) throw new Error("用法：pnpm --filter @nexious/server migrate:sqlite <SQLite 路径> [--merge] [--dry-run]");
    db = await openDatabase();
    if (db.driver !== "mysql") throw new Error("迁移目标必须配置 MySQL");
    await initializeMysql(db);
    await initializeAccountFeatures(db, { seedPlans: false });
    const dryRun = process.argv.includes("--dry-run");
    const result = await importSqlite(db, file, { merge: process.argv.includes("--merge"), dryRun });
    console.log(JSON.stringify({ dryRun, ...result }));
    console.log("源 SQLite 保持原样；已有 MySQL 记录和密码保持不变，导入账号保留密码与有效会话。");
  } catch (error) {
    const value = error as Error & { code?: string };
    console.error(value.code ? `迁移未完成，数据写入已回滚（${value.code}）` : value.message);
    process.exitCode = 1;
  } finally { if (db) await db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
