import https from "node:https";
import { directRelayForNode } from "./util.js";

export type NodeController = {
  controller_url: string;
  controller_token: string;
  host?: string;
  server_host?: string | null;
};

export function nodeControllerIdentity(node: NodeController): string {
  const endpoint = node.controller_url.replace(/\/api\/?$/, "").replace(/\/+$/, "");
  return `${endpoint}\0${node.controller_token}`;
}

export function uniqueNodeControllers<T extends NodeController>(nodes: T[]): T[] {
  const seen = new Set<string>();
  return nodes.filter(node => {
    const key = nodeControllerIdentity(node);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const directAgent = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 2 });
const directRetryAfter = new Map<string, number>();

export async function requestNodeController(
  node: NodeController,
  path: string,
  options: { method?: "GET" | "POST"; body?: string; timeoutMs?: number } = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const signal = AbortSignal.timeout(timeoutMs);
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { authorization: `Bearer ${node.controller_token}` };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const direct = directRelayForNode(node.controller_url, node.host, node.server_host);
  const key = direct ? `${direct.url}|${direct.address}` : "";
  if (direct && Date.now() >= (directRetryAfter.get(key) ?? 0)) {
    const target = new URL(path, direct.url.replace(/^wss:/, "https:"));
    let sent = false;
    try {
      const response = await new Promise<Response>((resolve, reject) => {
        const request = https.request(target, {
          hostname: node.server_host!,
          servername: target.hostname,
          headers: { ...headers, host: target.host, "accept-encoding": "identity" },
          method,
          agent: directAgent,
          signal
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const responseHeaders = new Headers();
            for (let i = 0; i < response.rawHeaders.length; i += 2)
              responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
            const status = response.statusCode ?? 502;
            resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
              status, headers: responseHeaders
            }));
          });
        });
        // 在 TLS 校验完成之前不发送管理令牌，也不发送可能改变节点状态的请求。
        const connectTimer = setTimeout(() => request.destroy(new Error("节点直连握手超时")), Math.min(2000, timeoutMs));
        request.on("close", () => clearTimeout(connectTimer));
        request.on("error", reject);
        request.on("socket", (socket) => {
          const send = () => {
            clearTimeout(connectTimer);
            sent = true;
            request.end(options.body);
          };
          if (request.reusedSocket) send();
          else socket.once("secureConnect", send);
        });
      });
      directRetryAfter.delete(key);
      return response;
    } catch (error) {
      // 已发送的写请求不能重放，否则同步操作可能被执行两次。
      if (sent && method !== "GET") throw error;
      for (const [entry, until] of directRetryAfter)
        if (until <= Date.now()) directRetryAfter.delete(entry);
      directRetryAfter.set(key, Date.now() + 30_000);
    }
  }
  const base = node.controller_url.replace(/\/api\/?$/, "").replace(/\/$/, "").replace(/:8789$/, ":8788");
  return fetch(`${base}${path}`, {
    method, headers, body: options.body,
    redirect: "error",
    signal
  });
}
