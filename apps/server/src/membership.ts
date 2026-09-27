import { Router, type Request, type Response, type NextFunction } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { db, effectiveTunnelQuota } from "./db.js";
import { audit, lockAccounts, nowIso, principalOf, requireAdmin, requireSelf } from "./auth.js";
import { VerificationError } from "./verification.js";
import { grantPlanToUser, recordBilling } from "./billing.js";

const quota = z.number().int().min(0).max(10000);
const planSchema = z.object({ name: z.string().trim().min(1).max(64), description: z.string().trim().max(500).default(""), priceCents: z.number().int().min(0).max(100000000), durationDays: z.number().int().min(1).max(3650), tunnelQuota: quota, enabled: z.boolean().default(true) }).strict();
const campaignSchema = z.object({ name: z.string().trim().min(1).max(64), inviterBonus: quota, inviteeBonus: quota, maxRewards: z.number().int().min(1).max(10000), startsAt: z.string().datetime(), endsAt: z.string().datetime(), enabled: z.boolean().default(true) }).strict().refine(value => Date.parse(value.endsAt) > Date.parse(value.startsAt), "活动结束时间必须晚于开始时间");
const publicPlan = (row: Record<string, any>) => ({ id: row.id, name: row.name, description: row.description, priceCents: Number(row.price_cents), durationDays: Number(row.duration_days), tunnelQuota: Number(row.tunnel_quota), enabled: Boolean(row.enabled) });
const publicCampaign = (row: Record<string, any>) => ({ id: row.id, name: row.name, inviterBonus: Number(row.inviter_bonus), inviteeBonus: Number(row.invitee_bonus), maxRewards: Number(row.max_rewards), startsAt: row.starts_at, endsAt: row.ends_at, enabled: Boolean(row.enabled) });

// 在注册事务和账号锁内调用；奖励仅发给完成邮箱验证的新账号。
export async function applyReferral(userId: string, inviteCode?: string) {
  if (!inviteCode) return;
  const inviter = await db.prepare("SELECT id,email,status FROM users WHERE invite_code=?").get(inviteCode);
  if (!inviter || inviter.status !== "active" || !inviter.email || inviter.id === userId) throw new VerificationError("邀请码无效，邀请人需先绑定邮箱");
  await db.prepare("UPDATE users SET invited_by=? WHERE id=? AND invited_by IS NULL").run(inviter.id, userId);
  const now = nowIso();
  const campaign = await db.prepare("SELECT * FROM referral_campaigns WHERE enabled=1 AND starts_at<=? AND ends_at>? ORDER BY starts_at DESC LIMIT 1").get(now, now);
  if (!campaign) return;
  const rewarded = Number((await db.prepare("SELECT COUNT(*) count FROM referral_rewards WHERE inviter_id=? AND campaign_id=?").get(inviter.id, campaign.id))!.count);
  if (rewarded >= Number(campaign.max_rewards)) return;
  await db.prepare("INSERT INTO referral_rewards(invitee_id,inviter_id,campaign_id,inviter_bonus,invitee_bonus,created_at) VALUES(?,?,?,?,?,?)").run(userId, inviter.id, campaign.id, campaign.inviter_bonus, campaign.invitee_bonus, now);
  const invitee = await db.prepare("SELECT username FROM users WHERE id=?").get(userId);
  for (const [id, bonus, description] of [
    [inviter.id, campaign.inviter_bonus, `邀请 ${invitee?.username || "新用户"} 加入，获得「${campaign.name}」活动奖励`],
    [userId, campaign.invitee_bonus, `受邀加入，获得「${campaign.name}」活动奖励`]
  ] as const) {
    const row = await db.prepare("SELECT bonus_tunnels FROM users WHERE id=?").get(id);
    await db.prepare("UPDATE users SET bonus_tunnels=? WHERE id=?").run(Math.min(10000, Number(row!.bonus_tunnels || 0) + Number(bonus)), id);
    await recordBilling({ userId: id, type: "invite_reward", delta: Number(bonus), description, ref: `${campaign.id}:${userId}` });
  }
}

export function membershipRouter(clientIp: (req: Request) => string) {
  const router = Router();
  router.get("/membership/plans", async (req, res) => res.json((await db.prepare(`SELECT * FROM membership_plans${principalOf(req)?.role === "admin" ? "" : " WHERE enabled=1"} ORDER BY price_cents,id`).all()).map(publicPlan)));
  router.post("/membership/plans", requireAdmin, async (req, res) => {
    const value = planSchema.parse(req.body), id = randomUUID();
    await db.transaction(async () => {
      await lockAccounts();
      await db.prepare("INSERT INTO membership_plans(id,name,description,price_cents,duration_days,tunnel_quota,enabled,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, value.name, value.description, value.priceCents, value.durationDays, value.tunnelQuota, value.enabled ? 1 : 0, nowIso());
      await audit(principalOf(req), "plan_created", "plan", id, undefined, clientIp(req));
    });
    res.status(201).json({ id, ...value });
  });
  router.put("/membership/plans/:id", requireAdmin, async (req, res) => {
    const value = planSchema.parse(req.body), id = String(req.params.id);
    await db.transaction(async () => {
      await lockAccounts();
      if (!await db.prepare("SELECT id FROM membership_plans WHERE id=?").get(id)) throw new VerificationError("套餐不存在", 404);
      await db.prepare("UPDATE membership_plans SET name=?,description=?,price_cents=?,duration_days=?,tunnel_quota=?,enabled=? WHERE id=?").run(value.name, value.description, value.priceCents, value.durationDays, value.tunnelQuota, value.enabled ? 1 : 0, id);
      await audit(principalOf(req), "plan_updated", "plan", id, undefined, clientIp(req));
    }); res.json({ id, ...value });
  });
  router.get("/membership/campaigns", async (req, res) => {
    const admin = principalOf(req)?.role === "admin", now = nowIso();
    const rows = await db.prepare(`SELECT * FROM referral_campaigns${admin ? "" : " WHERE enabled=1 AND starts_at<=? AND ends_at>?"} ORDER BY starts_at DESC`).all(...(admin ? [] : [now, now]));
    res.json(rows.map(publicCampaign));
  });
  async function saveCampaign(req: Request, res: Response, creating: boolean) {
    const value = campaignSchema.parse(req.body), id = creating ? randomUUID() : String(req.params.id);
    await db.transaction(async () => {
      await lockAccounts();
      if (!creating && !await db.prepare("SELECT id FROM referral_campaigns WHERE id=?").get(id)) throw new VerificationError("活动不存在", 404);
      if (value.enabled && await db.prepare("SELECT id FROM referral_campaigns WHERE enabled=1 AND id!=? AND starts_at<? AND ends_at>?").get(id, value.endsAt, value.startsAt)) throw new VerificationError("该时段已有邀请活动，请先停用或调整时间", 409);
      if (creating) await db.prepare("INSERT INTO referral_campaigns(id,name,inviter_bonus,invitee_bonus,max_rewards,starts_at,ends_at,enabled,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, value.name, value.inviterBonus, value.inviteeBonus, value.maxRewards, value.startsAt, value.endsAt, value.enabled ? 1 : 0, nowIso());
      else await db.prepare("UPDATE referral_campaigns SET name=?,inviter_bonus=?,invitee_bonus=?,max_rewards=?,starts_at=?,ends_at=?,enabled=? WHERE id=?").run(value.name, value.inviterBonus, value.inviteeBonus, value.maxRewards, value.startsAt, value.endsAt, value.enabled ? 1 : 0, id);
      await audit(principalOf(req), creating ? "campaign_created" : "campaign_updated", "campaign", id, undefined, clientIp(req));
    }); res.status(creating ? 201 : 200).json({ id, ...value });
  }
  router.post("/membership/campaigns", requireAdmin, (req, res) => saveCampaign(req, res, true));
  router.put("/membership/campaigns/:id", requireAdmin, (req, res) => saveCampaign(req, res, false));
  router.get("/membership/me", requireSelf, async (req, res) => {
    const actor = principalOf(req)! as { id: string };
    const user = await db.transaction(async () => {
      await lockAccounts();
      const row = (await db.prepare("SELECT * FROM users WHERE id=?").get(actor.id))!;
      if (!row.invite_code) { row.invite_code = randomBytes(8).toString("hex"); await db.prepare("UPDATE users SET invite_code=? WHERE id=?").run(row.invite_code, actor.id); }
      return row;
    });
    const plan = user.membership_plan_id ? await db.prepare("SELECT name FROM membership_plans WHERE id=?").get(user.membership_plan_id) : null;
    const invited = Number((await db.prepare("SELECT COUNT(*) count FROM users WHERE invited_by=?").get(actor.id))!.count);
    const rewards = await db.prepare("SELECT COUNT(*) count,COALESCE(SUM(inviter_bonus),0) bonus FROM referral_rewards WHERE inviter_id=?").get(actor.id);
    res.json({ email: user.email, planName: plan?.name || null, membershipUntil: user.membership_until, membershipActive: Boolean(user.membership_until && Date.parse(user.membership_until) > Date.now()), effectiveQuota: user.role === "admin" ? null : await effectiveTunnelQuota(actor.id), bonusTunnels: Number(user.bonus_tunnels || 0), inviteCode: user.invite_code, invitedCount: invited, rewardedCount: Number(rewards!.count) });
  });
  router.post("/users/:id/membership", requireAdmin, async (req, res) => {
    // planId 不能限定 UUID：预置套餐使用 plan-free/plan-enterprise 等固定可读 ID，
    // 严格的 uuid 校验会让所有预置套餐都无法开通。存在性与启用状态由下方查询兜底。
    const value = z.object({ planId: z.string().trim().min(1).max(64), requestId: z.string().uuid() }).strict().parse(req.body), id = String(req.params.id);
    const expiresAt = await db.transaction(async () => {
      await lockAccounts();
      const previous = await db.prepare("SELECT * FROM membership_grants WHERE request_id=?").get(value.requestId);
      if (previous) {
        if (previous.user_id !== id || previous.plan_id !== value.planId) throw new VerificationError("重复请求与原开通记录不一致", 409);
        return previous.expires_at;
      }
      const user = await db.prepare("SELECT * FROM users WHERE id=?").get(id), plan = await db.prepare("SELECT * FROM membership_plans WHERE id=? AND enabled=1").get(value.planId);
      if (!user || user.status !== "active" || !plan) throw new VerificationError("账号不可用或套餐已停用", 400);
      // 与支付宝购买共用同一开通实现：顺延有效期 + 写账单流水（plan_grant）。
      const operator = principalOf(req)!;
      const granted = await grantPlanToUser(id, plan, {
        type: "plan_grant",
        description: `管理员开通套餐：${plan.name}（${plan.duration_days} 天）`,
        operator: operator.kind === "user" ? { id: operator.id, name: operator.username } : null,
        ref: value.requestId
      });
      const until = granted.membershipUntil;
      await db.prepare("INSERT INTO membership_grants(request_id,user_id,plan_id,expires_at,created_at) VALUES(?,?,?,?,?)").run(value.requestId, id, plan.id, until, nowIso());
      await audit(principalOf(req), "membership_granted", "user", id, `plan=${plan.id};until=${until}`, clientIp(req));
      return until;
    }); res.json({ expiresAt });
  });
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => error instanceof VerificationError ? res.status(error.status).json({ message: error.message, code: error.code }) : next(error));
  return router;
}
