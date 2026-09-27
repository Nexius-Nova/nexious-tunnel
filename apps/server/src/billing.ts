import express, { Router, type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, effectiveTunnelQuota } from "./db.js";
import { audit, lockAccounts, nowIso, principalOf, requireSelf, type Principal } from "./auth.js";
import { VerificationError } from "./verification.js";
import { alipayConfig, alipayPrecreate, alipayQuery, verifyAlipayNotify } from "./alipay.js";

// 账单流水：任何让用户有效配额变化的事件都记一条（购买/管理员开通/到期/邀请/管理员调整）。
// delta 为有效配额的变化量，quota_after 为变化后的有效配额；ref 用于幂等去重。
export type BillingType = "plan_purchase" | "plan_grant" | "plan_expired" | "invite_reward" | "admin_adjust";

export async function recordBilling(entry: {
  userId: string;
  type: BillingType;
  delta: number;
  description: string;
  operator?: { id?: string; name?: string } | null;
  ref?: string | null;
}) {
  // 与配额 UPDATE 在同一事务内调用时，这里读到的是事务内的最新值。
  const quotaAfter = await effectiveTunnelQuota(entry.userId);
  await db.prepare("INSERT INTO billing_records(id,user_id,type,delta,quota_after,description,operator_id,operator_name,ref,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), entry.userId, entry.type, Math.round(entry.delta), quotaAfter,
      entry.description.slice(0, 255), entry.operator?.id || null, entry.operator?.name || null,
      entry.ref || null, nowIso());
}

// 订单有效期：当面付二维码默认 2 小时内有效，超时未支付按过期处理。
const ORDER_TTL_MS = 2 * 3600_000;
const pagination = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(5).max(100).default(10) });
const publicRecord = (row: Record<string, any>) => ({
  id: row.id, userId: row.user_id, username: row.username || null, type: row.type,
  delta: Number(row.delta), quotaAfter: Number(row.quota_after), description: row.description,
  operatorName: row.operator_name || null, ref: row.ref || null, createdAt: row.created_at
});
const publicOrder = (row: Record<string, any>) => ({
  id: row.id, planId: row.plan_id, amountCents: Number(row.amount_cents),
  status: row.status as "created" | "paid" | "expired", qrCode: row.qr_code || null,
  createdAt: row.created_at, paidAt: row.paid_at || null
});

// 套餐开通共用逻辑（管理员开通与用户购买一致）：在现有有效期上顺延套餐天数。
// 必须在调用方事务内执行；返回本次变更的配额增量。
export async function grantPlanToUser(userId: string, plan: Record<string, any>, options: { type: BillingType; description: string; operator?: { id?: string; name?: string } | null; ref?: string | null }) {
  const user = await db.prepare(`SELECT * FROM users WHERE id=?${db.forUpdate}`).get(userId);
  if (!user || user.status !== "active") throw new VerificationError("账号不可用", 400);
  const before = await effectiveTunnelQuota(userId);
  const until = new Date(Math.max(Date.now(), Date.parse(user.membership_until || "") || 0) + Number(plan.duration_days) * 86400000).toISOString();
  await db.prepare("UPDATE users SET membership_plan_id=?,membership_until=?,membership_quota=? WHERE id=?")
    .run(plan.id, until, plan.tunnel_quota, userId);
  const after = await effectiveTunnelQuota(userId);
  // 购买/开通即使配额无变化（如已有更高来源）也要留痕：这是付费/授权行为本身。
  await recordBilling({ userId, type: options.type, delta: after - before, description: options.description, operator: options.operator, ref: options.ref });
  return { membershipUntil: until, delta: after - before };
}

// 订单支付完成的唯一入口：先原子地把订单置为 paid（FOR UPDATE 串行化），
// 再开通套餐，保证「查单回调 + 前端轮询」并发触发也只发放一次。
async function fulfillOrder(orderId: string, tradeNo?: string) {
  return db.transaction(async () => {
    await lockAccounts();
    const order = await db.prepare(`SELECT * FROM payment_orders WHERE id=?${db.forUpdate}`).get(orderId);
    if (!order) throw new VerificationError("订单不存在", 404);
    if (order.status === "paid") return { order: publicOrder(order), alreadyFulfilled: true };
    const plan = await db.prepare("SELECT * FROM membership_plans WHERE id=?").get(order.plan_id);
    if (!plan) throw new VerificationError("套餐不存在或已停用", 400);
    await db.prepare("UPDATE payment_orders SET status='paid',trade_no=?,paid_at=? WHERE id=?").run(tradeNo || null, nowIso(), orderId);
    const result = await grantPlanToUser(order.user_id, plan, {
      type: "plan_purchase",
      description: `购买套餐：${plan.name}（${plan.duration_days} 天）`,
      ref: orderId
    });
    const buyer = await db.prepare("SELECT username,role FROM users WHERE id=?").get(order.user_id) as { username: string; role: string } | undefined;
    await audit({ kind: "user", id: order.user_id, username: buyer?.username || order.user_id, role: (buyer?.role as "user" | "admin") || "user", mustChangePassword: false },
      "membership_purchased", "user", order.user_id, `plan=${order.plan_id};order=${orderId}`, undefined);
    const refreshed = await db.prepare("SELECT * FROM payment_orders WHERE id=?").get(orderId) as Record<string, any>;
    return { order: publicOrder(refreshed), alreadyFulfilled: false, ...result };
  });
}

// 套餐到期流水：到期是读时判断，没有离散事件，由定时任务补偿记录。
// ref=membership_until 保证同一到期时间只记一次；重复执行幂等。
export async function sweepMembershipExpiry() {
  const now = Date.now();
  const rows = await db.prepare("SELECT id,membership_until,membership_quota FROM users WHERE membership_until IS NOT NULL AND membership_quota IS NOT NULL AND membership_quota>0").all();
  for (const row of rows as Array<Record<string, any>>) {
    const until = String(row.membership_until);
    if (!until || Date.parse(until) > now) continue;
    try {
      await db.transaction(async () => {
        await lockAccounts();
        const existing = await db.prepare("SELECT id FROM billing_records WHERE user_id=? AND type='plan_expired' AND ref=?").get(row.id, until);
        if (existing) return;
        const user = await db.prepare("SELECT * FROM users WHERE id=?").get(row.id);
        if (!user || !user.membership_until || Date.parse(user.membership_until) > Date.now()) return;
        const plan = user.membership_plan_id ? await db.prepare("SELECT name FROM membership_plans WHERE id=?").get(user.membership_plan_id) : null;
        await recordBilling({
          userId: row.id, type: "plan_expired", delta: -Number(row.membership_quota || 0),
          description: `会员套餐到期${plan?.name ? `：${plan.name}` : ""}，套餐配额失效`, ref: until
        });
      });
    } catch (error) {
      console.warn("[billing] 记录套餐到期流水失败：", error instanceof Error ? error.message : error);
    }
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
export function startBillingSweep() {
  if (sweepTimer) return;
  void sweepMembershipExpiry();
  sweepTimer = setInterval(() => { void sweepMembershipExpiry(); }, 3600_000);
  sweepTimer.unref?.();
}

export function billingRouter(clientIp: (req: Request) => string) {
  const router = Router();

  // 流水查询：普通用户固定只看自己；管理员不传 userId 时看全部，传了看指定用户。
  // 服务身份（节点同步/桌面自举用的机器凭据）等价管理员，可看全部。
  router.get("/billing", async (req, res) => {
    const principal = principalOf(req);
    if (principal?.kind !== "user" && principal?.kind !== "service") return res.status(403).json({ message: "请使用个人账号登录" });
    const q = pagination.extend({ userId: z.string().trim().max(64).optional() }).parse(req.query);
    const admin = principal.role === "admin";
    const seeAll = admin && (!q.userId || principal.kind === "service");
    const filters: string[] = [], args: unknown[] = [];
    if (!seeAll) { filters.push("b.user_id=?"); args.push(admin && q.userId ? q.userId : principal.kind === "user" ? principal.id : ""); }
    const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
    const total = Number((await db.prepare(`SELECT COUNT(*) count FROM billing_records b${where}`).get(...args))!.count);
    const rows = await db.prepare(`SELECT b.*,u.username FROM billing_records b LEFT JOIN users u ON u.id=b.user_id${where} ORDER BY b.created_at DESC LIMIT ? OFFSET ?`)
      .all(...args, q.pageSize, (q.page - 1) * q.pageSize);
    res.json({ items: rows.map(publicRecord), total, page: q.page, pageSize: q.pageSize });
  });

  // 下单：付费套餐走当面付预下单返回二维码；免费套餐直接开通（requestId 幂等）。
  router.post("/billing/orders", requireSelf, async (req, res) => {
    const value = z.object({ planId: z.string().trim().min(1).max(64), requestId: z.string().uuid() }).strict().parse(req.body);
    const actor = principalOf(req)! as Extract<Principal, { kind: "user" }>;
    if (await db.prepare("SELECT id FROM payment_orders WHERE request_id=?").get(value.requestId)) {
      const existing = await db.prepare("SELECT * FROM payment_orders WHERE request_id=?").get(value.requestId);
      return res.status(200).json({ ...publicOrder(existing!), planName: (await db.prepare("SELECT name FROM membership_plans WHERE id=?").get(existing!.plan_id) as { name?: string } | undefined)?.name ?? null });
    }
    const plan = await db.prepare("SELECT * FROM membership_plans WHERE id=? AND enabled=1").get(value.planId);
    if (!plan) throw new VerificationError("套餐不存在或已停用", 400);
    const user = await db.prepare("SELECT status FROM users WHERE id=?").get(actor.id);
    if (!user || user.status !== "active") throw new VerificationError("账号不可用", 400);
    const config = alipayConfig();
    const orderId = `pay-${randomUUID().replaceAll("-", "")}`;
    if (Number(plan.price_cents) <= 0) {
      const result = await db.transaction(async () => {
        await lockAccounts();
        // 免费套餐不可叠加：已有生效中的套餐（免费或付费）时不能再领，
        // 防止反复开通无限顺延配额，也避免把付费套餐覆盖降级；到期后可再次开通。
        const current = await db.prepare("SELECT membership_until FROM users WHERE id=?").get(actor.id) as { membership_until: string | null } | undefined;
        if (current?.membership_until && Date.parse(current.membership_until) > Date.now())
          throw new VerificationError("当前已有生效中的套餐，免费套餐需在到期后才能再次开通", 409);
        await db.prepare("INSERT INTO payment_orders(id,user_id,plan_id,amount_cents,status,request_id,created_at,paid_at) VALUES(?,?,?,?,'paid',?,?,?)")
          .run(orderId, actor.id, plan.id, 0, value.requestId, nowIso(), nowIso());
        return grantPlanToUser(actor.id, plan, { type: "plan_purchase", description: `开通免费套餐：${plan.name}（${plan.duration_days} 天）`, ref: orderId });
      });
      await audit(actor, "membership_purchased", "user", actor.id, `plan=${plan.id};order=${orderId}`, clientIp(req));
      return res.status(201).json({ orderId, status: "paid", amountCents: 0, qrCode: null, membershipUntil: result.membershipUntil });
    }
    if (!config.ready) return res.status(503).json({ message: "支付渠道未配置，请联系管理员" });
    // 支付宝业务错误（如 ACCESS_FORBIDDEN 未开通当面付）透传给前端，避免笼统的 500。
    let qrCode: string;
    try {
      qrCode = await alipayPrecreate({
        outTradeNo: orderId, amountCents: Number(plan.price_cents),
        subject: `Nexious Tunnel ${plan.name}`, notifyUrl: config.notifyUrl || undefined
      });
    } catch (error) {
      throw new VerificationError(error instanceof Error ? error.message : "支付宝下单失败", 502);
    }
    await db.prepare("INSERT INTO payment_orders(id,user_id,plan_id,amount_cents,status,qr_code,request_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(orderId, actor.id, plan.id, Number(plan.price_cents), "created", qrCode, value.requestId, nowIso());
    res.status(201).json({ orderId, status: "created", qrCode, amountCents: Number(plan.price_cents) });
  });

  // 订单状态：created 时主动查单对账（回调可能丢失），查到已支付则补单发放。
  router.get("/billing/orders/:id", requireSelf, async (req, res) => {
    const actor = principalOf(req)! as Extract<Principal, { kind: "user" }>;
    const order = await db.prepare("SELECT * FROM payment_orders WHERE id=? AND user_id=?").get(String(req.params.id), actor.id);
    if (!order) throw new VerificationError("订单不存在", 404);
    let current = publicOrder(order);
    if (current.status === "created") {
      if (alipayConfig().ready) {
        try {
          const trade = await alipayQuery(order.id);
          if (trade.paid) {
            if (trade.totalAmountCents !== undefined && trade.totalAmountCents !== Number(order.amount_cents))
              throw new VerificationError("支付金额与订单不一致，请联系管理员处理", 409);
            current = publicOrder((await fulfillOrder(order.id, trade.tradeNo)).order);
          }
        } catch (error) {
          // 查单失败不阻塞状态返回：可能是网络抖动，下一轮轮询继续。
          console.warn("[billing] 查单失败：", error instanceof Error ? error.message : error);
        }
      }
      if (current.status === "created" && Date.now() - Date.parse(current.createdAt) > ORDER_TTL_MS) {
        await db.prepare("UPDATE payment_orders SET status='expired' WHERE id=? AND status='created'").run(order.id);
        current = { ...current, status: "expired" };
      }
    }
    res.json(current);
  });

  // 支付宝异步通知（公网回调，免鉴权）：金额与状态一律以主动查单结果为准，
  // 不信任通知报文本身；处理成功返回纯文本 success。通知为 form-urlencoded。
  router.post("/billing/alipay/notify", express.urlencoded({ extended: true }), async (req, res, next) => {
    const params = req.body as Record<string, string>;
    const config = alipayConfig();
    if (!config.ready || params.app_id !== config.appId) return res.send("fail");
    if (config.sellerId && params.seller_id && params.seller_id !== config.sellerId) return res.send("fail");
    if (config.alipayPublicKey && !verifyAlipayNotify(params, config.alipayPublicKey)) return res.send("fail");
    if (params.trade_status !== "TRADE_SUCCESS" && params.trade_status !== "TRADE_FINISHED") return res.send("success");
    const order = await db.prepare("SELECT * FROM payment_orders WHERE id=?").get(String(params.out_trade_no || ""));
    if (!order || order.status === "paid") return res.send("success");
    try {
      const trade = await alipayQuery(order.id);
      if (!trade.paid || (trade.totalAmountCents !== undefined && trade.totalAmountCents !== Number(order.amount_cents))) return res.send("fail");
      await fulfillOrder(order.id, trade.tradeNo);
      res.send("success");
    } catch (error) {
      console.warn("[billing] 支付通知处理失败：", error instanceof Error ? error.message : error);
      next(error);
    }
  });

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => error instanceof VerificationError ? res.status(error.status).json({ message: error.message, code: error.code }) : next(error));
  return router;
}
