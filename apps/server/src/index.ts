import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { db, tunnelRows } from "./db.js";
import { deployNode, inspectNode } from "./nodeDeployment.js";
import {
  hopByHopHeaders,
  normalizeLocalCookieDomain,
  normalizePermissionsPolicy,
  sanitizeForwardedRequestHeaders,
  sanitizeForwardedWebSocketHeaders
} from "./proxyHeaders.js";

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
app.use(
  cors({
    origin: (origin, callback) =>
      callback(null, !origin || allowedOrigins.has(origin))
  })
);
// 公网隧道域名可能包含 `/api/*` 路径，必须先按 Host 分流，避免被控制中心鉴权拦截。
// 此处位于 body parser 之前，以便 POST/PUT 请求可以原样转发。
app.use((req, res, next) => {
  const publicMatch = req.originalUrl.match(/^\/public\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (publicMatch) {
    const tunnelId = decodeURIComponent(publicMatch[1]);
    const forwardedPath = `${publicMatch[2] || "/"}${publicMatch[3] || ""}`;
    return forwardPublicHttp(tunnelId, forwardedPath, req, res, next);
  }
  const tunnel = findTunnelByHost(req.headers);
  if (!tunnel) return next();
  return forwardPublicHttp(tunnel.id, req.originalUrl || "/", req, res, next);
});
app.use(express.json({ limit: "2mb" }));
app.use("/api", (req, res, next) => {
  if (req.path === "/health" || !process.env.NEXIOUS_ADMIN_TOKEN) return next();
  if (req.headers.authorization !== `Bearer ${process.env.NEXIOUS_ADMIN_TOKEN}`)
    return res.status(401).json({ message: "控制中心认证失败" });
  next();
});
const agents = new Map<string, WebSocket>();
db.prepare("UPDATE nodes SET controller_url=replace(controller_url, ':8789/api', ':8788/api') WHERE controller_url LIKE '%:8789/api%'").run();
const pending = new Map<string, (payload: any) => void>();
db.prepare("UPDATE tunnels SET status='stopped' WHERE status='running'").run();

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
type DeployJob={id:string;nodeId:string;status:"running"|"success"|"error";logs:Array<{time:string;message:string}>;result?:unknown;error?:string};
const deployJobs=new Map<string,DeployJob>();
const appendJobLog=(job:DeployJob,message:string)=>job.logs.push({time:new Date().toISOString(),message});
let lastNodeHealthRefresh=0;
async function refreshNodeHealth(){
  if(Date.now()-lastNodeHealthRefresh<10_000)return;
  lastNodeHealthRefresh=Date.now();
  const nodes=db.prepare("SELECT id,controller_url,controller_token,deploy_status FROM nodes").all() as Array<{id:string;controller_url:string|null;controller_token:string|null;deploy_status:string}>;
  await Promise.all(nodes.map(async node=>{
    if(!node.controller_url||!node.controller_token||node.deploy_status!=="ready"){
      db.prepare("UPDATE nodes SET status='maintenance' WHERE id=?").run(node.id);return;
    }
    try{
      const response=await fetch(`${node.controller_url.replace(/\/api\/?$/,"")}/api/health`,{headers:{Authorization:`Bearer ${node.controller_token}`},signal:AbortSignal.timeout(4000)});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const value=await response.json() as {ok?:boolean};if(!value.ok)throw new Error("健康检查未通过");
      db.prepare("UPDATE nodes SET status='online',last_checked_at=?,last_error=NULL WHERE id=?").run(new Date().toISOString(),node.id);
    }catch(error){
      db.prepare("UPDATE nodes SET status='maintenance',last_checked_at=?,last_error=? WHERE id=?").run(new Date().toISOString(),error instanceof Error?error.message:"节点不可达",node.id);
    }
  }));
}

function domainIsOccupied(
  nodeId: string,
  domain: string | null | undefined,
  excludedId?: string
) {
  if (!domain) return false;
  const row = db
    .prepare(
      `SELECT id FROM tunnels WHERE node_id=? AND lower(domain)=? AND (? IS NULL OR id!=?)`
    )
    .get(nodeId, domain.toLowerCase(), excludedId || null, excludedId || null);
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

function clientIp(req: express.Request) {
  const cloudflare = req.headers["cf-connecting-ip"];
  const realIp = req.headers["x-real-ip"];
  return String(cloudflare || realIp || req.ip || "unknown").split(",")[0].trim();
}

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
  db.prepare(
    "INSERT INTO access_logs (tunnel_id,timestamp,client_ip,method,path,status,duration,bytes) VALUES (?,?,?,?,?,?,?,?)"
  ).run(tunnelId, new Date().toISOString(), ip, method, path, status, duration, inbound + outbound);
  if (inbound || outbound) {
    db.prepare(
      `INSERT INTO traffic (tunnel_id,timestamp,inbound,outbound) VALUES (?,strftime('%Y-%m-%dT%H:00:00.000Z','now'),?,?)`
    ).run(tunnelId, inbound, outbound);
  }
}

function configuredNodeControllers() {
  if (isNodeController) return [];
  return db.prepare(
    "SELECT id,controller_url,controller_token FROM nodes WHERE controller_url IS NOT NULL AND controller_token IS NOT NULL AND deploy_status='ready'"
  ).all() as Array<{ id: string; controller_url: string; controller_token: string }>;
}

async function fetchNodeJson<T>(
  node: { controller_url: string; controller_token: string },
  path: string
): Promise<T> {
  const base = node.controller_url.replace(/\/api\/?$/, "").replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${node.controller_token}` },
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, version: "1.0.0", time: new Date().toISOString() })
);
app.get("/api/dashboard", async (_req, res) => {
  const tunnels = tunnelRows() as Array<Record<string, unknown>>;
  const localTotals = db
    .prepare(
      "SELECT COALESCE(SUM(inbound),0) inbound, COALESCE(SUM(outbound),0) outbound FROM traffic WHERE datetime(timestamp) > datetime('now','-24 hours')"
    )
    .get() as { inbound: number; outbound: number };
  const localSeries = db
    .prepare(
      `SELECT timestamp, SUM(inbound) inbound, SUM(outbound) outbound FROM traffic WHERE datetime(timestamp) > datetime('now','-24 hours') GROUP BY timestamp ORDER BY timestamp`
    )
    .all() as TrafficPoint[];
  const nodeResults = await Promise.allSettled(
    configuredNodeControllers().map((node) =>
      fetchNodeJson<{ totals: { inbound: number; outbound: number }; series: TrafficPoint[] }>(node, "/api/dashboard")
    )
  );
  const totals = { ...localTotals };
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
    db
      .prepare("SELECT COUNT(*) count FROM nodes WHERE status='online'")
      .get() as { count: number }
  ).count;
  res.json({
    tunnels,
    totals,
    series,
    onlineNodes: nodeCount,
    activeTunnels: tunnels.filter((t) => t.status === "running").length
  });
});
app.get("/api/tunnels", (_req, res) => res.json(tunnelRows()));
async function syncTunnelToNode(tunnelId: string, action: "upsert" | "delete"): Promise<string | null> {
  const row = (tunnelRows() as Array<Record<string, any>>).find((item) => item.id === tunnelId);
  if (!row?.controller_url || !row.controller_token) return "节点控制器未配置";
  const base = row.controller_url.replace(/\/api\/?$/, "").replace(/:8789$/, ":8788");
  const endpoint = `${base}/internal/tunnels/sync`;
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${row.controller_token}` }, body: JSON.stringify({ action, tunnel: row }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`节点同步失败 HTTP ${response.status}`);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[tunnel-sync] ${tunnelId}: ${message}`);
    return message;
  }
}
async function syncNodeTunnels(nodeId: string) {
  const rows = (tunnelRows() as Array<Record<string, any>>).filter((row) => row.node_id === nodeId);
  const errors: Array<{ tunnelId: string; message: string }> = [];
  for (const row of rows) {
    const message = await syncTunnelToNode(row.id, "upsert");
    if (message) errors.push({ tunnelId: row.id, message });
  }
  return { total: rows.length, success: rows.length - errors.length, failed: errors.length, errors };
}
async function syncAllTunnels() {
  for (const row of tunnelRows() as Array<Record<string, any>>) {
    await syncTunnelToNode(row.id, "upsert");
  }
}
setTimeout(() => { void syncAllTunnels(); }, 1500);
setInterval(() => { void syncAllTunnels(); }, 30_000);
app.post("/internal/tunnels/sync", (req, res) => {
  if (process.env.NEXIOUS_ADMIN_TOKEN && req.headers.authorization !== `Bearer ${process.env.NEXIOUS_ADMIN_TOKEN}`) return res.status(401).json({ message: "节点同步认证失败" });
  const body = z.object({ action: z.enum(["upsert", "delete"]), tunnel: z.record(z.any()) }).parse(req.body);
  if (body.action === "delete") db.prepare("DELETE FROM tunnels WHERE id=?").run(body.tunnel.id);
  else {
    // 节点控制器使用与主控相同的查询结构，需要先建立对应的本地节点记录。
    // 主控同步的 node_id/node_host 是可信配置数据；缺失时使用稳定的本地 ID，避免 NOT NULL 约束导致整条隧道丢失。
    const nodeId = String(body.tunnel.node_id || "node-local");
    const nodeHost = String(body.tunnel.node_host || "localhost");
    db.prepare("INSERT OR IGNORE INTO nodes (id,name,region,city,latency,load,status,host) VALUES (?,?,?,?,?,?,?,?)")
      .run(nodeId, String(body.tunnel.node_name || nodeId), "默认", "默认", 0, 0, "online", nodeHost);
    db.prepare("UPDATE nodes SET host=?,status='online' WHERE id=?").run(nodeHost, nodeId);
    db.prepare(`INSERT INTO tunnels (id,name,protocol,local_host,local_port,remote_port,node_id,status,domain,created_at,agent_token,auto_start)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        protocol=excluded.protocol,
        local_host=excluded.local_host,
        local_port=excluded.local_port,
        remote_port=excluded.remote_port,
        node_id=excluded.node_id,
        status=excluded.status,
        domain=excluded.domain,
        agent_token=excluded.agent_token,
        auto_start=excluded.auto_start`)
      .run(body.tunnel.id, body.tunnel.name, body.tunnel.protocol, body.tunnel.local_host, body.tunnel.local_port, body.tunnel.remote_port, nodeId, body.tunnel.status || "stopped", body.tunnel.domain, body.tunnel.created_at || new Date().toISOString(), body.tunnel.agent_token || null, body.tunnel.auto_start || 0);
  }
  res.json({ ok: true });
});
app.post("/api/tunnels/:id/token", (req, res) => {
  const tunnel = (tunnelRows() as Array<{ id: string;node_host?:string;controller_url?:string }>).find(
    (row) => row.id === req.params.id
  );
  if (!tunnel) return res.status(404).json({ message: "隧道不存在" });
  const token = randomUUID().replaceAll("-", "");
  db.prepare("UPDATE tunnels SET agent_token=? WHERE id=?").run(
    token,
    req.params.id
  );
  void syncTunnelToNode(req.params.id, "upsert");
  const nodeRelay=tunnel.controller_url
    ? tunnel.controller_url.replace(/^http/,"ws").replace(/\/api\/?$/,"/relay")
    : null;
  res.json({
    token,
    tunnelId: req.params.id,
    relay: nodeRelay || `${process.env.RELAY_URL || "ws://127.0.0.1:8787"}/relay`
  });
});
app.post("/api/tunnels", (req, res) => {
  const value = tunnelSchema.parse(req.body);
  if (domainIsOccupied(value.nodeId, value.domain))
    return res.status(409).json({ message: "该节点上的子域名已被使用" });
  const id = `tun-${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO tunnels (id,name,protocol,local_host,local_port,remote_port,node_id,status,domain,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`
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
    new Date().toISOString()
  );
  void syncTunnelToNode(id, "upsert");
  res
    .status(201)
    .json(
      (tunnelRows() as Array<{ id: string }>).find((item) => item.id === id)
    );
});
app.put("/api/tunnels/:id", (req, res) => {
  const value = tunnelSchema.parse(req.body);
  if (domainIsOccupied(value.nodeId, value.domain, req.params.id))
    return res.status(409).json({ message: "该节点上的子域名已被使用" });
  const result = db
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
  if (!result.changes) return res.status(404).json({ message: "隧道不存在" });
  void syncTunnelToNode(req.params.id, "upsert");
  res.json(
    (tunnelRows() as Array<{ id: string }>).find(
      (item) => item.id === req.params.id
    )
  );
});
app.patch("/api/tunnels/:id/status", (req, res) => {
  const { status } = z
    .object({ status: z.enum(["running", "stopped"]) })
    .parse(req.body);
  const result =
    status === "stopped"
      ? db
          .prepare(
            "UPDATE tunnels SET status='stopped',auto_start=0 WHERE id=?"
          )
          .run(req.params.id)
      : db
          .prepare("UPDATE tunnels SET status='running',auto_start=1 WHERE id=?")
          .run(req.params.id);
  if (!result.changes) return res.status(404).json({ message: "隧道不存在" });
  void syncTunnelToNode(req.params.id, "upsert");
  res.json({
    id: req.params.id,
    status,
    auto_start: status === "running" ? 1 : 0
  });
});
app.delete("/api/tunnels/:id", (req, res) => {
  const result = db
    .prepare("DELETE FROM tunnels WHERE id=?")
    .run(req.params.id);
  if (!result.changes) return res.status(404).json({ message: "隧道不存在" });
  void syncTunnelToNode(req.params.id, "delete");
  res.status(204).end();
});
app.get("/api/nodes", async (_req, res, next) => {
  try { await refreshNodeHealth(); res.json(
    db
      .prepare(`${nodeSelect} ORDER BY status,name`)
      .all()
  ); } catch(error){next(error)}
});
app.post("/api/nodes", (req, res) => {
  const value = nodeSchema.parse(req.body),
    id = `n-${randomUUID().slice(0, 8)}`;
  db.prepare(
    "INSERT INTO nodes (id,name,region,city,latency,load,status,host) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, value.name, "默认", "默认", 0, 0, "maintenance", value.host);
  res
    .status(201)
    .json(
      db.prepare(`${nodeSelect} WHERE id=?`).get(id)
    );
});
app.put("/api/nodes/:id", (req, res) => {
  const value = nodeSchema.parse(req.body);
  const result = db
    .prepare("UPDATE nodes SET name=?,host=? WHERE id=?")
    .run(value.name, value.host, req.params.id);
  if (!result.changes) return res.status(404).json({ message: "节点不存在" });
  res.json(
    db
      .prepare(`${nodeSelect} WHERE id=?`)
      .get(req.params.id)
  );
});
app.post("/api/nodes/:id/inspect", async (req, res, next) => {
  try {
    const value = serverSchema.parse(req.body);
    const [username, host] = value.connection.split("@");
    const node = db.prepare(`${nodeSelect} WHERE id=?`).get(req.params.id) as Record<string, string> | undefined;
    if (!node) return res.status(404).json({ message: "节点不存在" });
    const result = await inspectNode({ host, username, password: value.password, port: value.port }, node.controller_token);
    db.prepare("UPDATE nodes SET server_host=?,ssh_user=?,ssh_port=?,controller_url=COALESCE(?,controller_url),controller_token=COALESCE(?,controller_token),deploy_status=?,status=?,last_checked_at=?,last_error=? WHERE id=?")
      .run(host, username, value.port, result.controllerUrl||null, result.token||null, result.healthy ? "ready" : result.configured ? "error" : "unconfigured",result.healthy?"online":"maintenance", new Date().toISOString(), result.healthy ? null : result.message, req.params.id);
    res.json(result);
  } catch (error) { next(error); }
});
app.post("/api/nodes/:id/deploy", async (req, res, next) => {
  try {
    const value = serverSchema.parse(req.body);
    const [username, host] = value.connection.split("@");
    if (!db.prepare("SELECT id FROM nodes WHERE id=?").get(req.params.id)) return res.status(404).json({ message: "节点不存在" });
    db.prepare("UPDATE nodes SET server_host=?,ssh_user=?,ssh_port=?,deploy_status='deploying',last_error=NULL WHERE id=?")
      .run(host, username, value.port, req.params.id);
    const active=[...deployJobs.values()].find(job=>job.nodeId===req.params.id&&job.status==="running");
    if(active)return res.status(409).json({message:"该节点已有部署任务正在运行"});
    const job:DeployJob={id:randomUUID(),nodeId:req.params.id,status:"running",logs:[]};
    deployJobs.set(job.id,job);appendJobLog(job,"部署任务已创建");
    res.status(202).json({jobId:job.id});
    void (async()=>{try {
      const result = await deployNode({ host, username, password: value.password, port: value.port },message=>appendJobLog(job,message), value.force);
      db.prepare("UPDATE nodes SET controller_url=?,controller_token=?,deploy_status='ready',status='online',last_checked_at=?,last_error=NULL WHERE id=?")
        .run(result.controllerUrl, result.token, new Date().toISOString(), req.params.id);
      appendJobLog(job, "控制中心已就绪，开始立即同步该节点的隧道配置");
      const sync = await syncNodeTunnels(req.params.id);
      if (sync.failed) {
        const summary = `隧道同步完成：${sync.success}/${sync.total} 成功，${sync.failed} 失败`;
        appendJobLog(job, `警告：${summary}`);
        appendJobLog(job, sync.errors.map((item) => `${item.tunnelId}: ${item.message}`).join("；"));
        db.prepare("UPDATE nodes SET last_error=? WHERE id=?").run(summary, req.params.id);
      } else {
        appendJobLog(job, `隧道同步完成：${sync.success}/${sync.total} 成功`);
      }
      job.result={...result, sync};job.status="success";
    } catch (error) {
      const message = error instanceof Error ? error.message : "自动部署失败";
      appendJobLog(job,`部署失败：${message}`);job.error=message;job.status="error";
      db.prepare("UPDATE nodes SET deploy_status='error',last_checked_at=?,last_error=? WHERE id=?")
        .run(new Date().toISOString(), message.slice(0, 500), req.params.id);
    }})();
  } catch (error) { next(error); }
});
app.get("/api/deployments/:jobId",(req,res)=>{
  const job=deployJobs.get(req.params.jobId);if(!job)return res.status(404).json({message:"部署任务不存在或已过期"});
  const cursor=Math.max(0,Number(req.query.cursor)||0);
  res.json({jobId:job.id,status:job.status,logs:job.logs.slice(cursor),cursor:job.logs.length,result:job.result,error:job.error});
});
app.delete("/api/nodes/:id", (req, res) => {
  const used = db
    .prepare("SELECT COUNT(*) count FROM tunnels WHERE node_id=?")
    .get(req.params.id) as { count: number };
  if (used.count)
    return res
      .status(409)
      .json({ message: `该节点仍被 ${used.count} 条隧道使用，无法删除` });
  const result = db.prepare("DELETE FROM nodes WHERE id=?").run(req.params.id);
  if (!result.changes) return res.status(404).json({ message: "节点不存在" });
  res.status(204).end();
});
app.get("/api/logs", async (req, res) => {
  const query = z
    .object({
      tunnelId: z.string().optional(),
      search: z.string().trim().max(100).optional(),
      status: z.enum(["all", "success", "error"]).default("all"),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(10).max(5000).default(20)
    })
    .parse(req.query);
  // 仅记录用户访问，不记录前端构建产生的静态资源请求。
  const conditions: string[] = [
    "path NOT LIKE '/src/%'",
    "path NOT LIKE '/node_modules/%'",
    "path NOT LIKE '/@vite/%'",
    "path NOT LIKE '/favicon.ico%'"
  ];
  const values: unknown[] = [];
  if (query.tunnelId) {
    conditions.push("tunnel_id=?");
    values.push(query.tunnelId);
  }
  if (query.search) {
    conditions.push("(path LIKE ? OR client_ip LIKE ? OR method LIKE ?)");
    const term = `%${query.search}%`;
    values.push(term, term, term);
  }
  if (query.status === "success") conditions.push("status<400");
  if (query.status === "error") conditions.push("status>=400");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const localTotal = (
    db
      .prepare(`SELECT COUNT(*) count FROM access_logs ${where}`)
      .get(...values) as { count: number }
  ).count;
  const candidateLimit = Math.min(query.page * query.pageSize, 5000);
  const localItems = db
    .prepare(
      `SELECT * FROM access_logs ${where} ORDER BY timestamp DESC LIMIT ?`
    )
    .all(...values, candidateLimit) as AccessLogRow[];
  const nodeQuery = new URLSearchParams({ page: "1", pageSize: String(candidateLimit), status: query.status });
  if (query.tunnelId) nodeQuery.set("tunnelId", query.tunnelId);
  if (query.search) nodeQuery.set("search", query.search);
  const nodeResults = await Promise.allSettled(
    configuredNodeControllers().map((node) =>
      fetchNodeJson<{ items: AccessLogRow[]; total: number }>(node, `/api/logs?${nodeQuery}`)
    )
  );
  let total = localTotal;
  const candidates = [...localItems];
  for (const result of nodeResults) {
    if (result.status !== "fulfilled") continue;
    total += Number(result.value.total) || 0;
    candidates.push(...(result.value.items || []));
  }
  candidates.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  const offset = (query.page - 1) * query.pageSize;
  const items = candidates.slice(offset, offset + query.pageSize);
  res.json({ items, total, page: query.page, pageSize: query.pageSize });
});
const relay = new WebSocketServer({ noServer: true });
const publicWebSockets = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols) => protocols.values().next().value || false
});
const publicConnections = new Map<string, {
  socket: WebSocket;
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

function normalizeHost(value: unknown) {
  return String(value || "").split(",")[0].trim().split(":")[0].replace(/\.$/, "").toLowerCase();
}

function findTunnelByHost(headers: IncomingMessage["headers"]) {
  const hostCandidates = [headers["x-forwarded-host"], headers.host]
    .map(normalizeHost)
    .filter(Boolean);
  const tunnels = db
    .prepare("SELECT t.id,t.domain,n.host FROM tunnels t JOIN nodes n ON n.id=t.node_id")
    .all() as Array<{ id: string; domain: string; host: string }>;
  return tunnels.find((item) =>
    hostCandidates.includes(normalizeHost(`${item.domain}.${item.host}`))
  );
}

function resolvePublicWebSocket(request: IncomingMessage) {
  const parsed = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const publicMatch = parsed.pathname.match(/^\/public\/([^/]+)(\/.*)?$/);
  if (publicMatch) {
    const path = `${publicMatch[2] || "/"}${parsed.search}`;
    return { tunnelId: decodeURIComponent(publicMatch[1]), path };
  }
  const tunnel = findTunnelByHost(request.headers);
  return tunnel ? { tunnelId: tunnel.id, path: request.url || "/" } : null;
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
  const parsed = new URL(upstream.replace(/^http:/, "ws:").replace(/^https:/, "wss:"));
  return new URL(requestUrl, `${parsed.protocol}//${parsed.host}`).toString();
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
  left.on("close", close);
  left.on("error", close);
  right.on("close", close);
  right.on("error", close);
}

function proxyWebSocketToUpstream(request: IncomingMessage, socket: Duplex, head: Buffer, upstream: string) {
  publicWebSockets.handleUpgrade(request, socket, head, (browserSocket) => {
    const protocols = String(request.headers["sec-websocket-protocol"] || "")
      .split(",").map((value) => value.trim()).filter(Boolean);
    const headers = sanitizeForwardedWebSocketHeaders(request.headers);
    delete headers["sec-websocket-protocol"];
    headers["x-forwarded-host"] = request.headers.host || "";
    const upstreamSocket = new WebSocket(
      websocketTarget(upstream, request.url || "/"),
      protocols,
      { headers }
    );
    bridgeWebSockets(browserSocket, upstreamSocket);
  });
}

function handlePublicWebSocketUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
  const upstream = process.env.RELAY_UPSTREAM ||
    process.env.HTTP_UPSTREAM?.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  if (upstream) return proxyWebSocketToUpstream(request, socket, head, upstream);
  const resolved = resolvePublicWebSocket(request);
  if (!resolved) return rejectWebSocketUpgrade(socket, 404, "未找到该域名对应的隧道");
  const agent = agents.get(resolved.tunnelId);
  if (!agent || agent.readyState !== WebSocket.OPEN) {
    return rejectWebSocketUpgrade(socket, 503, "agent 未连接");
  }
  publicWebSockets.handleUpgrade(request, socket, head, (browserSocket) => {
    const id = randomUUID();
    const connection = {
      socket: browserSocket,
      tunnelId: resolved.tunnelId,
      path: resolved.path,
      clientIp: String(request.headers["cf-connecting-ip"] || request.socket.remoteAddress || "unknown"),
      startedAt: Date.now(),
      inbound: 0,
      outbound: 0
    };
    publicConnections.set(id, connection);
    const headers = sanitizeForwardedWebSocketHeaders(request.headers);
    headers["x-forwarded-host"] = request.headers.host || "";
    headers["x-forwarded-proto"] = "https";
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

httpServer.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`).pathname;
  if (pathname === "/relay") {
    relay.handleUpgrade(request, socket, head, (webSocket) => relay.emit("connection", webSocket, request));
  } else {
    handlePublicWebSocketUpgrade(request, socket, head);
  }
});

relay.on("connection", (socket, request) => {
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
  const tunnelId = query.get("tunnel"),
    token = query.get("token");
  const row = tunnelId
    ? db
        .prepare("SELECT id FROM tunnels WHERE id=? AND agent_token=?")
        .get(tunnelId, token)
    : null;
  if (!row || !tunnelId) return socket.close(1008, "invalid token");
  agents.set(tunnelId, socket);
  db.prepare("UPDATE tunnels SET status='running' WHERE id=?").run(tunnelId);
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === "ws-data" || message.type === "ws-close") {
        const connection = publicConnections.get(message.id);
        if (!connection) return;
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
    } catch {}
  });
  socket.on("close", () => {
    if (agents.get(tunnelId) === socket) agents.delete(tunnelId);
    for (const [id, connection] of publicConnections) {
      if (connection.tunnelId !== tunnelId) continue;
      finishPublicWebSocket(id, 503);
      connection.socket.close(1012, "agent disconnected");
    }
    db.prepare(
      "UPDATE tunnels SET status='stopped' WHERE id=? AND status='running'"
    ).run(tunnelId);
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
  const id = randomUUID(),
    chunks: Buffer[] = [],
    startedAt = Date.now();
  req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  req.on("end", () => {
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
    const target = `${upstream.replace(/\/$/, "")}${forwardedPath}`;
    const headers = new Headers(req.headers as HeadersInit);
    for (const name of [...hopByHopHeaders, "host", "content-length"]) headers.delete(name);
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
  const upstream = process.env.HTTP_UPSTREAM;
  if (upstream) return proxyHttpToUpstream(req, res, next, upstream, forwardedPath);
  return forwardToAgent(tunnelId, forwardedPath, req, res, next);
}

app.use("/public/:tunnelId", (req, res, next) => {
  const path =
    req.originalUrl.replace(`/public/${req.params.tunnelId}`, "") || "/";
  return forwardToAgent(req.params.tunnelId, path, req, res, next);
});
app.use((req, res, next) => {
  const upstream = process.env.HTTP_UPSTREAM;
  if (upstream) return proxyHttpToUpstream(req, res, next, upstream, req.originalUrl || "/");
  const matchedTunnel = findTunnelByHost(req.headers);
  if (!matchedTunnel)
    return res.status(404).json({ message: "未找到该域名对应的隧道" });
  return forwardToAgent(matchedTunnel.id, req.originalUrl || "/", req, res, next);
});
const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof z.ZodError)
    return res
      .status(400)
      .json({ message: "请求参数无效", issues: error.issues });
  console.error(error);
  res.status(500).json({ message: "服务暂时不可用" });
};
app.use(errorHandler);
const bindHost=process.env.BIND_HOST||"127.0.0.1";
httpServer.listen(port, bindHost, () =>
  console.log(`Nexious API listening on http://${bindHost}:${port}`)
);
