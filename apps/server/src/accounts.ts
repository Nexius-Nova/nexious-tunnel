import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, effectiveTunnelQuota } from "./db.js";
import { audit, bearerToken, clearLoginFailures, createSession, createUser, deleteSession, deleteUserSessions,
  hashPassword, lockAccounts, loginThrottle, nowIso, passwordIssue, principalOf, recordLoginFailure,
  requireAdmin, requireSelf, tokenHash, verifyPassword, wastePasswordTime, type Principal } from "./auth.js";
import { consumeVerification, normalizedEmail, sendEmailCode, VerificationError } from "./verification.js";
import { applyReferral } from "./membership.js";
import { recordBilling } from "./billing.js";

const username = z.string().trim().regex(/^[a-zA-Z0-9._-]{3,32}$/, "用户名需为 3-32 位字母、数字或 . _ -");
const password = z.string().min(1).max(200);
const credentials = z.object({ username, password, remember: z.boolean().default(false) });
const pagination = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(10).max(100).default(20) });

function publicUser(row: Record<string, any>) {
  return { id: row.id, username: row.username, email: row.email || null, role: row.role, status: row.status,
    mustChangePassword: Boolean(row.must_change_password), quotaTunnels: row.quota_tunnels === null ? null : Number(row.quota_tunnels),
    createdAt: row.created_at, lastLoginAt: row.last_login_at };
}
function invalidPassword(value: string, res: Response) {
  const issue = passwordIssue(value);
  if (issue) { res.status(400).json({ message: issue }); return true; }
  return false;
}
class AccountError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
async function activeAdministratorRequired(target: Record<string, any>, removing: boolean) {
  if (target.role !== "admin" || target.status !== "active" || !removing) return;
  const count = Number((await db.prepare("SELECT COUNT(*) count FROM users WHERE role='admin' AND status='active'").get())!.count);
  if (count <= 1) throw new AccountError(409, "系统必须保留至少一位启用的管理员");
}
async function limited(key: string, maximum: number, res: Response) {
  const throttle = await loginThrottle(key, maximum);
  if (!throttle.blocked) return false;
  res.setHeader("Retry-After", throttle.retryAfterSec);
  res.status(429).json({ message: "尝试次数过多，请稍后重试", code: "RATE_LIMITED", retryAfter: throttle.retryAfterSec });
  return true;
}

export function accountsRouter(options: { clientIp: (req: Request) => string; isNodeController: boolean; onUserDisabled: (id: string) => Promise<void> }) {
  const router = Router(), { clientIp } = options;
  router.use(async (req,res,next) => {
    const actor = principalOf(req);
    // Express 路由匹配大小写不敏感，但 req.path 保留原始大小写。
    // 不做小写归一化时，「/api/Users/...」能命中业务路由却绕过这里的二次验证判定。
    const path = req.path.toLowerCase();
    const sensitive = req.method !== "GET" && (path === "/settings" || path.startsWith("/users") || path.startsWith("/auth/sessions") || path.startsWith("/membership/"));
    if (actor?.kind !== "user" || !sensitive) return next();
    const row = await db.prepare("SELECT reauthenticated_at FROM sessions WHERE token_hash=? AND user_id=?").get(tokenHash(bearerToken(req)),actor.id);
    if (!row?.reauthenticated_at || Date.now() - Date.parse(row.reauthenticated_at) > 15 * 60000)
      return res.status(403).json({message:"此操作需要验证当前密码",code:"REAUTHENTICATION_REQUIRED"});
    next();
  });
  let authInFlight = 0;
  router.use((req, res, next) => {
    // 同上：并发限制的正则也必须大小写不敏感，否则大小写变体不会计入并发上限。
    if (!/^\/auth\/(login|register|password|verify-password)$|^\/users(?:\/[^/]+\/password)?$/i.test(req.path) || req.method !== "POST") return next();
    if (authInFlight >= 8) { res.setHeader("Retry-After", 5); return res.status(429).json({ message: "登录服务繁忙，请稍后重试", retryAfter: 5 }); }
    authInFlight += 1;
    let released = false;
    const release = () => { if (!released) { released = true; authInFlight -= 1; } };
    res.once("finish", release); res.once("close", release); next();
  });
  router.get("/auth/status", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ registrationEnabled: !options.isNodeController, passwordMinLength: 8, passwordMaxLength: 128 });
  });
  router.post("/auth/email-code", async (req, res) => {
    if (options.isNodeController) return res.status(403).json({ message: "请连接主控制中心注册" });
    const value = z.object({ email: normalizedEmail }).strict().parse(req.body);
    res.json(await sendEmailCode(value.email, "register", value.email, clientIp(req)));
  });
  router.post("/auth/email/code", requireSelf, async (req, res) => {
    const actor = principalOf(req) as Extract<Principal, { kind: "user" }>;
    const value = z.object({ email: normalizedEmail }).strict().parse(req.body);
    res.json(await sendEmailCode(value.email, "bind-email", `${actor.id}:${value.email}`, clientIp(req)));
  });
  router.post("/auth/email", requireSelf, async (req, res) => {
    const actor = principalOf(req) as Extract<Principal, { kind: "user" }>;
    const value = z.object({ email: normalizedEmail, verificationId: z.string().length(48), code: z.string().regex(/^\d{6}$/) }).strict().parse(req.body);
    await consumeVerification(value.verificationId, "email-bind-email", `${actor.id}:${value.email}`, value.code);
    await db.transaction(async () => {
      await lockAccounts();
      if (await db.prepare("SELECT id FROM users WHERE email=?").get(value.email)) throw new AccountError(409, "该邮箱已绑定账号");
      await db.prepare("UPDATE users SET email=? WHERE id=?").run(value.email, actor.id);
      await audit(actor, "email_bound", "user", actor.id, undefined, clientIp(req));
    }); res.json({ email: value.email });
  });
  router.post("/auth/register", async (req, res) => {
    if (options.isNodeController) return res.status(403).json({ message: "边缘节点不提供注册，请连接主控制中心" });
    const value = credentials.extend({ email: normalizedEmail, verificationId: z.string().length(48), code: z.string().regex(/^\d{6}$/), inviteCode: z.string().regex(/^[a-f0-9]{16}$/).optional() }).strict().parse(req.body), key = `register:${clientIp(req)}`;
    if (await limited(key, 5, res)) return;
    await recordLoginFailure(key);
    if (invalidPassword(value.password, res)) return;
    // 独立提交尝试次数，后续账号创建失败也不能回滚错误验证码次数。
    await consumeVerification(value.verificationId, "email-register", value.email, value.code);
    const id = await db.transaction(async () => {
      await lockAccounts();
      if (await db.prepare("SELECT id FROM users WHERE email=?").get(value.email)) throw new AccountError(409, "该邮箱已绑定账号");
      const id = await createUser({ ...value, role: "user" });
      await applyReferral(id, value.inviteCode);
      await audit({ kind: "user", id, username: value.username, role: "user", mustChangePassword: false }, "register", "user", id, undefined, clientIp(req));
      return id;
    });
    // 注册成功后清除预留的尝试计数，否则同 IP 连续注册几个合法账号就会触发限流。
    await clearLoginFailures(key);
    const token = await createSession(id, req.headers["user-agent"], clientIp(req), value.remember);
    res.status(201).json({ token, user: publicUser((await db.prepare("SELECT * FROM users WHERE id=?").get(id))!) });
  });
  router.post("/auth/login", async (req, res) => {
    if (options.isNodeController) return res.status(403).json({ message: "边缘节点不提供账号登录，请连接主控制中心" });
    const value = credentials.extend({ captchaTicket: z.string().length(48) }).strict().parse(req.body), key = `login:${clientIp(req)}:${value.username.toLowerCase()}`, ipKey = `login-ip:${clientIp(req)}`;
    if (await limited(key, 8, res) || await limited(ipKey, 40, res)) return;
    // 在校验前预留一次尝试，避免并发请求绕过阈值。
    await recordLoginFailure(key); await recordLoginFailure(ipKey);
    await consumeVerification(value.captchaTicket, "proof-login", clientIp(req), value.captchaTicket);
    const row = await db.prepare("SELECT * FROM users WHERE lower(username)=lower(?)").get(value.username);
    const valid = row ? await verifyPassword(value.password, row.password_hash) : (await wastePasswordTime(value.password), false);
    if (!valid || row?.status !== "active") {
      await audit(null, "login_failed", "user", undefined, `username=${value.username}`, clientIp(req));
      return res.status(401).json({ message: "用户名或密码错误" });
    }
    const token = await db.transaction(async () => {
      // 与管理员重置/停用串行，旧密码校验结果不能越过重置边界。
      const current = await db.prepare(`SELECT password_hash,status FROM users WHERE id=?${db.forUpdate}`).get(row.id);
      if (current?.status !== "active" || current.password_hash !== row.password_hash) throw new AccountError(401, "账号状态已变化，请重新登录");
      await db.prepare("UPDATE users SET last_login_at=? WHERE id=?").run(nowIso(), row.id);
      const token = await createSession(row.id, req.headers["user-agent"], clientIp(req), value.remember);
      await audit({ kind: "user", id: row.id, username: row.username, role: row.role, mustChangePassword: Boolean(row.must_change_password) }, "login", "user", row.id, undefined, clientIp(req));
      return token;
    });
    await clearLoginFailures(key);
    row.last_login_at = nowIso();
    res.json({ token, user: publicUser(row) });
  });
  router.post("/auth/logout", async (req, res) => {
    const actor = principalOf(req);
    if (actor?.kind === "user") await deleteSession(bearerToken(req));
    await audit(actor, "logout", "user", actor?.kind === "user" ? actor.id : undefined, undefined, clientIp(req));
    res.status(204).end();
  });
  router.get("/auth/me", async (req, res) => {
    const actor = principalOf(req);
    if (actor?.kind === "service") return res.json({ kind: "service", username: "本机管理员", role: "admin", mustChangePassword: false });
    const row = await db.prepare("SELECT * FROM users WHERE id=?").get((actor as Extract<Principal, {kind:"user"}>).id);
    if (!row) return res.status(401).json({ message: "登录状态已失效" });
    const used = Number((await db.prepare("SELECT COUNT(*) count FROM tunnels WHERE owner_id=?").get(row.id))!.count);
    res.json({ kind: "user", ...publicUser(row), tunnelCount: used, effectiveQuota: row.role === "admin" ? null : await effectiveTunnelQuota(row.id) });
  });
  router.post("/auth/password", requireSelf, async (req, res) => {
    const actor = principalOf(req) as Extract<Principal, {kind:"user"}>;
    const value = z.object({ currentPassword: password, newPassword: password, remember: z.boolean().default(false) }).strict().parse(req.body);
    if (invalidPassword(value.newPassword, res)) return;
    if (value.currentPassword === value.newPassword) return res.status(400).json({ message: "新密码不能与当前密码相同" });
    const key = `password:${actor.id}:${clientIp(req)}`;
    if (await limited(key, 8, res)) return;
    await recordLoginFailure(key);
    const row = await db.prepare("SELECT password_hash FROM users WHERE id=?").get(actor.id);
    if (!row || !await verifyPassword(value.currentPassword, row.password_hash)) return res.status(400).json({ message: "当前密码不正确" });
    const newHash = await hashPassword(value.newPassword);
    const token = await db.transaction(async () => {
      const current = await db.prepare(`SELECT password_hash,status FROM users WHERE id=?${db.forUpdate}`).get(actor.id);
      if (current?.status !== "active" || current.password_hash !== row.password_hash) throw new AccountError(401, "账号状态已变化，请重新登录");
      await db.prepare("UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?").run(newHash, actor.id);
      await deleteUserSessions(actor.id);
      const token = await createSession(actor.id, req.headers["user-agent"], clientIp(req), value.remember);
      await audit(actor, "password_changed", "user", actor.id, undefined, clientIp(req)); return token;
    });
    await clearLoginFailures(key); res.json({ token });
  });
  router.get("/auth/sessions", requireSelf, async (req, res) => {
    const actor = principalOf(req) as Extract<Principal, {kind:"user"}>;
    const rows = await db.prepare(`SELECT id,created_at,last_seen_at,absolute_expires_at,user_agent,ip,
      CASE WHEN token_hash=? THEN 1 ELSE 0 END is_current FROM sessions WHERE user_id=? AND expires_at>? AND absolute_expires_at>? ORDER BY last_seen_at DESC`)
      .all(tokenHash(bearerToken(req)), actor.id, nowIso(), nowIso());
    res.json(rows.map(row => ({ id: row.id, createdAt: row.created_at, lastSeenAt: row.last_seen_at,
      expiresAt: row.absolute_expires_at, userAgent: row.user_agent, ip: row.ip, current: Boolean(row.is_current) })));
  });
  router.post("/auth/verify-password",requireSelf,async(req,res)=>{
    const actor=principalOf(req) as Extract<Principal,{kind:"user"}>;
    const value=z.object({password}).strict().parse(req.body),key=`verify:${actor.id}:${clientIp(req)}`;
    if(await limited(key,8,res))return;
    await recordLoginFailure(key);
    const row=await db.prepare("SELECT password_hash FROM users WHERE id=?").get(actor.id);
    if(!row||!await verifyPassword(value.password,row.password_hash))return res.status(400).json({message:"当前密码不正确"});
    await db.transaction(async()=>{
      const current=await db.prepare(`SELECT password_hash,status FROM users WHERE id=?${db.forUpdate}`).get(actor.id);
      if(current?.status!=="active"||current.password_hash!==row.password_hash)throw new AccountError(401,"账号状态已变化，请重新登录");
      const updated=await db.prepare("UPDATE sessions SET reauthenticated_at=? WHERE token_hash=? AND user_id=?").run(nowIso(),tokenHash(bearerToken(req)),actor.id);
      if(!updated.changes)throw new AccountError(401,"登录状态已失效");
      await audit(actor,"identity_verified","user",actor.id,undefined,clientIp(req));
    });
    await clearLoginFailures(key);res.json({ok:true});
  });
  router.delete("/auth/sessions/others", requireSelf, async (req, res) => {
    const actor = principalOf(req) as Extract<Principal, {kind:"user"}>;
    await db.transaction(async () => {
      await db.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash!=?").run(actor.id, tokenHash(bearerToken(req)));
      await audit(actor, "sessions_revoked", "user", actor.id, "other_sessions", clientIp(req));
    }); res.status(204).end();
  });
  router.delete("/auth/sessions/:id", requireSelf, async (req, res) => {
    const actor = principalOf(req) as Extract<Principal, {kind:"user"}>;
    const removed = await db.prepare("DELETE FROM sessions WHERE id=? AND user_id=?").run(req.params.id, actor.id);
    if (!removed.changes) return res.status(404).json({ message: "登录设备不存在或已经退出" });
    await audit(actor, "session_revoked", "session", String(req.params.id), undefined, clientIp(req)); res.status(204).end();
  });
  router.get("/users", requireAdmin, async (req, res) => {
    const q = pagination.extend({ search: z.string().trim().max(32).default(""), role: z.enum(["all", "admin", "user"]).default("all"), status: z.enum(["all", "active", "disabled"]).default("all") }).parse(req.query);
    const filters: string[] = [], args: unknown[] = [];
    if (q.search) { filters.push("INSTR(lower(username),lower(?))>0"); args.push(q.search); }
    if (q.role !== "all") { filters.push("role=?"); args.push(q.role); }
    if (q.status !== "all") { filters.push("status=?"); args.push(q.status); }
    const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
    const total = Number((await db.prepare(`SELECT COUNT(*) count FROM users${where}`).get(...args))!.count);
    const rows = await db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM tunnels t WHERE t.owner_id=u.id) tunnel_count FROM users u${where} ORDER BY u.created_at DESC,u.id DESC LIMIT ? OFFSET ?`).all(...args, q.pageSize, (q.page - 1) * q.pageSize);
    const summary = await db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) active,SUM(CASE WHEN role='admin' AND status='active' THEN 1 ELSE 0 END) admins FROM users").get();
    res.json({ items: await Promise.all(rows.map(async row => ({ ...publicUser(row), tunnelCount: Number(row.tunnel_count), effectiveQuota: row.role === "admin" ? null : await effectiveTunnelQuota(row.id) }))), total, page: q.page, pageSize: q.pageSize,
      summary: { total: Number(summary!.total), active: Number(summary!.active || 0), admins: Number(summary!.admins || 0) } });
  });
  router.post("/users", requireAdmin, async (req, res) => {
    const value = z.object({ username, password, role: z.enum(["admin", "user"]).default("user"), quotaTunnels: z.number().int().min(0).max(10000).nullable().optional() }).strict().parse(req.body);
    if (invalidPassword(value.password, res)) return;
    const actor = principalOf(req);
    const id = await db.transaction(async () => {
      await lockAccounts();
      const id = await createUser({ ...value, mustChangePassword: true, createdBy: actor?.kind === "user" ? actor.id : null });
      // 创建时直接指定配额同样属于「管理员授予」，必须写入流水（delta 为全部新增来源）。
      if (value.quotaTunnels !== undefined && value.quotaTunnels !== null && value.quotaTunnels > 0 && value.role !== "admin")
        await recordBilling({ userId: id, type: "admin_adjust", delta: value.quotaTunnels, description: `管理员创建账号并授予配额：${value.quotaTunnels} 条`, operator: actor?.kind === "user" ? { id: actor.id, name: actor.username } : null });
      await audit(actor, "user_created", "user", id, `username=${value.username};role=${value.role}`, clientIp(req)); return id;
    });
    res.status(201).json(publicUser((await db.prepare("SELECT * FROM users WHERE id=?").get(id))!));
  });
  router.patch("/users/:id", requireAdmin, async (req, res) => {
    const value = z.object({ role: z.enum(["admin", "user"]).optional(), status: z.enum(["active", "disabled"]).optional(), quotaTunnels: z.number().int().min(0).max(10000).nullable().optional() }).strict()
      .refine(input => Object.keys(input).length > 0, "请选择要更新的账号设置").parse(req.body);
    const actor = principalOf(req), id = String(req.params.id);
    const disabled = await db.transaction(async () => {
      await lockAccounts();
      const target = await db.prepare(`SELECT * FROM users WHERE id=?${db.forUpdate}`).get(id);
      if (!target) throw new AccountError(404, "账号不存在");
      const self = actor?.kind === "user" && actor.id === id;
      if (self && (value.role === "user" || value.status === "disabled")) throw new AccountError(400, "不能降低或停用自己的权限");
      await activeAdministratorRequired(target, value.role === "user" || value.status === "disabled");
      const role = value.role ?? target.role, status = value.status ?? target.status;
      // 配额变更前先记录当前有效配额，更新后写流水（管理员调整必须可追溯）。
      const quotaChanged = value.quotaTunnels !== undefined && Number(value.quotaTunnels) !== Number(target.quota_tunnels ?? 0);
      const quotaBefore = quotaChanged ? await effectiveTunnelQuota(id) : 0;
      await db.prepare("UPDATE users SET role=?,status=?,quota_tunnels=? WHERE id=?").run(role, status, value.quotaTunnels === undefined ? target.quota_tunnels : value.quotaTunnels, id);
      if (quotaChanged) {
        const quotaAfter = await effectiveTunnelQuota(id);
        if (quotaAfter !== quotaBefore)
          await recordBilling({
            userId: id, type: "admin_adjust", delta: quotaAfter - quotaBefore,
            description: `管理员调整直接配额：${target.quota_tunnels === null ? "未设置" : target.quota_tunnels} → ${value.quotaTunnels}`,
            operator: actor?.kind === "user" ? { id: actor.id, name: actor.username } : null,
            ref: randomUUID()
          });
      }
      if (role !== target.role || status !== target.status) await deleteUserSessions(id);
      if (status === "disabled") await db.prepare("UPDATE tunnels SET status='stopped',auto_start=0,agent_token=NULL WHERE owner_id=?").run(id);
      await audit(actor, "user_updated", "user", id, JSON.stringify(value), clientIp(req));
      return status === "disabled";
    });
    if (disabled) await options.onUserDisabled(id);
    res.json(publicUser((await db.prepare("SELECT * FROM users WHERE id=?").get(id))!));
  });
  router.post("/users/:id/password", requireAdmin, async (req, res) => {
    const value = z.object({ newPassword: password }).strict().parse(req.body), actor = principalOf(req), id = String(req.params.id);
    if (actor?.kind === "user" && actor.id === id) return res.status(400).json({ message: "请在账号安全页验证当前密码后修改自己的密码" });
    if (invalidPassword(value.newPassword, res)) return;
    const hash = await hashPassword(value.newPassword);
    await db.transaction(async () => {
      const target = await db.prepare(`SELECT id FROM users WHERE id=?${db.forUpdate}`).get(id);
      if (!target) throw new AccountError(404, "账号不存在");
      await db.prepare("UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?").run(hash, id);
      await deleteUserSessions(id); await audit(actor, "password_reset", "user", id, undefined, clientIp(req));
    }); res.json({ ok: true });
  });
  router.delete("/users/:id/sessions", requireAdmin, async (req, res) => {
    const actor = principalOf(req), id = String(req.params.id);
    if (actor?.kind === "user" && actor.id === id) return res.status(400).json({ message: "请在账号安全页管理自己的登录设备" });
    await db.transaction(async () => {
      const target = await db.prepare(`SELECT id FROM users WHERE id=?${db.forUpdate}`).get(id);
      if (!target) throw new AccountError(404, "账号不存在");
      await deleteUserSessions(id); await audit(actor, "sessions_revoked", "user", id, "all_sessions", clientIp(req));
    }); res.status(204).end();
  });
  router.delete("/users/:id", requireAdmin, async (req, res) => {
    const actor = principalOf(req), id = String(req.params.id);
    if (actor?.kind === "user" && actor.id === id) return res.status(400).json({ message: "不能删除自己的账号" });
    await db.transaction(async () => {
      await lockAccounts();
      const target = await db.prepare(`SELECT * FROM users WHERE id=?${db.forUpdate}`).get(id);
      if (!target) throw new AccountError(404, "账号不存在");
      await activeAdministratorRequired(target, true);
      const count = Number((await db.prepare("SELECT COUNT(*) count FROM tunnels WHERE owner_id=?").get(id))!.count);
      if (count) throw new AccountError(409, `该账号仍有 ${count} 条隧道，请先删除隧道，或改为停用账号`);
      await db.prepare("DELETE FROM users WHERE id=?").run(id);
      await audit(actor, "user_deleted", "user", id, `username=${target.username}`, clientIp(req));
    }); res.status(204).end();
  });
  router.get("/audit", requireAdmin, async (req, res) => {
    const q = pagination.extend({ search: z.string().trim().max(100).default(""), action: z.string().regex(/^[a-z_]*$/).max(64).default("") }).parse(req.query);
    const filters: string[] = [], args: unknown[] = [];
    if (q.search) { filters.push("(INSTR(lower(actor_name),lower(?))>0 OR INSTR(lower(target_id),lower(?))>0)"); args.push(q.search, q.search); }
    if (q.action) { filters.push("action=?"); args.push(q.action); }
    const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
    const total = Number((await db.prepare(`SELECT COUNT(*) count FROM audit_logs${where}`).get(...args))!.count);
    const items = await db.prepare(`SELECT * FROM audit_logs${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...args, q.pageSize, (q.page - 1) * q.pageSize);
    res.json({ items, total, page: q.page, pageSize: q.pageSize });
  });
  router.use((error: unknown, _req: Request, res: Response, next: (error: unknown) => void) => {
    if (error instanceof AccountError) return res.status(error.status).json({ message: error.message });
    if (error instanceof VerificationError) return res.status(error.status).json({ message: error.message, code: error.code });
    next(error);
  });
  return router;
}
