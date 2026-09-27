import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { db, effectiveTunnelQuota, pruneOldData, tunnelRows } from "./db.js";
import { billingRouter, startBillingSweep } from "./billing.js";
import {
  audit,
  bearerToken,
  bootstrapAdmin,
  clearLoginFailures,
  createSession,
  createUser,
  deleteSession,
  deleteUserSessions,
  hashPassword,
  isAdmin,
  loginThrottle,
  passwordIssue,
  principalOf,
  pruneExpiredSessions,
  recordLoginFailure,
  requireAdmin,
  requireSelf,
  resolveSession,
  userCount,
  usernameIssue,
  verifyPassword,
  wastePasswordTime,
  type Principal,
  type Role
} from "./auth.js";
import { accountsRouter } from "./accounts.js";
import { deployNode, inspectNode, resetNode } from "./nodeDeployment.js";
import { captchaSubject, consumeVerification, verificationRouter, VerificationError } from "./verification.js";
import { membershipRouter } from "./membership.js";
import { requestNodeController, uniqueNodeControllers, nodeControllerIdentity, type NodeController } from "./nodeController.js";
import { measureDownload, measureUpload, type SpeedSample } from "./speedtest.js";
import {
  hopByHopHeaders,
  normalizeLocalCookieDomain,
  normalizePermissionsPolicy,
  sanitizeForwardedRequestHeaders,
  sanitizeForwardedWebSocketHeaders
} from "./proxyHeaders.js";
import {
  directRelayForNode,
  certificateDomainAllowed,
  isStaticAssetPath,
  normalizeHost,
  originAllowed,
  resolveClientIp,
  safeForwardPath,
  staticAssetConditions,
  tunnelHostCandidates
} from "./util.js";

const app = express();
const httpServer = createServer(app);
const port = Number(process.env.PORT || 8787);
const isNodeController = process.env.NEXIOUS_NODE_CONTROLLER === "1";
app.set("trust proxy", "loopback");
const allowedOrigins = new Set(
  (
    process.env.NEXIOUS_ALLOWED_ORIGINS ||
    "tauri://localhost,https://nexious-ppt.xyz,http://localhost:1420"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
// 仅在确认部署在 Cloudflare/反代之后时开启（NEXIOUS_TRUST_PROXY_HEADERS=1），
// 否则直连客户端可以通过 cf-connecting-ip / x-real-ip 伪造访问日志来源。
const trustProxyHeaders = process.env.NEXIOUS_TRUST_PROXY_HEADERS === "1";
const clientIp = (req: express.Request) =>
  resolveClientIp(req.headers, req.ip, trustProxyHeaders);
// 公网隧道转发的请求/响应体在内存中整包缓冲，必须限制上限防止内存耗尽。
const maxBodyBytes = Number(process.env.NEXIOUS_MAX_BODY_MB || 25) * 1024 * 1024;
// 单条消息上限（默认 64MB）：中继两侧都在内存中整包缓冲，必须限制防止单条大帧打爆内存。
const maxWebSocketBytes = Number(process.env.NEXIOUS_MAX_WS_MB || 64) * 1024 * 1024;
// 同时在途的转发请求上限：每个请求都会缓冲请求体与响应体，缺少上限时并发即可耗尽内存。
const maxInflightRequests = Math.max(1, Number(process.env.NEXIOUS_MAX_INFLIGHT || 256));
// 单条隧道的在途上限：防止某条慢隧道的流量洪峰占满全局额度，饿死其他隧道。
const maxInflightPerTunnel = Math.max(1, Number(process.env.NEXIOUS_MAX_INFLIGHT_PER_TUNNEL || 32));
const bindHost = process.env.BIND_HOST || "127.0.0.1";
const adminToken = String(process.env.NEXIOUS_ADMIN_TOKEN || "").trim();
// 管理令牌缺失时必须 fail-closed：显式部署的服务（节点控制器/桌面端内置控制中心）都会带上
// NODE_ENV=production，因此只对"本机开发模式"放行匿名访问，避免本地预览被阻断。
const anonymousAdminAllowed = false;
if (!adminToken) {
  console.warn(
    anonymousAdminAllowed
      ? "[auth] 未配置 NEXIOUS_ADMIN_TOKEN：当前为本机开发模式，管理接口允许匿名访问，请勿用于生产环境。"
      : "[auth] 未配置 NEXIOUS_ADMIN_TOKEN：已按 fail-closed 策略拒绝全部管理接口访问，请设置该环境变量。"
  );
}
// 固定长度比较，避免按字节短路比较泄漏令牌前缀。
function authorizationMatches(value: unknown, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(String(value ?? ""));
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function applyPublicCors(req: express.Request, res: express.Response) {
  const origin = req.headers.origin;
  if (!origin) return;
  // 公网隧道允许任意来源的匿名跨域访问；不带 credentials，浏览器同源策略对
  // Cookie 类凭据的保护保持有效。
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader(
    "access-control-allow-methods",
    req.headers["access-control-request-method"] || "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS"
  );
  res.setHeader(
    "access-control-allow-headers",
    req.headers["access-control-request-headers"] || "content-type, authorization, x-requested-with"
  );
  res.setHeader("access-control-max-age", "86400");
}

app.use(
  cors({
    origin: (origin, callback) => callback(null, originAllowed(origin, allowedOrigins)),
    preflightContinue: true,
    optionsSuccessStatus: 204
  })
);
// 公网隧道域名可能包含 `/api/*` 路径，必须先按 Host 分流，避免被控制中心鉴权拦截。
// 此处位于 body parser 之前，以便 POST/PUT 请求可以原样转发。
app.use(async (req, res, next) => {
  const publicMatch = req.originalUrl.match(/^\/public\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (publicMatch) {
    applyPublicCors(req, res);
    if (req.method === "OPTIONS") return res.sendStatus(204);
    const tunnelId = decodeURIComponent(publicMatch[1]);
    const forwardedPath = safeForwardPath(`${publicMatch[2] || "/"}${publicMatch[3] || ""}`);
    if (!forwardedPath) return res.status(400).json({ message: "非法的转发路径" });
    return forwardPublicHttp(tunnelId, forwardedPath, req, res, next);
  }
  const tunnel = (await findTunnelByHost(req.headers));
  if (!tunnel) return next();
  applyPublicCors(req, res);
  if (req.method === "OPTIONS") return res.sendStatus(204);
  const forwardedPath = safeForwardPath(req.originalUrl);
  if (!forwardedPath) return res.status(400).json({ message: "非法的转发路径" });
  return forwardPublicHttp(tunnel.id, forwardedPath, req, res, next);
});
// CORS 已写入允许的控制中心响应头；对非公网隧道的预检请求统一结束响应。
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "2mb" }));
// 账号体系的引导管理员：库为空时自动创建（节点控制器是机器角色，跳过）。
(await bootstrapAdmin());
(await pruneExpiredSessions());
setInterval(pruneExpiredSessions, 6 * 3600 * 1000);
// 套餐到期是读时判断，没有离散事件：定时补偿写入「到期」账单流水。
startBillingSweep();

// 登录与注册自身不能要求凭据，否则无法首次进入系统。
// 支付宝异步通知来自支付宝服务器，无法携带用户会话，同样必须公开。
const PUBLIC_API_PATHS = new Set(["/auth/login", "/auth/register", "/auth/status", "/auth/email-code", "/auth/captcha", "/auth/captcha/verify", "/billing/alipay/notify"]);
// 服务凭据（NEXIOUS_ADMIN_TOKEN）代表机器身份：节点同步与本地桌面自举都依赖它，
// 因此它等价于管理员，且不受用户配额、数据作用域限制。
const servicePrincipal: Principal = { kind: "service", role: "admin", label: "service-token" };

async function authenticateRequest(req: express.Request): Promise<Principal | null> {
  const token = bearerToken(req);
  if (!token) return null;
  if (adminToken && authorizationMatches(req.headers.authorization, adminToken)) return servicePrincipal;
  return (await resolveSession(token));
}

app.use("/api", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.headers.origin && !originAllowed(req.headers.origin, allowedOrigins)) return res.status(403).json({ message: "此来源不允许访问控制中心" });
  if (req.path === "/health") return next();
  if (PUBLIC_API_PATHS.has(req.path) && !(req.path.startsWith("/auth/captcha") && req.body?.purpose === "node-reset")) return next();
  const principal = (await authenticateRequest(req));
  if (principal) {
    (req as express.Request & { principal?: Principal }).principal = principal;
    if (principal.kind === "user" && principal.mustChangePassword && !["/auth/me", "/auth/password", "/auth/logout"].includes(req.path))
      return res.status(403).json({ message: "请先修改临时密码", code: "PASSWORD_CHANGE_REQUIRED" });
    return next();
  }
  if (!adminToken) {
    // 未配置服务令牌：本机开发模式放行匿名访问；其余一律 fail-closed。
    if (anonymousAdminAllowed) {
      (req as express.Request & { principal?: Principal }).principal = servicePrincipal;
      return next();
    }
    if ((await userCount()) === 0) {
      return res.status(503).json({ message: "控制中心未配置管理令牌（NEXIOUS_ADMIN_TOKEN），已拒绝访问" });
    }
  }
  return res.status(401).json({ message: "控制中心认证失败" });
});
const agents = new Map<string, WebSocket>();
(await db.prepare("UPDATE nodes SET deploy_status='error',status='maintenance',last_error='主控已重启，部署进度已失效，请检查服务器状态' WHERE deploy_status='deploying'").run());
(await db.prepare("UPDATE nodes SET controller_url=replace(controller_url, ':8789/api', ':8788/api') WHERE controller_url LIKE '%:8789/api%'").run());
const pending = new Map<string, (payload: any) => void>();
// 在途转发请求计数，配合 maxInflightRequests 限制整包缓冲带来的内存峰值。
let inflightRequests = 0;
// 按隧道拆分的在途计数，配合 maxInflightPerTunnel 做租户级隔离。
const inflightByTunnel = new Map<string, number>();
(await db.prepare("UPDATE tunnels SET status='stopped' WHERE status='running'").run());

const subdomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "子域名只能包含小写字母、数字和连字符，且不能以连字符开头或结尾"
  );
const tunnelSchema = z
  .object({
    name: z.string().trim().min(2).max(32),
    protocol: z.enum(["http", "https"]),
    localHost: z.string().trim().min(1),
    localPort: z.number().int().min(1).max(65535),
    remotePort: z.number().int().min(1).max(65535),
    nodeId: z.string().min(1),
    domain: subdomainSchema.nullable().optional()
  })
  .superRefine((value, context) => {
    if (!value.domain) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["domain"],
        message: "HTTP/HTTPS 隧道必须设置访问子域名"
      });
    }
  });
const nodeSchema = z.object({
  name: z.string().trim().min(2).max(40),
  host: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(253)
    .regex(
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
      "请输入不带协议和路径的节点基础域名"
    )
});
const serverSchema = z.object({
  connection: z.string().trim().regex(/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/, "请输入 用户名@主机地址"),
  password: z.string().min(1, "请输入 SSH 密码"),
  port: z.number().int().min(1).max(65535).default(22),
  force: z.boolean().default(false)
});
const nodeSelect = `SELECT id,name,host,status,server_host,ssh_user,ssh_port,controller_url,
  controller_token,deploy_status,last_checked_at,last_error FROM nodes`;
type DeployJob={id:string;nodeId:string;serverKey:string;status:"running"|"success"|"error";logs:Array<{time:string;message:string}>;createdAt:number;result?:unknown;error?:string};
const deployJobs=new Map<string,DeployJob>();
// 部署任务仅用于前端轮询进度，长期运行时清理已结束的任务避免内存缓慢增长。
const MAX_FINISHED_DEPLOY_JOBS = 50;
function pruneDeployJobs() {
  const now = Date.now();
  for (const [id, job] of deployJobs) {
    if (job.status !== "running" && now - job.createdAt > 3_600_000) deployJobs.delete(id);
  }
  const finished = [...deployJobs.values()]
    .filter((job) => job.status !== "running")
    .sort((left, right) => left.createdAt - right.createdAt);
  while (finished.length > MAX_FINISHED_DEPLOY_JOBS) {
    const oldest = finished.shift();
    if (oldest) deployJobs.delete(oldest.id);
  }
}
const appendJobLog=(job:DeployJob,message:string)=>job.logs.push({time:new Date().toISOString(),message});
let lastNodeHealthRefresh=0;
async function refreshNodeHealth(){
  if(Date.now()-lastNodeHealthRefresh<10_000)return;
  lastNodeHealthRefresh=Date.now();
  const nodes=(await db.prepare("SELECT id,host,server_host,controller_url,controller_token,deploy_status FROM nodes").all()) as Array<NodeController & {id:string;deploy_status:string}>;
  await Promise.all(nodes.map(async node=>{
    if (node.deploy_status === "deploying") return;
    if(!node.controller_url||!node.controller_token||node.deploy_status!=="ready"){
      (await db.prepare("UPDATE nodes SET status='maintenance' WHERE id=?").run(node.id));return;
    }
    try{
      const response=await requestNodeController(node,"/api/health",{timeoutMs:4000});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const value=await response.json() as {ok?:boolean};if(!value.ok)throw new Error("健康检查未通过");
      (await db.prepare("UPDATE nodes SET status='online',last_checked_at=?,last_error=NULL WHERE id=?").run(new Date().toISOString(),node.id));
    }catch(error){
      (await db.prepare("UPDATE nodes SET status='maintenance',last_checked_at=?,last_error=? WHERE id=?").run(new Date().toISOString(),error instanceof Error?error.message:"节点不可达",node.id));
    }
  }));
}

async function domainIsOccupied(
  nodeId: string,
  domain: string | null | undefined,
  excludedId?: string
) {
  if (!domain) return false;
  const row = (await db
    .prepare(
      `SELECT id FROM tunnels WHERE node_id=? AND lower(domain)=? AND (? IS NULL OR id!=?)`
    )
    .get(nodeId, domain.toLowerCase(), excludedId || null, excludedId || null));
  return Boolean(row);
}

type TrafficPoint = { timestamp: string; inbound: number; outbound: number };
type AccessLogRow = {
  id: number;
  tunnel_id: string;
  timestamp: string;
  client_ip: string;
  method: string;
  path: string;
  status: number;
  duration: number;
  bytes: number;
};

function recordObservation(
  tunnelId: string,
  ip: string,
  method: string,
  path: string,
  status: number,
  duration: number,
  inbound: number,
  outbound: number
) {
  void (async () => {
  (await db.prepare(
    "INSERT INTO access_logs (tunnel_id,timestamp,client_ip,method,path,status,duration,bytes) VALUES (?,?,?,?,?,?,?,?)"
  ).run(tunnelId, new Date().toISOString(), ip, method, path, status, duration, inbound + outbound));
  if (inbound || outbound) {
    (await db.prepare(
      `INSERT INTO traffic (tunnel_id,timestamp,inbound,outbound) VALUES (?,?,?,?)`
    ).run(tunnelId, new Date().toISOString().slice(0, 13) + ":00:00.000Z", inbound, outbound));
  }

  })().catch(error => console.warn("[observation] 记录写入失败", error));
}

async function configuredNodeControllers() {
  if (isNodeController) return [];
  return uniqueNodeControllers((await db.prepare(
    "SELECT id,host,server_host,controller_url,controller_token FROM nodes WHERE controller_url IS NOT NULL AND controller_token IS NOT NULL AND deploy_status='ready'"
  ).all()) as Array<NodeController & { id: string }>);
}

async function fetchNodeJson<T>(
  node: NodeController,
  path: string
): Promise<T> {
  const response = await requestNodeController(node, path);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, version: "1.0.0", database: db.driver, time: new Date().toISOString() })
);

app.use("/api", verificationRouter(clientIp));
app.use("/api", accountsRouter({ clientIp, isNodeController, onUserDisabled: async (userId) => {
  const rows = (await tunnelRows()).filter(row => row.owner_id === userId);
  for (const row of rows) agents.get(row.id)?.close(1008, "account disabled");
  await Promise.all(rows.map(async row => (await syncTunnelToNode(row.id, "upsert"))));
} }));
app.use("/api", membershipRouter(clientIp));
app.use("/api", billingRouter(clientIp));
// Caddy 按需签发仅限节点自身域名及已同步的隧道域名。
app.get("/internal/tls/authorize", async (req, res) => {
  if (!isNodeController) return res.sendStatus(403);
  // 该路由不在 /api 鉴权中间件内，且节点降级时会把 BIND_HOST 改为 0.0.0.0，
  // 任意外部请求都能用 200/403 差异枚举已同步的隧道域名。这里限定本机来源。
  const remote = req.socket.remoteAddress || "";
  if (!/^(::1|::ffff:127\.|127\.)/.test(remote)) return res.sendStatus(403);
  const domains = (await db.prepare("SELECT t.domain,n.host FROM tunnels t JOIN nodes n ON t.node_id=n.id").all())
    .map((row) => `${row.domain}.${row.host}`);
  return res.sendStatus(certificateDomainAllowed(req.query.domain, process.env.NEXIOUS_PUBLIC_HOST, domains) ? 200 : 403);
});
app.get("/api/node-stats", async (req, res) => {
  // 隧道流量由节点承接并记录，主控本地通常没有这些行；节点详情必须从这里取数。
  // ids 用于按隧道范围统计：主控的个人账号只能看到自己隧道的流量，不能拿到整节点合计。
  const ids = String(req.query.ids || "").split(",").map((value) => value.trim())
    .filter((value) => /^[a-zA-Z0-9_-]{1,64}$/.test(value)).slice(0, 1000);
  const owner = scopeOf(req);
  // 个人账号必须叠加归属过滤，否则可传任意隧道 id 读取他人流量统计。
  // 无隧道时显式返回全零，避免退化成整节点合计。
  if (owner) {
    const owned = ids.length
      ? (await db.prepare(`SELECT id FROM tunnels WHERE owner_id=? AND id IN (${ids.map(() => "?").join(",")})`)
          .all(owner, ...ids) as Array<{ id: string }>).map((row) => String(row.id))
      : [];
    if (!owned.length) return res.json({ requests: 0, bytes: 0 });
    const row = (await db.prepare(
      `SELECT COUNT(*) requests, COALESCE(SUM(bytes),0) bytes FROM access_logs WHERE tunnel_id IN (${owned.map(() => "?").join(",")})`
    ).get(...owned)) as { requests: unknown; bytes: unknown } | undefined;
    return res.json({ requests: Number(row?.requests) || 0, bytes: Number(row?.bytes) || 0 });
  }
  const scoped = ids.length > 0;
  const row = (await db.prepare(
    `SELECT COUNT(*) requests, COALESCE(SUM(bytes),0) bytes FROM access_logs${scoped ? ` WHERE tunnel_id IN (${ids.map(() => "?").join(",")})` : ""}`
  ).get(...(scoped ? ids : []))) as { requests: unknown; bytes: unknown } | undefined;
  // MySQL 的 COUNT/SUM 返回字符串，统一转成数字避免前端格式化出错。
  res.json({ requests: Number(row?.requests) || 0, bytes: Number(row?.bytes) || 0 });
});
app.get("/api/node-parameters", requireAdmin, async (req, res) => {
  // 只暴露运行参数，不包含令牌、数据库凭据等敏感配置。
  res.json({
    role: isNodeController ? "edge" : "controller",
    port: Number(process.env.PORT || 8787),
    bindHost: process.env.BIND_HOST || "127.0.0.1",
    publicHost: process.env.NEXIOUS_PUBLIC_HOST || "",
    database: db.driver,
    logRetentionDays: Number(process.env.NEXIOUS_LOG_RETENTION_DAYS || 30),
    trafficRetentionDays: Number(process.env.NEXIOUS_TRAFFIC_RETENTION_DAYS || 90),
    maxBodyMb: Math.round(maxBodyBytes / 1048576),
    maxWebSocketMb: Math.round(maxWebSocketBytes / 1048576),
    trustProxyHeaders,
    nodeVersion: process.version
  });
});
app.get("/api/dashboard", async (req, res) => {
  const principal = principalOf(req);
  const owner = scopeOf(req);
  // 节点侧只按主控下发的隧道 id 统计：ids 是本机账号自己的隧道，
  // 缺省时才是全量（仅机器凭据与全局视图使用）。
  const requestedIds = String(req.query.ids || "").split(",").map((value) => value.trim())
    .filter((value) => /^[a-zA-Z0-9_-]{1,64}$/.test(value)).slice(0, 1000);
  const trafficFilter = requestedIds.length ? ` AND tr.tunnel_id IN (${requestedIds.map(() => "?").join(",")})` : "";
  const trafficArgs = requestedIds.length ? requestedIds : [];
  // 所有个人账号（包括管理员）只统计自己的隧道；节点机器凭据使用全局数据。
  const tunnelFilter = owner ? " AND t.owner_id = ?" : "";
  const scopedArgs = owner ? [owner] : [];
  const tunnels = sanitizeTunnelsFor(principal, (await tunnelRows(owner)) as Array<Record<string, any>>);
  // 隧道流量记录在节点上，主控本地通常为空。个人账号不能直接取节点全量数据，
  // 否则会把他人流量算进来；因此按“自己名下的隧道 id”向节点定向取数。
  const ownTunnelIds = tunnels.map((item) => String(item.id));
  const nodeIdsQuery = (path: string) =>
    owner ? `${path}${path.includes("?") ? "&" : "?"}ids=${encodeURIComponent(ownTunnelIds.join(","))}` : path;
  const localTotals = (await db
    .prepare(
      `SELECT COALESCE(SUM(tr.inbound),0) inbound, COALESCE(SUM(tr.outbound),0) outbound
       FROM traffic tr JOIN tunnels t ON t.id=tr.tunnel_id
       WHERE tr.timestamp > ?${tunnelFilter}${trafficFilter}`
    )
    .get(new Date(Date.now() - 86400000).toISOString(), ...scopedArgs, ...trafficArgs)) as { inbound: number; outbound: number };
  const localSeries = (await db
    .prepare(
      `SELECT tr.timestamp, SUM(tr.inbound) inbound, SUM(tr.outbound) outbound
       FROM traffic tr JOIN tunnels t ON t.id=tr.tunnel_id
       WHERE tr.timestamp > ?${tunnelFilter}${trafficFilter}
       GROUP BY tr.timestamp ORDER BY tr.timestamp`
    )
    .all(new Date(Date.now() - 86400000).toISOString(), ...scopedArgs, ...trafficArgs)) as TrafficPoint[];
  // 个人账号在没有任何隧道时无需请求节点，直接归零，避免退回全量聚合。
  const nodeResults = owner && !ownTunnelIds.length
    ? []
    : await Promise.allSettled(
        (await configuredNodeControllers()).map((node) =>
          fetchNodeJson<{ totals: { inbound: number; outbound: number }; series: TrafficPoint[] }>(node, nodeIdsQuery("/api/dashboard"))
        )
      );
  // MySQL 的 SUM 返回字符串；若不先转数字，下面的 += 会变成字符串拼接
  // （"0" + 120 = "0120"），累计流量卡片会显示成乱码。
  const totals = { inbound: Number(localTotals?.inbound) || 0, outbound: Number(localTotals?.outbound) || 0 };
  const seriesByHour = new Map<string, TrafficPoint>();
  for (const point of localSeries) seriesByHour.set(point.timestamp, { ...point });
  for (const result of nodeResults) {
    if (result.status !== "fulfilled") continue;
    totals.inbound += Number(result.value.totals.inbound) || 0;
    totals.outbound += Number(result.value.totals.outbound) || 0;
    for (const point of result.value.series || []) {
      const current = seriesByHour.get(point.timestamp) || { timestamp: point.timestamp, inbound: 0, outbound: 0 };
      current.inbound += Number(point.inbound) || 0;
      current.outbound += Number(point.outbound) || 0;
      seriesByHour.set(point.timestamp, current);
    }
  }
  const series = [...seriesByHour.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const nodeCount = (
    (await db
      .prepare("SELECT COUNT(*) count FROM nodes WHERE status='online'")
      .get()) as { count: unknown }
  ).count;
  res.json({
    tunnels,
    totals,
    series,
    // COUNT 在 MySQL 下是字符串，直接下发会让前端“可用节点”显示异常。
    onlineNodes: Number(nodeCount) || 0,
    activeTunnels: tunnels.filter((t) => t.status === "running").length
  });
});
/* ── 数据作用域 ─────────────────────────────────────────────────────── */

// 管理员与普通用户均拥有独立的隧道；服务凭据用于节点同步和内部管理。
// 作用域必须落在 SQL/查询结果上，不能只靠前端过滤，否则改请求参数即可越权。
function scopeOf(req: express.Request): string | null {
  const principal = principalOf(req);
  return principal?.kind === "user" ? principal.id : null;
}

// 节点字段脱敏：普通用户只需要节点名与域名来选节点，
// controller_token 可绕过主控直接指挥节点，绝不能下发。
function sanitizeNodesFor(principal: Principal | null, rows: Array<Record<string, unknown>>) {
  if (principal?.role === "admin") return rows;
  return rows.map((row) => {
    const { controller_token, ssh_user, server_host, controller_url, last_error, ...rest } = row;
    return rest;
  });
}

// 隧道字段脱敏：agent_token 可冒充该隧道的 agent 劫持流量，
// 只在下发 token 的接口返回，列表里一律剔除。
function sanitizeTunnelsFor(
  principal: Principal | null,
  rows: Array<Record<string, any>>
): Array<Record<string, any>> {
  const isFullAdmin = principal?.role === "admin";
  return rows.map((row) => {
    const { agent_token, controller_token, controller_url, server_host, ...rest } = row;
    return isFullAdmin ? { ...rest, agent_token, controller_token, controller_url, server_host } : rest;
  });
}

async function visibleTunnel(req: express.Request, tunnelId: string): Promise<Record<string, any> | null> {
  const owner = scopeOf(req);
  const rows = (await tunnelRows(owner)) as Array<Record<string, any>>;
  return rows.find((row) => row.id === tunnelId) || null;
}

// 统一的越权响应：不区分"不存在"与"无权访问"，避免探测他人资源是否存在。
const NOT_FOUND = "隧道不存在";

app.get("/api/tunnels", async (req, res) =>
  res.json(sanitizeTunnelsFor(principalOf(req), (await tunnelRows(scopeOf(req))) as Array<Record<string, any>>))
);
async function syncTunnelToNode(tunnelId: string, action: "upsert" | "delete", knownRow?: Record<string, any>): Promise<string | null> {
  // 删除隧道时行已从库里移除，必须由调用方先把行传进来，否则同步会被误判为"未配置"而静默跳过。
  const row = knownRow ?? ((await tunnelRows()) as Array<Record<string, any>>).find((item) => item.id === tunnelId);
  if (!row?.controller_url || !row.controller_token) return "节点控制器未配置";
  try {
    const response = await requestNodeController({
      controller_url: row.controller_url, controller_token: row.controller_token,
      host: row.node_host, server_host: row.server_host
    }, "/internal/tunnels/sync", {
      method: "POST", body: JSON.stringify({ action, tunnel: row })
    });
    if (!response.ok) throw new Error(`节点同步失败 HTTP ${response.status}`);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[tunnel-sync] ${tunnelId}: ${message}`);
    return message;
  }
}
async function syncNodeTunnels(nodeId: string) {
  const rows = ((await tunnelRows()) as Array<Record<string, any>>).filter((row) => row.node_id === nodeId);
  const errors: Array<{ tunnelId: string; message: string }> = [];
  for (const row of rows) {
    const message = await syncTunnelToNode(row.id, "upsert");
    if (message) errors.push({ tunnelId: row.id, message });
  }
  return { total: rows.length, success: rows.length - errors.length, failed: errors.length, errors };
}
async function syncAllTunnels() {
  const rows = ((await tunnelRows()) as Array<Record<string, any>>).filter(
    (row) => row.controller_url && row.controller_token
  );
  if (!rows.length) return;
  await Promise.all(rows.map(async (row) => (await syncTunnelToNode(row.id, "upsert"))));
  // 对所有已就绪节点下发对账：节点控制器删除主控已不存在的残留隧道（含零隧道节点）。
  // 残留行会和现役隧道抢同域名的路由，导致流量进入没有 agent 的死隧道。
  const targets = (await configuredNodeControllers());
  await Promise.all(
    targets.map(async (node) => {
      const ids = rows
        .filter((row) => nodeControllerIdentity(row as NodeController) === nodeControllerIdentity(node))
        .map((row) => String(row.id));
      try {
        const response = await requestNodeController(node, "/internal/tunnels/sync", {
          method: "POST",
          body: JSON.stringify({ action: "reconcile", ids })
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        console.warn("[tunnel-sync] 节点对账失败:", error instanceof Error ? error.message : error);
      }
      // 状态对账：远程隧道的 agent 连的是节点的 relay，节点才是运行状态的唯一事实来源。
      // 拉取节点当前状态回写主控，主控视图随实际连接情况收敛（agent 掉线/恢复都能反映）。
      try {
        const response = await requestNodeController(node, "/api/tunnels");
        if (response.ok) {
          const list = (await response.json()) as Array<{ id: string; status: string }>;
          for (const item of list) {
            // controller_url 在 nodes 表上；tunnels 只有 node_id，必须用子查询判断"远程隧道"。
            if (item.status === "running" || item.status === "stopped")
              (await db.prepare("UPDATE tunnels SET status=? WHERE id=? AND node_id IN (SELECT id FROM nodes WHERE controller_url IS NOT NULL)").run(item.status, item.id));
          }
        }
      } catch (error) {
        console.warn("[tunnel-sync] 节点状态拉取失败:", error instanceof Error ? error.message : error);
      }
    })
  );
}
setTimeout(async () => { void (await syncAllTunnels()); }, 1500);
setInterval(async () => { void (await syncAllTunnels()); }, 30_000);
app.post("/internal/tunnels/sync", async (req, res) => {
  // 该接口会改写节点上的隧道表，必须 fail-closed：未配置令牌时直接拒绝。
  if (!adminToken || !authorizationMatches(req.headers.authorization, adminToken))
    return res.status(401).json({ message: "节点同步认证失败" });
  if (!isNodeController) return res.status(403).json({ message: "此接口只允许边缘节点使用" });
  const body = z.object({ action: z.enum(["upsert", "delete", "reconcile"]), tunnel: z.record(z.any()).optional(), ids: z.array(z.string()).optional() }).parse(req.body);
  // 对账只在节点控制器上执行：按主控下发的 id 列表清除残留隧道。主控自身
  // 存着全量数据，绝不能按列表删自己。
  if (body.action === "reconcile") {
    if (!isNodeController) return res.json({ ok: true, skipped: true });
    const ids = body.ids || [];
    const result = ids.length
      ? (await db.prepare(`DELETE FROM tunnels WHERE id NOT IN (${ids.map(() => "?").join(",")})`).run(...ids))
      : (await db.prepare("DELETE FROM tunnels").run());
    if (result.changes) console.warn(`[tunnel-sync] 对账清理了 ${result.changes} 条残留隧道`);
    return res.json({ ok: true, removed: result.changes });
  }
  if (body.action === "delete" && body.tunnel) (await db.prepare("DELETE FROM tunnels WHERE id=?").run(body.tunnel.id));
  else if (body.action === "upsert" && body.tunnel) {
    // 节点控制器使用与主控相同的查询结构，需要先建立对应的本地节点记录。
    // 主控同步的 node_id/node_host 是可信配置数据；缺失时使用稳定的本地 ID，避免 NOT NULL 约束导致整条隧道丢失。
    const nodeId = String(body.tunnel.node_id || "node-local");
    const nodeHost = String(body.tunnel.node_host || "localhost");
    const conflict = await db.prepare("SELECT id FROM tunnels WHERE node_id=? AND domain=? AND id<>?")
      .get(nodeId, body.tunnel.domain ?? null, body.tunnel.id);
    if (conflict) return res.status(409).json({ message: "该节点的隧道域名已被其他隧道使用" });
    (await db.prepare(db.sql("INSERT OR IGNORE INTO nodes (id,name,region,city,latency,`load`,status,host) VALUES (?,?,?,?,?,?,?,?)",
      "INSERT IGNORE INTO nodes (id,name,region,city,latency,`load`,status,host) VALUES (?,?,?,?,?,?,?,?)"))
      .run(nodeId, String(body.tunnel.node_name || nodeId), "默认", "默认", 0, 0, "online", nodeHost));
    (await db.prepare("UPDATE nodes SET host=?,status='online' WHERE id=?").run(nodeHost, nodeId));
    const tunnel = body.tunnel;
    // 运行状态由节点自己的 relay 连接派生，主控推送的配置同步不得覆盖它：
    // 否则主控对远程隧道的误判（其 agents 映射里根本没有这条隧道）会把节点上
    // 正在服务的隧道错误地刷成 stopped。status 仅在首次插入时采用，更新时保留节点现值。
    const configValues = [tunnel.name, tunnel.protocol, tunnel.local_host, tunnel.local_port, tunnel.remote_port,
      nodeId, tunnel.domain ?? null, tunnel.agent_token || null, tunnel.auto_start || 0];
    try {
      await db.transaction(async () => {
        const current = await db.prepare("SELECT id FROM tunnels WHERE id=?" + db.forUpdate).get(tunnel.id);
        if (current) {
          await db.prepare("UPDATE tunnels SET name=?,protocol=?,local_host=?,local_port=?,remote_port=?,node_id=?,domain=?,agent_token=?,auto_start=? WHERE id=?")
            .run(...configValues, tunnel.id);
        } else {
          await db.prepare("INSERT INTO tunnels (name,protocol,local_host,local_port,remote_port,node_id,status,domain,agent_token,auto_start,id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(tunnel.name, tunnel.protocol, tunnel.local_host, tunnel.local_port, tunnel.remote_port,
              nodeId, tunnel.status || "stopped", tunnel.domain ?? null, tunnel.agent_token || null, tunnel.auto_start || 0,
              tunnel.id, tunnel.created_at || new Date().toISOString());
        }
      });
    } catch (error) {
      if ((error as { code?: string }).code === "ER_DUP_ENTRY" || String(error).includes("UNIQUE constraint failed"))
        return res.status(409).json({ message: "隧道或域名已存在，请重新同步" });
      throw error;
    }
  }
  res.json({ ok: true });
});
app.post("/api/tunnels/:id/token", async (req, res) => {
  const tunnel = (await visibleTunnel(req, req.params.id)) as
    | { id: string; node_host?: string; controller_url?: string; server_host?: string }
    | null;
  if (!tunnel) return res.status(404).json({ message: NOT_FOUND });
  const token = randomUUID().replaceAll("-", "");
  (await db.prepare("UPDATE tunnels SET agent_token=? WHERE id=?").run(
    token,
    req.params.id
  ));
  // 旧 agent 持有的 token 已失效：立即断开它的 relay 连接，让流量马上切到携带新
  // token 的 agent，而不是等旧连接日后重连时才撞上 1008——那会表现为隧道"看似
  // 在线，实际随时会死"。1008 会让 agent 判定为鉴权失败而不重连（见 agent 侧约定）。
  agents.get(req.params.id)?.close(1008, "token rotated");
  if (tunnel.controller_url) {
    const syncError = await syncTunnelToNode(req.params.id, "upsert");
    if (syncError) return res.status(502).json({ message: syncError });
  }
  const nodeRelay=tunnel.controller_url
    ? tunnel.controller_url.replace(/^http/,"ws").replace(/\/api\/?$/,"/relay")
    : null;
  // 控制中心在本机运行时，agent 改连本机桥接端点、由本机 Node 代连节点：直连节点的 TLS 握手
  // 在部分网络会被中途重置（rustls 与 schannel 都会，Node/OpenSSL 不会），因此不再下发直连参数。
  const bridgeRelay = !isNodeController && nodeRelay ? `ws://127.0.0.1:${port}/relay-bridge` : null;
  res.json({
    token,
    tunnelId: req.params.id,
    relay: bridgeRelay || nodeRelay || `${process.env.RELAY_URL || "ws://127.0.0.1:8787"}/relay`,
    directRelay: bridgeRelay ? null : directRelayForNode(tunnel.controller_url, tunnel.node_host, tunnel.server_host)
  });
});
// 隧道测速：由控制中心发起而不是浏览器，既避开跨域预检，也复用服务端的流式读写能力。
// 请求走的是公网域名，链路为 nginx → 节点 relay → 本机桥接 → agent → 本地服务，
// 因此测得的是隧道的真实吞吐，而不是浏览器到控制中心的网络质量。
const speedTestSchema = z.object({
  // 默认测首页；但首页通常只有几百字节，测带宽需要用户填一个较大的静态文件路径。
  path: z.string().trim().default("/"),
  sizeMb: z.number().min(0.1).max(16).default(8),
  direction: z.enum(["both", "down", "up"]).default("both"),
  timeoutMs: z.number().int().min(3000).max(60000).default(20000)
});
// access_url 来自数据库，仍然重新解析并限定协议，避免异常数据让本进程发起
// file:/data: 之类的请求。
function speedTestUrl(accessUrl: unknown, safePath: string): string | null {
  if (typeof accessUrl !== "string" || !accessUrl) return null;
  try {
    const base = new URL(accessUrl);
    if (base.protocol !== "https:" && base.protocol !== "http:") return null;
    return new URL(safePath, base).toString();
  } catch {
    return null;
  }
}
app.post("/api/tunnels/:id/speedtest", async (req, res, next) => {
  try {
    const row = await visibleTunnel(req, req.params.id);
    if (!row) return res.status(404).json({ message: NOT_FOUND });
    if (row.status !== "running") return res.status(409).json({ message: "隧道未运行，请先启动后再测速" });
    const value = speedTestSchema.parse(req.body ?? {});
    // 路径复用公网转发的同一套校验：测速不能让本进程去请求隧道之外的地址。
    const safePath = safeForwardPath(value.path);
    if (!safePath) return res.status(400).json({ message: "测速路径必须是站点内的绝对路径，例如 /assets/app.js" });
    const url = speedTestUrl(row.access_url, safePath);
    if (!url) return res.status(400).json({ message: "该隧道还没有可访问的公网域名，无法测速" });
    const sizeBytes = Math.round(value.sizeMb * 1024 * 1024);
    // 上下行必须串行：并发会互相争抢同一条隧道的带宽，两侧速率都会失真。
    const result: {
      url: string;
      path: string;
      sizeBytes: number;
      download?: SpeedSample;
      upload?: SpeedSample;
    } = { url, path: safePath, sizeBytes };
    if (value.direction !== "up") result.download = await measureDownload({ url, sizeBytes, timeoutMs: value.timeoutMs });
    if (value.direction !== "down") result.upload = await measureUpload({ url, sizeBytes, timeoutMs: value.timeoutMs });
    res.json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return next(error);
    // 测速失败属于目标链路问题（agent 掉线、域名解析不到等），按 502 返回具体原因。
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ message: `测速失败：${message}` });
  }
});
app.post("/api/tunnels", async (req, res) => {
  const value = tunnelSchema.parse(req.body);
  const principal = principalOf(req);
  const owner = principal?.kind === "user" ? principal.id : null;

  const id = `tun-${randomUUID().slice(0, 8)}`;
  // 配额检查与插入必须在同一事务内、并对账号行加锁：并发请求若各自先读到
  // used < quota 再一起插入，就能突破配额（COUNT 之后才 INSERT 的 TOCTOU）。
  const outcome = await db.transaction(async () => {
    // 子域名占用检查同样必须在事务内：事务外先查后插，两个并发请求会同时通过检查，
    // 最终由唯一索引报错（500）或在无索引后端写入重复域名（路由歧义）。
    if (await domainIsOccupied(value.nodeId, value.domain)) return { exceeded: null as number | null, duplicateName: 0, occupied: true as const };
    if (principal?.kind === "user" && principal.role !== "admin") {
      await db.prepare(`SELECT id FROM users WHERE id=?${db.forUpdate}`).get(principal.id);
      const quota = await effectiveTunnelQuota(principal.id);
      const used = (
        (await db.prepare("SELECT COUNT(*) count FROM tunnels WHERE owner_id=?").get(principal.id)) as {
          count: number;
        }
      ).count;
      if (used >= quota) return { exceeded: quota as number | null, duplicateName: 0, occupied: false as const };
    }
    // 隧道名允许重复（不同用户之间、同一用户内都允许）：name 只是展示标签，
    // 路由与 agent 全部以 id 为准。这里只做一次友好提醒，不阻塞创建。
    const sameName = owner
      ? ((await db.prepare("SELECT COUNT(*) count FROM tunnels WHERE owner_id=? AND lower(name)=lower(?)")
          .get(owner, value.name)) as { count: number }).count
      : 0;
    await db.prepare(
      `INSERT INTO tunnels (id,name,protocol,local_host,local_port,remote_port,node_id,status,domain,created_at,owner_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      value.name,
      value.protocol,
      value.localHost,
      value.localPort,
      value.remotePort,
      value.nodeId,
      "stopped",
      value.domain || null,
      new Date().toISOString(),
      owner
    );
    return { exceeded: null, duplicateName: sameName, occupied: false as const };
  }).catch((error: unknown) => {
    // 唯一索引兜底：并发下仍可能撞库，转成与预检查一致的 409。
    if ((error as { code?: string }).code === "ER_DUP_ENTRY" || String(error).includes("UNIQUE constraint failed"))
      return { exceeded: null as number | null, duplicateName: 0, occupied: true as const };
    throw error;
  });
  if (outcome.occupied)
    return res.status(409).json({ message: "该子域名已被占用，请换一个" });
  if (outcome.exceeded !== null)
    return res.status(403).json({ message: `已达隧道数量上限（${outcome.exceeded} 条），请联系管理员调整` });
  if (outcome.duplicateName) res.setHeader("x-nexious-duplicate-name", "1");
  (await audit(principal, "tunnel_created", "tunnel", id, value.name, clientIp(req)));
  void (await syncTunnelToNode(id, "upsert"));
  res
    .status(201)
    .json(
      sanitizeTunnelsFor(principal, (await tunnelRows(owner)) as Array<Record<string, any>>).find(
        (item) => item.id === id
      )
    );
});
app.put("/api/tunnels/:id", async (req, res) => {
  // 归属检查先于 body 校验：无权访问的资源不应进入参数处理流程，
  // 也让越权响应与"资源不存在"保持一致（统一 404，不泄露资源是否存在）。
  if (!(await visibleTunnel(req, req.params.id))) return res.status(404).json({ message: NOT_FOUND });
  const value = tunnelSchema.parse(req.body);
  // 与创建一致：占用检查与 UPDATE 同事务，唯一索引兜底并发撞库并转 409。
  const updated = await db.transaction(async () => {
    if (await domainIsOccupied(value.nodeId, value.domain, req.params.id)) return -1;
    const result = await db
      .prepare(
        `UPDATE tunnels SET name=?,protocol=?,local_host=?,local_port=?,remote_port=?,node_id=?,domain=? WHERE id=?`
      )
      .run(
        value.name,
        value.protocol,
        value.localHost,
        value.localPort,
        value.remotePort,
        value.nodeId,
        value.domain || null,
        req.params.id
      );
    return result.changes;
  }).catch((error: unknown) => {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY" || String(error).includes("UNIQUE constraint failed"))
      return -1;
    throw error;
  });
  if (updated === -1) return res.status(409).json({ message: "该子域名已被占用，请换一个" });
  if (!updated) return res.status(404).json({ message: NOT_FOUND });
  (await audit(principalOf(req), "tunnel_updated", "tunnel", req.params.id, value.name, clientIp(req)));
  void (await syncTunnelToNode(req.params.id, "upsert"));
  res.json(
    sanitizeTunnelsFor(principalOf(req), (await tunnelRows(scopeOf(req))) as Array<Record<string, any>>).find(
      (item) => item.id === req.params.id
    )
  );
});
app.patch("/api/tunnels/:id/status", async (req, res) => {
  const { status } = z
    .object({ status: z.enum(["running", "stopped"]) })
    .parse(req.body);
  const row = await visibleTunnel(req, req.params.id);
  if (!row) return res.status(404).json({ message: NOT_FOUND });
  // running 的语义是「agent 已连接」。只有连到本进程 relay 的本地隧道才能直接核验；
  // 远程隧道的 agent 连的是节点的 relay，主控的 agents 里永远没有它，
  // 必须信任客户端意图（桌面端在 agent 启动成功后才调用本接口），
  // 真实状态由周期性的节点状态对账回写。
  const remote = Boolean(row.controller_url);
  const agentOnline = status === "running" && (remote || agents.get(req.params.id)?.readyState === WebSocket.OPEN);
  const effectiveStatus = status === "running" ? (agentOnline ? "running" : "stopped") : "stopped";
  const result = (await db
    .prepare("UPDATE tunnels SET status=?,auto_start=? WHERE id=?")
    .run(effectiveStatus, status === "running" ? 1 : 0, req.params.id));
  if (!result.changes) return res.status(404).json({ message: NOT_FOUND });
  void (await syncTunnelToNode(req.params.id, "upsert"));
  res.json({
    id: req.params.id,
    status: effectiveStatus,
    auto_start: status === "running" ? 1 : 0
  });
});
app.delete("/api/tunnels/:id", async (req, res) => {
  const row = (await visibleTunnel(req, req.params.id));
  if (!row) return res.status(404).json({ message: NOT_FOUND });
  const result = (await db
    .prepare("DELETE FROM tunnels WHERE id=?")
    .run(req.params.id));
  if (!result.changes) return res.status(404).json({ message: NOT_FOUND });
  (await audit(principalOf(req), "tunnel_deleted", "tunnel", req.params.id, row.name, clientIp(req)));
  void (await syncTunnelToNode(req.params.id, "delete", row));
  res.status(204).end();
});
app.get("/api/nodes", async (req, res, next) => {
  try { await refreshNodeHealth(); res.json(
    sanitizeNodesFor(
      principalOf(req),
      (await db.prepare(`${nodeSelect} ORDER BY status,name`).all()) as Array<Record<string, unknown>>
    )
  ); } catch(error){next(error)}
});
app.post("/api/nodes", requireAdmin, async (req, res) => {
  const value = nodeSchema.parse(req.body),
    id = `n-${randomUUID().slice(0, 8)}`;
  (await db.prepare(
    "INSERT INTO nodes (id,name,region,city,latency,`load`,status,host) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, value.name, "默认", "默认", 0, 0, "maintenance", value.host));
  res
    .status(201)
    .json(
      (await db.prepare(`${nodeSelect} WHERE id=?`).get(id))
    );
});
app.put("/api/nodes/:id", requireAdmin, async (req, res) => {
  if ([...deployJobs.values()].some(job => job.nodeId === req.params.id && job.status === "running"))
    return res.status(409).json({ message: "节点正在部署，请等待完成后再修改" });
  const value = nodeSchema.parse(req.body);
  const result = (await db
    .prepare("UPDATE nodes SET name=?,host=? WHERE id=?")
    .run(value.name, value.host, req.params.id));
  if (!result.changes) return res.status(404).json({ message: "节点不存在" });
  res.json(
    (await db
      .prepare(`${nodeSelect} WHERE id=?`)
      .get(req.params.id))
  );
});
app.post("/api/nodes/:id/inspect", requireAdmin, async (req, res, next) => {
  try {
    const value = serverSchema.parse(req.body);
    const [username, host] = value.connection.split("@");
    const node = (await db.prepare(`${nodeSelect} WHERE id=?`).get(req.params.id)) as Record<string, string> | undefined;
    if (!node) return res.status(404).json({ message: "节点不存在" });
    if ([...deployJobs.values()].some(job => job.nodeId === req.params.id && job.status === "running"))
      return res.status(409).json({ message: "节点正在部署，请等待完成后再检查" });
    const result = await inspectNode({ host, username, password: value.password, port: value.port }, node.host, node.controller_url);
    const nextControllerUrl = result.controllerUrl || node.controller_url || null;
    const nextControllerToken = result.token || node.controller_token || null;
    (await db.prepare("UPDATE nodes SET server_host=?,ssh_user=?,ssh_port=?,controller_url=?,controller_token=?,deploy_status=?,status=?,last_checked_at=?,last_error=? WHERE id=?")
      .run(host, username, value.port, nextControllerUrl, nextControllerToken, result.healthy ? "ready" : result.configured ? "error" : "unconfigured",result.healthy?"online":"maintenance", new Date().toISOString(), result.healthy ? null : result.message, req.params.id));
    res.json(result);
  } catch (error) { next(error); }
});
app.post("/api/nodes/:id/reset", requireAdmin, requireSelf, async (req, res, next) => {
  const id = String(req.params.id);
  try {
    const value = z.object({ password: z.string().min(1).max(200), captchaTicket: z.string().length(48) }).strict().parse(req.body);
    const node = await db.prepare(`${nodeSelect} WHERE id=?`).get(id);
    if (!node) return res.status(404).json({ message: "节点不存在" });
    if (!node.server_host || !node.ssh_user) return res.status(400).json({ message: "请先关联服务器并检查连接" });
    const serverKey = `${String(node.server_host).toLowerCase()}:${node.ssh_port}`;
    if ([...deployJobs.values()].some(job => job.status === "running" && (job.nodeId === id || job.serverKey === serverKey))) return res.status(409).json({ message: "该服务器正在执行任务，请等待完成" });
    await consumeVerification(value.captchaTicket, "proof-node-reset", captchaSubject(req, clientIp(req), "node-reset", id), value.captchaTicket);
    // 验证后再次检查，防止两个请求在验证码消费等待期间同时进入。
    if ([...deployJobs.values()].some(job => job.status === "running" && (job.nodeId === id || job.serverKey === serverKey))) return res.status(409).json({ message: "该服务器正在执行任务，请等待完成" });
    const job: DeployJob = { id: randomUUID(), nodeId: id, serverKey, status: "running", logs: [], createdAt: Date.now() };
    deployJobs.set(job.id, job);
    try {
      const result = await resetNode({ host: node.server_host, username: node.ssh_user, port: Number(node.ssh_port), password: value.password });
      await db.transaction(async () => {
        await db.prepare("UPDATE nodes SET controller_url=NULL,controller_token=NULL,deploy_status='unconfigured',status='maintenance',last_error=NULL,last_checked_at=? WHERE id=?").run(new Date().toISOString(), id);
        await db.prepare("UPDATE tunnels SET status='stopped',auto_start=0,agent_token=NULL WHERE node_id=?").run(id);
        await audit(principalOf(req), "node_reset", "node", id, `backup=${result.backupPath}`, clientIp(req));
      });
      const tunnels = await db.prepare("SELECT id FROM tunnels WHERE node_id=?").all(id);
      for (const tunnel of tunnels) agents.get(tunnel.id)?.close(1008, "node reset");
      job.status = "success";
      res.json(result);
    } catch (error) { job.status = "error"; throw error; }
  } catch (error) {
    if (error instanceof VerificationError) return res.status(error.status).json({ message: error.message, code: error.code });
    if (error instanceof z.ZodError) return next(error);
    res.status(502).json({ message: `重置失败：${error instanceof Error ? error.message : "无法连接服务器"}` });
  }
});
app.post("/api/nodes/:id/deploy", requireAdmin, async (req, res, next) => {
  try {
    const value = serverSchema.parse(req.body);
    const [username, host] = value.connection.split("@");
    const nodeRow = (await db.prepare(`${nodeSelect} WHERE id=?`).get(req.params.id)) as NodeController & {
      deploy_status:string;server_host:string|null;ssh_user:string|null;ssh_port:number;status:string
    } | undefined;
    if (!nodeRow) return res.status(404).json({ message: "节点不存在" });
    const serverKey = `${host.toLowerCase()}:${value.port}`;
    const active=[...deployJobs.values()].find(job=>job.status==="running" && (job.nodeId===req.params.id || job.serverKey===serverKey));
    if(active)return res.status(409).json({message:"该节点或服务器已有部署任务正在运行",jobId:active.id});
    pruneDeployJobs();
    const deployNodeId=String(req.params.id);const job:DeployJob={id:randomUUID(),nodeId:deployNodeId,serverKey,status:"running",logs:[],createdAt:Date.now()};
    deployJobs.set(job.id,job);appendJobLog(job,"部署任务已创建");
    (await db.prepare("UPDATE nodes SET server_host=?,ssh_user=?,ssh_port=?,deploy_status='deploying',last_error=NULL WHERE id=?")
      .run(host, username, value.port, req.params.id));
    res.status(202).json({jobId:job.id});
    void (async()=>{try {
      const result = await deployNode({ host, username, password: value.password, port: value.port },message=>appendJobLog(job,message), value.force, nodeRow.host, nodeRow.controller_url);
      (await db.prepare("UPDATE nodes SET controller_url=?,controller_token=?,deploy_status='ready',status='online',last_checked_at=?,last_error=NULL WHERE id=?")
        .run(result.controllerUrl, result.token, new Date().toISOString(), req.params.id));
      appendJobLog(job, "控制中心已就绪，开始立即同步该节点的隧道配置");
      const sync = await syncNodeTunnels(deployNodeId);
      if (sync.failed) {
        const summary = `隧道同步完成：${sync.success}/${sync.total} 成功，${sync.failed} 失败`;
        appendJobLog(job, `警告：${summary}`);
        appendJobLog(job, sync.errors.map((item) => `${item.tunnelId}: ${item.message}`).join("；"));
        (await db.prepare("UPDATE nodes SET last_error=? WHERE id=?").run(summary, req.params.id));
      } else {
        appendJobLog(job, `隧道同步完成：${sync.success}/${sync.total} 成功`);
      }
      job.result={...result, sync};job.status="success";
    } catch (error) {
      const message = error instanceof Error ? error.message : "自动部署失败";
      appendJobLog(job,`部署失败：${message}`);
      let restored = false;
      if (nodeRow.deploy_status === "ready" && nodeRow.controller_url && nodeRow.controller_token) {
        try {
          const response = await requestNodeController(nodeRow, "/api/tunnels");
          restored = response.ok && Array.isArray(await response.json());
        } catch { /* 旧节点不可达时保留失败状态，供后续修复。 */ }
      }
      (await db.prepare("UPDATE nodes SET server_host=?,ssh_user=?,ssh_port=?,controller_url=?,controller_token=?,deploy_status=?,status=?,last_checked_at=?,last_error=? WHERE id=?")
        .run(restored ? nodeRow.server_host : host, restored ? nodeRow.ssh_user : username, restored ? nodeRow.ssh_port : value.port,
          nodeRow.controller_url, nodeRow.controller_token, restored ? "ready" : "error", restored ? "online" : "maintenance",
          new Date().toISOString(), message.slice(0, 500), req.params.id));
      if (restored) appendJobLog(job, "旧节点仍可连接，已保留原访问配置");
      job.error=message;job.status="error";
    }})();
  } catch (error) { next(error); }
});
app.get("/api/nodes/:id/deployment", requireAdmin, async (req, res) => {
  if (!(await db.prepare("SELECT id FROM nodes WHERE id=?").get(req.params.id))) return res.status(404).json({ message: "节点不存在" });
  const active = [...deployJobs.values()].find(job => job.nodeId === String(req.params.id) && job.status === "running");
  return res.json({ jobId: active?.id || null });
});
app.get("/api/deployments/:jobId", requireAdmin, (req,res)=>{
  pruneDeployJobs();
  const job=deployJobs.get(String(req.params.jobId));if(!job)return res.status(404).json({message:"部署任务不存在或已过期"});
  const cursor=Math.min(job.logs.length,Math.max(0,Math.floor(Number(req.query.cursor)||0)));
  res.json({jobId:job.id,status:job.status,logs:job.logs.slice(cursor),cursor:job.logs.length,result:job.result,error:job.error});
});
app.get("/api/nodes/:id/detail", requireAdmin, async (req, res, next) => {
  try {
    const node = (await db.prepare(
      "SELECT id,name,host,status,server_host,ssh_user,ssh_port,controller_url,deploy_status,last_checked_at,last_error FROM nodes WHERE id=?"
    ).get(req.params.id)) as Record<string, unknown> | undefined;
    if (!node) return res.status(404).json({ message: "节点不存在" });
    // 与全站一致：个人账号（含管理员）只能看到自己名下的隧道，机器凭据才是全量。
    const owner = scopeOf(req);
    const tunnels = (await db.prepare(
      `SELECT id,name,protocol,local_host,local_port,remote_port,status,domain,created_at,auto_start FROM tunnels
       WHERE node_id=?${owner ? " AND owner_id=?" : ""} ORDER BY created_at DESC`
    ).all(...(owner ? [req.params.id, owner] : [req.params.id]))) as Array<Record<string, unknown>>;
    const scopedTunnelIds = tunnels.map((item) => String(item.id));
    // 主控本地记录（隧道流量通常落在节点上，这里是兜底）。
    const localTotals = (await db.prepare(
      scopedTunnelIds.length
        ? `SELECT COUNT(*) requests, COALESCE(SUM(bytes),0) bytes FROM access_logs WHERE tunnel_id IN (${scopedTunnelIds.map(() => "?").join(",")})`
        : "SELECT 0 requests, 0 bytes"
    ).get(...scopedTunnelIds)) as { requests: unknown; bytes: unknown };
    // 节点自身的运行参数（保留天数等）由节点控制器回答，主控只做透传；
    // 节点不可达时返回 null，让详情页显示“未知”而不是把主控配置误当成节点配置。
    let parameters: Record<string, unknown> | null = null;
    // 节点侧隧道 id 用于发现同步漂移：主控是唯一事实来源，节点只应存在主控下发的子集。
    let nodeTunnelIds: string[] | null = null;
    // 公网流量由节点承接并记录，所以累计值要以节点为主，再叠加主控本地记录的部分。
    let nodeTotals: { requests: number; bytes: number | null } | null = null;
    if (node.controller_url && node.deploy_status === "ready") {
      const controller = (await configuredNodeControllers()).find((item) => item.id === req.params.id);
      if (controller) {
        try { parameters = await fetchNodeJson<Record<string, unknown>>(controller, "/api/node-parameters"); }
        catch { parameters = null; }
        try {
          const remote = await fetchNodeJson<Array<{ id: string }>>(controller, "/api/tunnels");
          nodeTunnelIds = remote.map((item) => String(item.id));
        } catch { nodeTunnelIds = null; }
        // 个人账号必须按自己名下的隧道取数。没有隧道时直接归零，
        // 绝不能退回不带 ids 的调用，那样会拿到整节点的全量流量（越权）。
        if (!owner || scopedTunnelIds.length) {
          try {
            const query = owner ? `?ids=${encodeURIComponent(scopedTunnelIds.join(","))}` : "";
            const stats = await fetchNodeJson<{ requests: unknown; bytes: unknown }>(controller, `/api/node-stats${query}`);
            nodeTotals = { requests: Number(stats.requests) || 0, bytes: Number(stats.bytes) || 0 };
          } catch {
            // 旧版节点没有 node-stats：逐条按 tunnelId 取总数（有界），字节数无从得知，
            // 返回 null 让界面显示“—”，避免用 0 冒充真实流量。
            try {
              const ids = owner ? scopedTunnelIds.slice(0, 20) : [];
              const totals = await Promise.all(ids.map((id) =>
                fetchNodeJson<{ total: unknown }>(controller, `/api/logs?page=1&pageSize=10&status=all&tunnelId=${encodeURIComponent(id)}`)));
              nodeTotals = ids.length
                ? { requests: totals.reduce((sum, item) => sum + (Number(item.total) || 0), 0), bytes: null }
                : { requests: Number((await fetchNodeJson<{ total: unknown }>(controller, "/api/logs?page=1&pageSize=10&status=all")).total) || 0, bytes: null };
            } catch { nodeTotals = null; }
          }
        } else nodeTotals = { requests: 0, bytes: 0 };
      }
    }
    // MySQL 的 COUNT/SUM 返回字符串，必须显式转成数字，否则前端格式化会得到 NaN。
    const localBytes = Number(localTotals?.bytes) || 0;
    const remoteBytes = nodeTotals?.bytes ?? null;
    const totals = {
      requests: (Number(localTotals?.requests) || 0) + (nodeTotals?.requests ?? 0),
      // 任一来源无法确认字节数时给出 null，界面据此显示“—”
      bytes: remoteBytes === null ? null : localBytes + remoteBytes
    };
    const localIds = new Set(scopedTunnelIds);
    // 漂移判定要和节点上的全量隧道比较，否则会把其他账号的隧道误报成残留。
    const allNodeTunnelIds = new Set(((await db.prepare("SELECT id FROM tunnels WHERE node_id=?")
      .all(req.params.id)) as Array<{ id: string }>).map((item) => String(item.id)));
    res.json({ node, tunnels, totals, parameters, nodeTunnelIds,
      syncDrift: nodeTunnelIds ? {
        // 当前账号的隧道尚未下发到节点。
        missing: [...localIds].filter((id) => !nodeTunnelIds!.includes(id)),
        // 节点上存在但主控任何账号都没有的残留（其他账号的隧道不算残留）。
        extra: nodeTunnelIds.filter((id) => !allNodeTunnelIds.has(id))
      } : null,
      activeJobId:
      [...deployJobs.values()].find(job => job.nodeId === String(req.params.id) && job.status === "running")?.id || null });
  } catch (error) { next(error); }
});
app.delete("/api/nodes/:id", requireAdmin, async (req, res) => {
  if ([...deployJobs.values()].some(job => job.nodeId === req.params.id && job.status === "running"))
    return res.status(409).json({ message: "节点正在部署，请等待完成后再删除" });
  const used = (await db
    .prepare("SELECT COUNT(*) count FROM tunnels WHERE node_id=?")
    .get(req.params.id)) as { count: number };
  if (used.count)
    return res
      .status(409)
      .json({ message: `该节点仍被 ${used.count} 条隧道使用，无法删除` });
  const result = (await db.prepare("DELETE FROM nodes WHERE id=?").run(req.params.id));
  if (!result.changes) return res.status(404).json({ message: "节点不存在" });
  res.status(204).end();
});
app.get("/api/logs", async (req, res) => {
  const query = z
    .object({
      tunnelId: z.string().optional(),
      nodeId: z.string().optional(),
      // 主控向节点取日志时用于限定隧道范围；节点无账号体系，由主控负责归属校验。
      ids: z.string().max(20000).optional(),
      // 显式告诉节点“已按扩展名排除静态资源”，避免节点重复推断；缺省即排除。
      excludeStatic: z.enum(["0", "1"]).optional(),
      search: z.string().trim().max(100).optional(),
      status: z.enum(["all", "success", "error"]).default("all"),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(10).max(5000).default(20)
    })
    .parse(req.query);
  // 只保留用户真正的访问：过滤开发服务器路径、站点图标与前端构建产物。
  const conditions: string[] = [
    "path NOT LIKE '/src/%'",
    "path NOT LIKE '/node_modules/%'",
    "path NOT LIKE '/@vite/%'",
    "path NOT LIKE '/favicon.ico%'",
    ...(query.excludeStatic === "0" ? [] : staticAssetConditions())
  ];
  const values: unknown[] = [];
  // 用户角色只允许查询自己隧道的日志；用 JOIN 在 SQL 层过滤，
  // 避免依赖前端的 tunnelId 传参（伪造参数即可越权读他人访问记录）。
  const owner = scopeOf(req);
  // ids 由主控按自己名下的隧道下发；为空字符串时表示“没有可读隧道”，必须返回空集，
  // 否则会退化成读取该节点全部日志。
  const scopedIds = query.ids === undefined ? null
    : query.ids.split(",").map((value) => value.trim())
        .filter((value) => /^[a-zA-Z0-9_-]{1,64}$/.test(value)).slice(0, 1000);
  if (scopedIds && !scopedIds.length) return res.json({ items: [], total: 0, page: query.page, pageSize: query.pageSize });
  // 按节点过滤同样需要 JOIN 隧道表取 node_id；用户角色本来就 JOIN，且归属条件
  // 始终叠加，所以节点过滤不会让越权查询生效。
  const joinTunnels = Boolean(owner) || Boolean(query.nodeId);
  const fromClause = joinTunnels
    ? "FROM access_logs l JOIN tunnels t ON t.id = l.tunnel_id"
    : "FROM access_logs l";
  const columnPrefix = joinTunnels ? "l." : "";
  if (scopedIds) {
    conditions.push(`${columnPrefix}tunnel_id IN (${scopedIds.map(() => "?").join(",")})`);
    values.push(...scopedIds);
  }
  if (query.tunnelId) {
    conditions.push(`${columnPrefix}tunnel_id=?`);
    values.push(query.tunnelId);
  }
  if (query.nodeId) {
    conditions.push("t.node_id=?");
    values.push(query.nodeId);
  }
  if (owner) {
    conditions.push("t.owner_id=?");
    values.push(owner);
  }
  if (query.search) {
    conditions.push(
      `(${columnPrefix}path LIKE ? OR ${columnPrefix}client_ip LIKE ? OR ${columnPrefix}method LIKE ?)`
    );
    const term = `%${query.search}%`;
    values.push(term, term, term);
  }
  if (query.status === "success") conditions.push(`${columnPrefix}status<400`);
  if (query.status === "error") conditions.push(`${columnPrefix}status>=400`);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const localTotal = (
    (await db
      .prepare(`SELECT COUNT(*) count ${fromClause} ${where}`)
      .get(...values)) as { count: number }
  ).count;
  const candidateLimit = Math.min(query.page * query.pageSize, 5000);
  const localItems = (await db
    .prepare(
      `SELECT ${joinTunnels ? "l.*" : "*"} ${fromClause} ${where} ORDER BY ${columnPrefix}timestamp DESC LIMIT ?`
    )
    .all(...values, candidateLimit)) as AccessLogRow[];
  // 旧版节点不过滤静态资源，其返回的前 N 条可能几乎全是 JS/CSS；这里放大取样池，
  // 过滤后才不至于每页只剩零星几条。
  const nodePoolLimit = Math.min(candidateLimit * 10, 5000);
  const nodeQuery = new URLSearchParams({ page: "1", pageSize: String(nodePoolLimit), status: query.status, excludeStatic: "1" });
  if (query.tunnelId) nodeQuery.set("tunnelId", query.tunnelId);
  if (query.search) nodeQuery.set("search", query.search);
  // 节点侧没有账号归属信息，个人账号不能直接聚合；改为带上自己名下的隧道 id 让节点过滤，
  // 每个节点一次请求即可拿到真实记录，又不会把他人日志带进来。
  const controllers = await configuredNodeControllers();
  let ownTunnelIds: string[] | null = null;
  if (owner) {
    const rows = (await db.prepare("SELECT id FROM tunnels WHERE owner_id=?").all(owner)) as Array<{ id: string }>;
    ownTunnelIds = rows.map((row) => String(row.id));
    // 指定隧道时必须确认它属于当前账号，否则会越权读他人日志。
    if (query.tunnelId) ownTunnelIds = ownTunnelIds.filter((id) => id === query.tunnelId);
    // 个人账号没有可读隧道时无需请求节点；同时显式传空 ids 让节点返回空，
    // 避免缺省语义退化成“节点全量日志”。
    if (!ownTunnelIds.length) ownTunnelIds = [];
    nodeQuery.set("ids", ownTunnelIds.join(","));
  }
  // 指定节点时只查询该节点：公网流量由节点承接并记录，其他节点的日志与本次查询无关。
  const targets = (query.nodeId ? controllers.filter((node) => node.id === query.nodeId) : controllers)
    .filter(() => !owner || (ownTunnelIds as string[]).length > 0);
  const nodeResults = await Promise.allSettled(
    targets.map((node) => fetchNodeJson<{ items: AccessLogRow[]; total: number }>(node, `/api/logs?${nodeQuery}`))
  );
  // MySQL 的 COUNT 返回字符串，必须先转数字，否则下面的 += 会变成字符串拼接。
  let total = Number(localTotal) || 0;
  const candidates = [...localItems];
  for (const result of nodeResults) {
    if (result.status !== "fulfilled") continue;
    total += Number(result.value.total) || 0;
    candidates.push(...(result.value.items || []));
  }
  // 主控本地已用 SQL 过滤；这里再对节点返回的记录兜底过滤一遍，旧版节点才会正确显示。
  // 过滤后按实际保留条数修正总数，避免总数把已被过滤的静态资源也算进去。
  const visible = candidates.filter((row) => !isStaticAssetPath((row as Record<string, unknown>).path));
  if (visible.length !== candidates.length) total -= candidates.length - visible.length;
  visible.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  const offset = (query.page - 1) * query.pageSize;
  const items = visible.slice(offset, offset + query.pageSize);
  // 访问日志按“用户访问了哪个地址”呈现：把只有路径的记录补成完整 URL，
  // 前端不再需要自己拼接子域名。
  const urlByTunnel = new Map<string, string>();
  for (const row of (await db.prepare(
    "SELECT t.id,t.domain,t.protocol,n.host FROM tunnels t LEFT JOIN nodes n ON n.id=t.node_id"
  ).all()) as Array<{ id: string; domain: string | null; protocol: string | null; host: string | null }>) {
    if (row.domain && row.host) urlByTunnel.set(String(row.id), `${row.protocol || "http"}://${row.domain}.${row.host}`);
  }
  for (const item of items as Array<Record<string, unknown>>) {
    const base = urlByTunnel.get(String(item.tunnel_id));
    if (!base) continue;
    const path = String(item.path || "/");
    item.access_url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  }
  res.json({ items, total, page: query.page, pageSize: query.pageSize });
});
const relay = new WebSocketServer({ noServer: true, maxPayload: maxWebSocketBytes });
// 仅本机控制中心使用：agent 不再自己直连节点，而是连到这里，由本机 Node 进程（OpenSSL 栈）
// 代连节点的 /relay 并逐帧转发。部分网络链路会按 TLS ClientHello 特征重置握手，rustls 与
// schannel 都会被重置，只有 Node/OpenSSL 能稳定建立连接。
const relayBridge = new WebSocketServer({ noServer: true, maxPayload: maxWebSocketBytes });
const publicWebSockets = new WebSocketServer({
  noServer: true,
  maxPayload: maxWebSocketBytes,
  handleProtocols: (protocols) => protocols.values().next().value || false
});
const publicConnections = new Map<string, {
  socket: WebSocket;
  // 记录建立该连接时正在服务的 agent，连接被新 agent 接管后旧连接不得再影响这些会话。
  agentSocket: WebSocket;
  tunnelId: string;
  path: string;
  clientIp: string;
  startedAt: number;
  inbound: number;
  outbound: number;
}>();

function finishPublicWebSocket(id: string, status: number) {
  const connection = publicConnections.get(id);
  if (!connection || !publicConnections.delete(id)) return null;
  recordObservation(
    connection.tunnelId,
    connection.clientIp,
    "WS",
    connection.path,
    status,
    Date.now() - connection.startedAt,
    connection.inbound,
    connection.outbound
  );
  return connection;
}

function rawDataLength(data: WebSocket.RawData) {
  return Array.isArray(data)
    ? data.reduce((total, item) => total + item.length, 0)
    : Buffer.from(data as ArrayBuffer).length;
}

async function findTunnelByHost(headers: IncomingMessage["headers"]) {
  const hostCandidates = tunnelHostCandidates(headers);
  // 子域名固定为单标签（subdomainSchema 不允许点号），取候选 Host 的首段作为
  // domain 走索引查询，避免每个公网请求全表扫描 tunnels JOIN nodes。
  const domains = [...new Set(hostCandidates.map((host) => host.split(".")[0]).filter(Boolean))];
  if (!domains.length) return undefined;
  const rows = (await db
    .prepare(
      `SELECT t.id,t.domain,n.host FROM tunnels t JOIN nodes n ON n.id=t.node_id WHERE lower(t.domain) IN (${domains.map(() => "?").join(",")})`
    )
    .all(...domains)) as Array<{ id: string; domain: string; host: string }>;
  const matches = rows.filter((item) =>
    hostCandidates.includes(normalizeHost(`${item.domain}.${item.host}`))
  );
  if (matches.length <= 1) return matches[0];
  // 同域名存在多条记录（如历史残留）时，优先路由到 agent 实际在线的隧道。
  return (
    matches.find(
      (item) => agents.get(item.id)?.readyState === WebSocket.OPEN
    ) || matches[0]
  );
}

// WebSocket 升级路径先于任何鉴权，且由裸 async 回调处理；这里必须保证
// 解析「畸形 Host / URL 编码」不会抛出未捕获异常打挂整个进程。
function parseUpgradeTarget(request: IncomingMessage): URL | null {
  const host = normalizeHost(request.headers.host);
  // normalizeHost 会剥掉端口与端口分隔符，重建 Host 前先确认是合法主机名/IP。
  if (host && !/^[a-z0-9.-]+$|^\[[0-9a-f:]+\]$/.test(host)) return null;
  try {
    return new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  } catch { return null; }
}
async function resolvePublicWebSocket(request: IncomingMessage) {
  const parsed = parseUpgradeTarget(request);
  if (!parsed) return null;
  const publicMatch = parsed.pathname.match(/^\/public\/([^/]+)(\/.*)?$/);
  if (publicMatch) {
    // decodeURIComponent 对 "%zz" 这类非法序列会抛 URIError。
    let tunnelId: string;
    try { tunnelId = decodeURIComponent(publicMatch[1]); } catch { return null; }
    const path = safeForwardPath(`${publicMatch[2] || "/"}${parsed.search}`);
    return path ? { tunnelId, path } : null;
  }
  const tunnel = (await findTunnelByHost(request.headers));
  if (!tunnel) return null;
  const path = safeForwardPath(request.url);
  return path ? { tunnelId: tunnel.id, path } : null;
}

function rejectWebSocketUpgrade(socket: Duplex, status: number, message: string) {
  const body = Buffer.from(message);
  socket.end(
    `HTTP/1.1 ${status} ${status === 404 ? "Not Found" : "Service Unavailable"}\r\n` +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${message}`
  );
}

function websocketTarget(upstream: string, requestUrl: string) {
  // 与 HTTP 转发同样的约束：路径必须以单个 / 开头，否则会被当作新主机而绕过上游绑定。
  const path = safeForwardPath(requestUrl);
  if (!path) return null;
  const parsed = new URL(upstream.replace(/^http:/, "ws:").replace(/^https:/, "wss:"));
  return new URL(path, `${parsed.protocol}//${parsed.host}`).toString();
}

function bridgeWebSockets(left: WebSocket, right: WebSocket) {
  const pending: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
  left.on("message", (data, isBinary) => {
    if (right.readyState === WebSocket.OPEN) right.send(data, { binary: isBinary });
    else if (right.readyState === WebSocket.CONNECTING) pending.push({ data, isBinary });
  });
  right.on("open", () => {
    for (const message of pending.splice(0)) right.send(message.data, { binary: message.isBinary });
  });
  right.on("message", (data, isBinary) => {
    if (left.readyState === WebSocket.OPEN) left.send(data, { binary: isBinary });
  });
  const close = () => {
    if (left.readyState < WebSocket.CLOSING) left.close();
    if (right.readyState < WebSocket.CLOSING) right.close();
  };
  // 关闭码必须透传：上游用 1008 表示凭据失效或连接已被新 agent 接管。若这里退化成无码关闭，
  // agent 只会看到 1005 并当成普通断线无限重连，既掩盖了真实原因，又会和新连接互相顶替形成抖动。
  const relayClose = (from: WebSocket, to: WebSocket) => (code: number, reason: Buffer) => {
    if (from.readyState < WebSocket.CLOSING) from.close();
    // 1005/1006 是本地生成的伪码，不允许出现在关闭帧中。
    if (code === 1005 || code === 1006 || to.readyState >= WebSocket.CLOSING) return;
    const text = reason?.length ? reason.toString().slice(0, 120) : undefined;
    to.close(code, text);
  };
  left.on("close", relayClose(left, right));
  right.on("close", relayClose(right, left));
  left.on("error", close);
  right.on("error", close);
}

function proxyWebSocketToUpstream(request: IncomingMessage, socket: Duplex, head: Buffer, upstream: string) {
  const target = websocketTarget(upstream, request.url || "/");
  if (!target) return rejectWebSocketUpgrade(socket, 400, "非法的转发路径");
  publicWebSockets.handleUpgrade(request, socket, head, (browserSocket) => {
    const protocols = String(request.headers["sec-websocket-protocol"] || "")
      .split(",").map((value) => value.trim()).filter(Boolean);
    const headers = sanitizeForwardedWebSocketHeaders(request.headers);
    delete headers["sec-websocket-protocol"];
    headers["x-forwarded-host"] = request.headers.host || "";
    const upstreamSocket = new WebSocket(target, protocols, { headers });
    bridgeWebSockets(browserSocket, upstreamSocket);
  });
}

async function handlePublicWebSocketUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
  const upstream = process.env.RELAY_UPSTREAM ||
    process.env.HTTP_UPSTREAM?.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  if (upstream) return proxyWebSocketToUpstream(request, socket, head, upstream);
  const resolved = (await resolvePublicWebSocket(request));
  if (!resolved) return rejectWebSocketUpgrade(socket, 404, "未找到该域名对应的隧道");
  const agent = agents.get(resolved.tunnelId);
  if (!agent || agent.readyState !== WebSocket.OPEN) {
    return rejectWebSocketUpgrade(socket, 503, "agent 未连接");
  }
  publicWebSockets.handleUpgrade(request, socket, head, (browserSocket) => {
    const id = randomUUID();
    const connection = {
      socket: browserSocket,
      agentSocket: agent,
      tunnelId: resolved.tunnelId,
      path: resolved.path,
      clientIp: resolveClientIp(request.headers, request.socket.remoteAddress || undefined, trustProxyHeaders),
      startedAt: Date.now(),
      inbound: 0,
      outbound: 0
    };
    publicConnections.set(id, connection);
    const headers = sanitizeForwardedWebSocketHeaders(request.headers);
    headers["x-forwarded-host"] = request.headers.host || "";
    // 按实际连接协议下发，而不是写死 https：本地 http 部署下目标服务会收到错误的协议标识。
    const socketEncrypted = (request.socket as import("node:tls").TLSSocket).encrypted === true;
    headers["x-forwarded-proto"] = trustProxyHeaders
      ? String(request.headers["x-forwarded-proto"] || (socketEncrypted ? "https" : "http"))
      : (socketEncrypted ? "https" : "http");
    headers["x-forwarded-for"] = request.socket.remoteAddress || "";
    agent.send(JSON.stringify({ type: "ws-open", id, path: resolved.path, headers }));
    browserSocket.on("message", (data, isBinary) => {
      if (agent.readyState === WebSocket.OPEN) {
        connection.outbound += rawDataLength(data);
        agent.send(JSON.stringify({
          type: "ws-data",
          id,
          binary: isBinary,
          data: Buffer.from(data as Buffer).toString("base64")
        }));
      }
    });
    browserSocket.on("close", (code, reason) => {
      if (!finishPublicWebSocket(id, 101) || agent.readyState !== WebSocket.OPEN) return;
      agent.send(JSON.stringify({ type: "ws-close", id, code, reason: reason.toString() }));
    });
    browserSocket.on("error", () => browserSocket.close());
  });
}

httpServer.on("upgrade", async (request, socket, head) => {
  // 该回调在鉴权之前执行，任何异常都会变成未捕获异常并结束进程；
  // 攻击者只需一个带非法 Host 或非法编码路径的升级请求即可打挂服务，因此整体兜底。
  try {
    const parsed = parseUpgradeTarget(request);
    if (!parsed) return rejectWebSocketUpgrade(socket, 400, "请求地址无效");
    if (parsed.pathname === "/relay-bridge" && !isNodeController) {
      relayBridge.handleUpgrade(request, socket, head, (webSocket) => relayBridge.emit("connection", webSocket, request));
    } else if (parsed.pathname === "/relay") {
      relay.handleUpgrade(request, socket, head, (webSocket) => relay.emit("connection", webSocket, request));
    } else {
      await handlePublicWebSocketUpgrade(request, socket, head);
    }
  } catch (error) {
    console.warn("[upgrade] 处理升级请求失败", error instanceof Error ? error.message : error);
    if (!socket.destroyed) rejectWebSocketUpgrade(socket, 503, "服务暂时不可用");
  }
});

// 本机控制中心把 agent 的 relay 连接转由 Node 进程发起到节点：上游地址取自该隧道所属节点，
// token 鉴权仍由节点 relay 完成，本机只做透明转发（校验 token 只为尽早拒绝无效连接）。
relayBridge.on("connection", async (socket, request) => {
  const query = new URL(request.url || "", `http://${request.headers.host}`).searchParams;
  const tunnelId = query.get("tunnel");
  const headerToken = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const token = headerToken || query.get("token");
  const row = tunnelId && token
    ? (await db
        .prepare("SELECT n.controller_url FROM tunnels t JOIN nodes n ON n.id=t.node_id WHERE t.id=? AND t.agent_token=?")
        .get(tunnelId, token)) as { controller_url: string | null } | undefined
    : undefined;
  if (!row?.controller_url) return socket.close(1008, "invalid token");
  const upstream = row.controller_url.replace(/^http/, "ws").replace(/\/api\/?$/, "/relay");
  const target = `${upstream}?tunnel=${encodeURIComponent(tunnelId!)}&token=${encodeURIComponent(token!)}`;
  const bridge = new WebSocket(target, { headers: { authorization: `Bearer ${token}` } });
  bridgeWebSockets(socket, bridge);
});

relay.on("connection", async (socket, request) => {
  const upstream = process.env.RELAY_UPSTREAM;
  if (upstream) {
    const target = `${upstream.replace(/\/$/, "")}${request.url || ""}`;
    const bridge = new WebSocket(target);
    // 桥接链路必须保持 Relay 原始消息协议，不能注入状态消息。
    bridge.on("message", (data, isBinary) => { if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary: isBinary }); });
    socket.on("message", (data, isBinary) => { if (bridge.readyState === WebSocket.OPEN) bridge.send(data, { binary: isBinary }); });
    const close = () => { try { socket.close(); } catch {} try { bridge.close(); } catch {} };
    bridge.on("close", close); bridge.on("error", close); socket.on("close", () => { try { bridge.close(); } catch {} });
    return;
  }
  const query = new URL(request.url || "", `http://${request.headers.host}`)
    .searchParams;
  const tunnelId = query.get("tunnel");
  // 优先使用 Authorization 头，避免 token 出现在 URL 中被中间代理记录；保留
  // query 参数用于兼容旧版 agent。
  const headerToken = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const token = headerToken || query.get("token");
  const row = tunnelId
    ? (await db
        .prepare("SELECT id FROM tunnels WHERE id=? AND agent_token=?")
        .get(tunnelId, token))
    : null;
  if (!row || !tunnelId) return socket.close(1008, "invalid token");
  // 同一隧道重新连入时必须关掉旧连接：否则旧 socket 会一直占着 TCP 且再也收不到流量，
  // 成为既不发消息也不断开、还让隧道状态错乱的僵尸连接。
  const previousAgent = agents.get(tunnelId);
  agents.set(tunnelId, socket);
  if (previousAgent && previousAgent !== socket && previousAgent.readyState < WebSocket.CLOSING) {
    previousAgent.close(1008, "replaced by a newer agent connection");
  }
  (await db.prepare("UPDATE tunnels SET status='running' WHERE id=?").run(tunnelId));
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === "ws-data" || message.type === "ws-close") {
        const connection = publicConnections.get(message.id);
        if (!connection) return;
        // 只接受当前正在服务该隧道的 agent 发来的帧，避免被接管后的旧连接继续操作会话。
        if (connection.agentSocket !== socket) return;
        if (message.type === "ws-data" && connection.socket.readyState === WebSocket.OPEN) {
          connection.inbound += Buffer.from(message.data || "", "base64").length;
          connection.socket.send(Buffer.from(message.data || "", "base64"), { binary: Boolean(message.binary) });
        } else if (message.type === "ws-close") {
          finishPublicWebSocket(message.id, 101);
          connection.socket.close(Number(message.code) || 1011, String(message.reason || ""));
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: "ws-close",
              id: message.id,
              code: Number(message.code) || 1011,
              reason: String(message.reason || "")
            }));
          }
        }
        return;
      }
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    } catch (error) {
      console.warn("[relay] 无法处理 agent 消息", error);
    }
  });
  socket.on("close", async () => {
    const isCurrentAgent = agents.get(tunnelId) === socket;
    if (isCurrentAgent) agents.delete(tunnelId);
    // 只结束属于这条连接的会话；已被新 agent 接管的旧连接不得影响新会话。
    for (const [id, connection] of publicConnections) {
      if (connection.tunnelId !== tunnelId || connection.agentSocket !== socket) continue;
      finishPublicWebSocket(id, 503);
      connection.socket.close(1012, "agent disconnected");
    }
    // 仅当断开的是当前在服务的 agent 时才把隧道标记为已停止，避免误停正在服务的新连接。
    if (isCurrentAgent) {
      (await db.prepare(
        "UPDATE tunnels SET status='stopped' WHERE id=? AND status='running'"
      ).run(tunnelId));
    }
  });
});
function forwardToAgent(
  tunnelId: string,
  forwardedPath: string,
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const socket = agents.get(tunnelId);
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    recordObservation(tunnelId, clientIp(req), req.method, forwardedPath, 503, 0, 0, 0);
    return res.status(503).json({ message: "agent 未连接" });
  }
  // 双层限制：单隧道上限防止某条慢/挂死的 agent 占满全局额度拖垮其他用户，
  // 全局上限控制整进程内存峰值。
  const perTunnel = inflightByTunnel.get(tunnelId) || 0;
  if (perTunnel >= maxInflightPerTunnel || inflightRequests >= maxInflightRequests) {
    recordObservation(tunnelId, clientIp(req), req.method, forwardedPath, 503, 0, 0, 0);
    return res.status(503).json({ message: "该隧道转发并发已达上限，请稍后重试" });
  }
  inflightRequests += 1;
  inflightByTunnel.set(tunnelId, perTunnel + 1);
  let released = false;
  const releaseInflight = () => {
    if (released) return;
    released = true;
    inflightRequests -= 1;
    const remaining = (inflightByTunnel.get(tunnelId) || 1) - 1;
    // 计数归零时移除键，避免隧道数量增长后 Map 无限膨胀。
    if (remaining > 0) inflightByTunnel.set(tunnelId, remaining);
    else inflightByTunnel.delete(tunnelId);
  };
  // 响应结束或客户端断开都必须归还配额，否则并发上限会被逐步占满。
  res.on("close", releaseInflight);
  res.on("finish", releaseInflight);
  const id = randomUUID(),
    chunks: Buffer[] = [],
    startedAt = Date.now();
  let requestBytes = 0;
  let oversized = false;
  req.on("data", (chunk) => {
    if (oversized) return;
    requestBytes += chunk.length;
    if (requestBytes > maxBodyBytes) {
      oversized = true;
      recordObservation(tunnelId, clientIp(req), req.method, forwardedPath, 413, Date.now() - startedAt, 0, requestBytes);
      res.status(413).json({ message: `请求体超过 ${Math.round(maxBodyBytes / 1048576)}MB 上限` });
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  req.on("end", () => {
    if (oversized) return;
    const timer = setTimeout(() => {
      if (pending.delete(id) && !res.headersSent) {
        recordObservation(tunnelId, clientIp(req), req.method, forwardedPath, 504, Date.now() - startedAt, 0, Buffer.concat(chunks).length);
        res.status(504).json({ message: "agent 响应超时" });
      }
    }, 30000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      const status = Number(message.status) || 502,
        responseBody = Buffer.from(message.body || "", "base64"),
        requestBytes = Buffer.concat(chunks).length;
      recordObservation(tunnelId, clientIp(req), req.method, forwardedPath, status, Date.now() - startedAt, responseBody.length, requestBytes);
      res.status(status);
      for (const [key, value] of Object.entries(message.headers || {})) {
        const normalizedKey = key.toLowerCase();
        if (hopByHopHeaders.has(normalizedKey) || normalizedKey === "content-length") continue;
        const values = (Array.isArray(value) ? value : [value]).filter(
          (item): item is string => typeof item === "string"
        );
        if (!values.length) continue;
        // 目标服务可能返回仅允许 localhost 的 CORS 头，经过隧道后应匹配当前公网来源。
        if (normalizedKey === "access-control-allow-origin" && req.headers.origin) {
          res.setHeader(key, req.headers.origin);
        } else if (normalizedKey === "set-cookie") {
          // 本地服务常把 Cookie 绑定到 localhost；移除该 Domain 后，浏览器会自动绑定当前隧道域名。
          res.setHeader(key, values.map(normalizeLocalCookieDomain));
        } else if (normalizedKey === "permissions-policy") {
          const policy = normalizePermissionsPolicy(values.join(","));
          if (policy) res.setHeader(key, policy);
        } else {
          res.setHeader(key, values.length === 1 ? values[0] : values);
        }
      }
      applyPublicCors(req, res);
      res.end(responseBody);
    });
    // 浏览器访问隧道域名时会携带该公网域名的 Origin。直接转发会触发
    // Vite/后端的跨域白名单校验；隧道本身已经是同源代理，因此清理跨域
    // 标识，让本地服务按普通同源请求处理。
    const forwardedHeaders = sanitizeForwardedRequestHeaders(req.headers);
    forwardedHeaders["x-forwarded-host"] = req.headers.host || "";
    forwardedHeaders["x-forwarded-proto"] = req.protocol;
    forwardedHeaders["x-forwarded-for"] = req.ip || "";
    socket.send(
      JSON.stringify({
        id,
        method: req.method,
        path: forwardedPath,
        headers: forwardedHeaders,
        body: Buffer.concat(chunks).toString("base64")
      })
    );
  });
  req.on("error", next);
}

function requestBody(req: express.Request): Promise<Buffer> {
  if (req.readableEnded) {
    if (req.body === undefined) return Promise.resolve(Buffer.alloc(0));
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
    if (typeof req.body === "string") return Promise.resolve(Buffer.from(req.body));
    return Promise.resolve(Buffer.from(JSON.stringify(req.body)));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function proxyHttpToUpstream(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
  upstream: string,
  forwardedPath: string
) {
  try {
    const safePath = safeForwardPath(forwardedPath);
    if (!safePath) return res.status(400).json({ message: "非法的转发路径" });
    const target = `${upstream.replace(/\/$/, "")}${safePath}`;
    const headers = new Headers(req.headers as HeadersInit);
    for (const name of [...hopByHopHeaders, "host", "content-length", "origin", "referer"]) headers.delete(name);
    headers.set("x-forwarded-host", req.headers.host || "");
    headers.set("x-forwarded-proto", req.protocol);
    headers.set("x-forwarded-for", req.ip || "");
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : await requestBody(req);
    const response = await fetch(target, { method: req.method, headers, body });
    res.status(response.status);
    response.headers.forEach((value, key) => {
      const normalizedKey = key.toLowerCase();
      if (hopByHopHeaders.has(normalizedKey) || normalizedKey === "content-length" || normalizedKey === "set-cookie") return;
      if (normalizedKey === "permissions-policy") {
        const policy = normalizePermissionsPolicy(value);
        if (policy) res.setHeader(key, policy);
      } else if (normalizedKey === "access-control-allow-origin" && req.headers.origin) {
        res.setHeader(key, req.headers.origin);
      } else res.setHeader(key, value);
    });
    const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
    if (cookies?.length) res.setHeader("set-cookie", cookies.map(normalizeLocalCookieDomain));
    applyPublicCors(req, res);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    next(error);
  }
}

function forwardPublicHttp(
  tunnelId: string,
  forwardedPath: string,
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  // 所有公网转发的统一入口，再校验一次路径，作为分发层之外的纵深防御。
  const safePath = safeForwardPath(forwardedPath);
  if (!safePath) return res.status(400).json({ message: "非法的转发路径" });
  const upstream = process.env.HTTP_UPSTREAM;
  if (upstream) return proxyHttpToUpstream(req, res, next, upstream, safePath);
  return forwardToAgent(tunnelId, safePath, req, res, next);
}

app.use("/public/:tunnelId", (req, res, next) => {
  const path =
    req.originalUrl.replace(`/public/${req.params.tunnelId}`, "") || "/";
  const safePath = safeForwardPath(path);
  if (!safePath) return res.status(400).json({ message: "非法的转发路径" });
  return forwardToAgent(req.params.tunnelId, safePath, req, res, next);
});
app.use(async (req, res, next) => {
  const upstream = process.env.HTTP_UPSTREAM;
  if (upstream) return proxyHttpToUpstream(req, res, next, upstream, req.originalUrl || "/");
  const matchedTunnel = (await findTunnelByHost(req.headers));
  if (!matchedTunnel)
    return res.status(404).json({ message: "未找到该域名对应的隧道" });
  const safePath = safeForwardPath(req.originalUrl);
  if (!safePath) return res.status(400).json({ message: "非法的转发路径" });
  return forwardToAgent(matchedTunnel.id, safePath, req, res, next);
});
const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof z.ZodError)
    return res
      .status(400)
      .json({ message: "请求参数无效", issues: error.issues });
  if (error?.code === "ER_DUP_ENTRY" || error?.code?.startsWith("SQLITE_CONSTRAINT_UNIQUE") || /UNIQUE constraint failed/.test(error?.message || ""))
    return res.status(409).json({ message: "用户名或子域名已存在，请更换后重试" });
  console.error(error);
  res.status(500).json({ message: "服务暂时不可用" });
};
app.use(errorHandler);
// 访问日志与流量记录只写不删会让数据库无限膨胀；启动时和每小时清理过期数据。
async function pruneRetention() {
  try {
    (await pruneOldData());
  } catch (error) {
    console.warn("[retention] 清理过期记录失败", error);
  }
}
(await pruneRetention());
setInterval(pruneRetention, 60 * 60 * 1000);
// 兜底防线：主控、边缘节点与桌面内置控制中心共用这份代码，任何一处未捕获的
// 异步异常都会让 Node 直接退出（远程即可造成服务不可用），因此只记录不退出。
process.on("unhandledRejection", (reason) =>
  console.error("[unhandledRejection]", reason instanceof Error ? reason.stack || reason.message : reason));
process.on("uncaughtException", (error) =>
  console.error("[uncaughtException]", error instanceof Error ? error.stack || error.message : error));
httpServer.listen(port, bindHost, () =>
  console.log(`Nexious API listening on http://${bindHost}:${port}`)
);
