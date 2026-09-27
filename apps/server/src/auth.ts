import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { db } from "./db.js";

export type Role = "admin" | "user";
export type Principal =
  | { kind: "service"; role: "admin"; label: string }
  | { kind: "user"; id: string; username: string; role: Role; mustChangePassword: boolean };

export const nowIso = () => new Date().toISOString();
export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
const SCRYPT_N = 32768, SCRYPT_R = 8, SCRYPT_P = 3, SCRYPT_KEYLEN = 64;
function derive(password: string, salt: Buffer, n = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, SCRYPT_KEYLEN,
    { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16), key = await derive(password, salt);
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), key.toString("base64")].join("$");
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, n, r, p, saltText, keyText, extra] = String(stored || "").split("$");
    if (scheme !== "scrypt" || ![16384, 32768].includes(Number(n)) || Number(r) !== 8 || ![1, 3].includes(Number(p)) || extra) return false;
    const salt = Buffer.from(saltText || "", "base64"), expected = Buffer.from(keyText || "", "base64");
    if (salt.length !== 16 || expected.length !== SCRYPT_KEYLEN) return false;
    return timingSafeEqual(await derive(password, salt, Number(n), Number(r), Number(p)), expected);
  } catch { return false; }
}
const dummyHash = hashPassword(randomBytes(24).toString("base64url"));
export async function wastePasswordTime(password: string) { await verifyPassword(password, await dummyHash); }
const commonPasswords = new Set(["12345678", "password", "qwertyui", "admin123", "password1234", "password12345", "123456789012", "qwerty123456", "admin1234567", "administrator", "changeme12345"]);
export function passwordIssue(password: unknown): string | null {
  if (typeof password !== "string") return "请输入有效密码";
  if (password.length < 8) return "密码至少 8 位，建议使用独立的长密码";
  if (password.length > 128) return "密码最多 128 位";
  if (!password.trim() || /^(.)\1+$/.test(password) || commonPasswords.has(password.toLowerCase())) return "请避免常见、重复或纯空格密码";
  return null;
}
export function usernameIssue(username: unknown): string | null {
  return typeof username === "string" && /^[a-zA-Z0-9._-]{3,32}$/.test(username.trim())
    ? null : "用户名需为 3-32 位字母、数字、点、下划线或连字符";
}

const idleMs = (remember: boolean) => remember ? 7 * 86400000 : 12 * 3600000;
const absoluteMs = (remember: boolean) => remember ? 30 * 86400000 : 86400000;
export async function createSession(userId: string, userAgent?: string, ip?: string, remember = false): Promise<string> {
  const token = randomBytes(32).toString("base64url"), created = nowIso();
  await db.transaction(async () => {
    const user = await db.prepare(`SELECT status FROM users WHERE id=?${db.forUpdate}`).get(userId);
    if (!user || user.status !== "active") throw new Error("账号不可用");
    await db.prepare("DELETE FROM sessions WHERE user_id=? AND (expires_at<=? OR absolute_expires_at<=?)").run(userId, created, created);
    const existing = await db.prepare("SELECT id FROM sessions WHERE user_id=? ORDER BY created_at DESC,id DESC").all(userId);
    for (const session of existing.slice(9)) await db.prepare("DELETE FROM sessions WHERE id=? AND user_id=?").run(session.id, userId);
    await db.prepare(`INSERT INTO sessions (id,token_hash,user_id,created_at,expires_at,absolute_expires_at,last_seen_at,user_agent,ip,reauthenticated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(randomBytes(12).toString("hex"), tokenHash(token), userId, created,
      new Date(Date.now() + idleMs(remember)).toISOString(), new Date(Date.now() + absoluteMs(remember)).toISOString(),
      created, userAgent?.slice(0, 512) || null, ip?.slice(0, 64) || null, created);
  });
  return token;
}
export async function deleteSession(token: string) { if (token) await db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash(token)); }
export async function deleteUserSessions(userId: string) { await db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId); }
export async function pruneExpiredSessions() { await db.prepare("DELETE FROM sessions WHERE expires_at<=? OR absolute_expires_at<=?").run(nowIso(), nowIso()); }
export async function resolveSession(token: string): Promise<Principal | null> {
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) return null;
  const row = await db.prepare(`SELECT s.token_hash,s.created_at,s.expires_at,s.absolute_expires_at,s.last_seen_at,
    u.id,u.username,u.role,u.status,u.must_change_password FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(tokenHash(token));
  if (!row) return null;
  if (row.status !== "active" || Date.parse(row.expires_at) <= Date.now() || Date.parse(row.absolute_expires_at) <= Date.now()) {
    await deleteSession(token); return null;
  }
  if (Date.now() - Date.parse(row.last_seen_at) > 5 * 60000) {
    const remember = Date.parse(row.absolute_expires_at) - Date.parse(row.created_at) > 86400000;
    await db.prepare("UPDATE sessions SET last_seen_at=?,expires_at=? WHERE token_hash=?").run(nowIso(),
      new Date(Math.min(Date.now() + idleMs(remember), Date.parse(row.absolute_expires_at))).toISOString(), row.token_hash);
  }
  return { kind: "user", id: row.id, username: row.username, role: row.role === "admin" ? "admin" : "user", mustChangePassword: Boolean(row.must_change_password) };
}
export function bearerToken(req: Request): string { return String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i)?.[1].trim() || ""; }
export async function userCount(): Promise<number> { return Number((await db.prepare("SELECT COUNT(*) count FROM users").get())?.count || 0); }

const LOGIN_WINDOW_MS = 15 * 60000;
export async function loginThrottle(key: string, maximum = 8): Promise<{ blocked: boolean; retryAfterSec: number }> {
  const row = await db.prepare("SELECT failures,window_start FROM auth_attempts WHERE bucket=?").get(tokenHash(key));
  const remaining = row ? LOGIN_WINDOW_MS - (Date.now() - Number(row.window_start)) : 0;
  return { blocked: remaining > 0 && Number(row?.failures) >= maximum, retryAfterSec: Math.max(0, Math.ceil(remaining / 1000)) };
}
export async function recordLoginFailure(key: string) {
  const bucket = tokenHash(key), now = Date.now();
  await db.transaction(async () => {
    await db.prepare(db.sql("INSERT INTO auth_attempts(bucket,failures,window_start) VALUES(?,0,?) ON CONFLICT(bucket) DO NOTHING",
      "INSERT IGNORE INTO auth_attempts(bucket,failures,window_start) VALUES(?,0,?)")).run(bucket, now);
    const row = await db.prepare(`SELECT failures,window_start FROM auth_attempts WHERE bucket=?${db.forUpdate}`).get(bucket);
    const expired = now - Number(row!.window_start) >= LOGIN_WINDOW_MS;
    await db.prepare("UPDATE auth_attempts SET failures=?,window_start=? WHERE bucket=?").run(expired ? 1 : Number(row!.failures) + 1, expired ? now : row!.window_start, bucket);
  });
}
export async function clearLoginFailures(key: string) { await db.prepare("DELETE FROM auth_attempts WHERE bucket=?").run(tokenHash(key)); }
export async function audit(actor: Principal | null, action: string, targetType?: string, targetId?: string, detail?: string, ip?: string) {
  await db.prepare(`INSERT INTO audit_logs (actor_id,actor_name,action,target_type,target_id,detail,ip,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(actor?.kind === "user" ? actor.id : null, actor ? (actor.kind === "user" ? actor.username : actor.label) : "anonymous",
      action, targetType || null, targetId || null, detail?.slice(0, 500) || null, ip?.slice(0, 64) || null, nowIso());
}
export function principalOf(req: Request): Principal | null { return (req as Request & { principal?: Principal }).principal ?? null; }
export function isAdmin(req: Request) { return principalOf(req)?.role === "admin"; }
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!principalOf(req)) return res.status(401).json({ message: "请先登录" });
  if (!isAdmin(req)) return res.status(403).json({ message: "需要管理员权限" }); next();
}
export function requireSelf(req: Request, res: Response, next: NextFunction) {
  if (principalOf(req)?.kind !== "user") return res.status(403).json({ message: "请使用个人账号登录" }); next();
}
export async function createUser(input: { username: string; password: string; role: Role; mustChangePassword?: boolean;
  createdBy?: string | null; quotaTunnels?: number | null; email?: string }): Promise<string> {
  const issue = usernameIssue(input.username) || passwordIssue(input.password);
  if (issue) throw new Error(issue);
  const id = `u-${randomBytes(12).toString("hex")}`;
  await db.prepare(`INSERT INTO users (id,username,password_hash,role,status,must_change_password,quota_tunnels,created_at,created_by,email,invite_code)
    VALUES (?,?,?,?,'active',?,?,?,?,?,?)`).run(id, input.username.trim(), await hashPassword(input.password), input.role,
      input.mustChangePassword ? 1 : 0, input.quotaTunnels ?? null, nowIso(), input.createdBy ?? null, input.email || null, randomBytes(8).toString("hex"));
  return id;
}
export async function lockAccounts() { await db.prepare("SELECT value FROM settings WHERE `key`='account_lock'" + db.forUpdate).get(); }
export async function bootstrapAdmin(): Promise<{ created: boolean; username?: string; password?: string }> {
  await db.prepare(db.sql("INSERT INTO settings(`key`,value) VALUES('account_lock','1') ON CONFLICT(`key`) DO NOTHING",
    "INSERT IGNORE INTO settings(`key`,value) VALUES('account_lock','1')")).run();
  if (process.env.NEXIOUS_NODE_CONTROLLER === "1") return { created: false };
  return db.transaction(async () => {
    await lockAccounts(); if (await userCount() > 0) return { created: false };
    const username = process.env.NEXIOUS_BOOTSTRAP_ADMIN?.trim() || "admin", fromEnv = process.env.NEXIOUS_BOOTSTRAP_ADMIN_PASSWORD || "";
    if (process.env.NODE_ENV === "production" && process.env.NEXIOUS_EMBEDDED !== "1" && !fromEnv) throw new Error("首次部署必须配置 NEXIOUS_BOOTSTRAP_ADMIN_PASSWORD（至少 8 位）；初始管理员将强制改密");
    const password = fromEnv || randomBytes(18).toString("base64url");
    const id = await createUser({ username, password, role: "admin", mustChangePassword: true });
    await db.prepare("UPDATE tunnels SET owner_id=? WHERE owner_id IS NULL").run(id);
    console.log(`[auth] 已创建初始管理员「${username}」，首次登录必须修改密码`);
    if (!fromEnv) console.log(`[auth] 本机初始密码（仅此一次）：${password}`);
    return { created: true, username, password: fromEnv ? undefined : password };
  });
}
