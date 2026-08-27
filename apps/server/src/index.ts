import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { db, tunnelRows } from "./db.js";
import { deployNode, inspectNode } from "./nodeDeployment.js";

const app = express();
const httpServer = createServer(app);
const port = Number(process.env.PORT || 8787);
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

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, version: "1.0.0", time: new Date().toISOString() })
);
app.get("/api/dashboard", (_req, res) => {
  const tunnels = tunnelRows() as Array<Record<string, unknown>>;
  const totals = db
    .prepare(
      "SELECT COALESCE(SUM(inbound),0) inbound, COALESCE(SUM(outbound),0) outbound FROM traffic"
    )
    .get();
  const series = db
    .prepare(
      `SELECT timestamp, SUM(inbound) inbound, SUM(outbound) outbound FROM traffic WHERE timestamp > datetime('now','-24 hours') GROUP BY timestamp ORDER BY timestamp`
    )
    .all();
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
    db.prepare("INSERT OR REPLACE INTO tunnels (id,name,protocol,local_host,local_port,remote_port,node_id,status,domain,created_at,agent_token,auto_start) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
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
app.get("/api/logs", (req, res) => {
  const query = z
    .object({
      tunnelId: z.string().optional(),
      search: z.string().trim().max(100).optional(),
      status: z.enum(["all", "success", "error"]).default("all"),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(10).max(100).default(20)
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
  const total = (
    db
      .prepare(`SELECT COUNT(*) count FROM access_logs ${where}`)
      .get(...values) as { count: number }
  ).count;
  const items = db
    .prepare(
      `SELECT * FROM access_logs ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    )
    .all(...values, query.pageSize, (query.page - 1) * query.pageSize);
  res.json({ items, total, page: query.page, pageSize: query.pageSize });
});
const relay = new WebSocketServer({ server: httpServer, path: "/relay" });
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
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    } catch {}
  });
  socket.on("close", () => {
    if (agents.get(tunnelId) === socket) agents.delete(tunnelId);
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
    db.prepare(
      "INSERT INTO access_logs (tunnel_id,timestamp,client_ip,method,path,status,duration,bytes) VALUES (?,?,?,?,?,?,?,?)"
    ).run(
      tunnelId,
      new Date().toISOString(),
      req.ip || "unknown",
      req.method,
      forwardedPath,
      503,
      0,
      0
    );
    return res.status(503).json({ message: "agent 未连接" });
  }
  const id = randomUUID(),
    chunks: Buffer[] = [],
    startedAt = Date.now();
  req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  req.on("end", () => {
    const timer = setTimeout(() => {
      if (pending.delete(id) && !res.headersSent) {
        db.prepare(
          "INSERT INTO access_logs (tunnel_id,timestamp,client_ip,method,path,status,duration,bytes) VALUES (?,?,?,?,?,?,?,?)"
        ).run(
          tunnelId,
          new Date().toISOString(),
          req.ip || "unknown",
          req.method,
          forwardedPath,
          504,
          Date.now() - startedAt,
          0
        );
        res.status(504).json({ message: "agent 响应超时" });
      }
    }, 30000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      const status = Number(message.status) || 502,
        responseBody = Buffer.from(message.body || "", "base64"),
        requestBytes = Buffer.concat(chunks).length;
      db.prepare(
        "INSERT INTO access_logs (tunnel_id,timestamp,client_ip,method,path,status,duration,bytes) VALUES (?,?,?,?,?,?,?,?)"
      ).run(
        tunnelId,
        new Date().toISOString(),
        req.ip || "unknown",
        req.method,
        forwardedPath,
        status,
        Date.now() - startedAt,
        responseBody.length
      );
      db.prepare(
        `INSERT INTO traffic (tunnel_id,timestamp,inbound,outbound) VALUES (?,strftime('%Y-%m-%dT%H:00:00.000Z','now'),?,?)`
      ).run(tunnelId, responseBody.length, requestBytes);
      res.status(status);
      for (const [key, value] of Object.entries(message.headers || {})) {
        if (typeof value !== "string") continue;
        // 目标服务可能返回仅允许 localhost 的 CORS 头，经过隧道后应匹配当前公网来源。
        if (
          key.toLowerCase() === "access-control-allow-origin" &&
          req.headers.origin
        ) {
          res.setHeader(key, req.headers.origin);
        } else {
          res.setHeader(key, value);
        }
      }
      res.end(responseBody);
    });
    // 浏览器访问隧道域名时会携带该公网域名的 Origin。直接转发会触发
    // Vite/后端的跨域白名单校验；隧道本身已经是同源代理，因此清理跨域
    // 标识，让本地服务按普通同源请求处理。
    const forwardedHeaders = { ...req.headers };
    delete forwardedHeaders.origin;
    delete forwardedHeaders.referer;
    forwardedHeaders["x-forwarded-host"] = req.headers.host || "";
    forwardedHeaders["x-forwarded-proto"] = req.protocol;
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

app.use("/public/:tunnelId", (req, res, next) => {
  const path =
    req.originalUrl.replace(`/public/${req.params.tunnelId}`, "") || "/";
  return forwardToAgent(req.params.tunnelId, path, req, res, next);
});
app.use((req, res, next) => {
  const upstream = process.env.HTTP_UPSTREAM;
  if (upstream) {
    const target = `${upstream.replace(/\/$/, "")}${req.originalUrl || "/"}`;
    const headers = new Headers(req.headers as HeadersInit);
    ["connection", "upgrade", "keep-alive", "transfer-encoding", "te", "trailer", "proxy-authorization", "proxy-authenticate"].forEach(header => headers.delete(header));
    headers.set("x-forwarded-host", req.headers.host || "");
    return fetch(target, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body) })
      .then(async response => { res.status(response.status); response.headers.forEach((value,key)=>{ if(!["content-length","transfer-encoding","connection"].includes(key.toLowerCase())) res.setHeader(key,value); }); res.send(Buffer.from(await response.arrayBuffer())); })
      .catch(() => res.status(502).json({ message: "边缘入口无法连接主 Relay" }));
  }
  const normalizeHost = (value: unknown) => String(value || "").split(",")[0].trim().split(":")[0].replace(/\.$/, "").toLowerCase();
  const hostCandidates = [req.headers["x-forwarded-host"], req.headers.host, req.hostname]
    .map(normalizeHost)
    .filter(Boolean);
  const tunnel = db
    .prepare(
      `
    SELECT t.id, t.domain, n.host FROM tunnels t JOIN nodes n ON n.id=t.node_id
  `
    )
    .all() as Array<{ id: string; domain: string; host: string }>;
  const matchedTunnel = tunnel.find((item) => hostCandidates.includes(normalizeHost(`${item.domain}.${item.host}`)));
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
