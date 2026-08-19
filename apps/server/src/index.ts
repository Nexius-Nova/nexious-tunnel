import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { db, tunnelRows } from "./db.js";

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
    ),
  status: z.enum(["online", "maintenance"])
});

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
app.post("/api/tunnels/:id/token", (req, res) => {
  const tunnel = (tunnelRows() as Array<{ id: string }>).find(
    (row) => row.id === req.params.id
  );
  if (!tunnel) return res.status(404).json({ message: "隧道不存在" });
  const token = randomUUID().replaceAll("-", "");
  db.prepare("UPDATE tunnels SET agent_token=? WHERE id=?").run(
    token,
    req.params.id
  );
  res.json({
    token,
    tunnelId: req.params.id,
    relay: `${process.env.RELAY_URL || "ws://127.0.0.1:8787"}/relay`
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
          .prepare("UPDATE tunnels SET auto_start=1 WHERE id=?")
          .run(req.params.id);
  if (!result.changes) return res.status(404).json({ message: "隧道不存在" });
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
  res.status(204).end();
});
app.get("/api/nodes", (_req, res) =>
  res.json(
    db
      .prepare("SELECT id,name,host,status FROM nodes ORDER BY status,name")
      .all()
  )
);
app.post("/api/nodes", (req, res) => {
  const value = nodeSchema.parse(req.body),
    id = `n-${randomUUID().slice(0, 8)}`;
  db.prepare(
    "INSERT INTO nodes (id,name,region,city,latency,load,status,host) VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, value.name, "默认", "默认", 0, 0, value.status, value.host);
  res
    .status(201)
    .json(
      db.prepare("SELECT id,name,host,status FROM nodes WHERE id=?").get(id)
    );
});
app.put("/api/nodes/:id", (req, res) => {
  const value = nodeSchema.parse(req.body);
  const result = db
    .prepare("UPDATE nodes SET name=?,status=?,host=? WHERE id=?")
    .run(value.name, value.status, value.host, req.params.id);
  if (!result.changes) return res.status(404).json({ message: "节点不存在" });
  res.json(
    db
      .prepare("SELECT id,name,host,status FROM nodes WHERE id=?")
      .get(req.params.id)
  );
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
  const hostname = req.hostname.toLowerCase();
  const tunnel = db
    .prepare(
      `
    SELECT t.id FROM tunnels t JOIN nodes n ON n.id=t.node_id
    WHERE lower(t.domain || '.' || n.host)=?
  `
    )
    .get(hostname) as { id: string } | undefined;
  if (!tunnel)
    return res.status(404).json({ message: "未找到该域名对应的隧道" });
  return forwardToAgent(tunnel.id, req.originalUrl || "/", req, res, next);
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
httpServer.listen(port, "127.0.0.1", () =>
  console.log(`Nexious API listening on http://127.0.0.1:${port}`)
);
