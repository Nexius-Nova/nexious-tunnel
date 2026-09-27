import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";

export function certificateDomainAllowed(domain: unknown, publicHost: string | undefined, tunnelDomains: string[]): boolean {
  if (typeof domain !== "string" || !publicHost) return false;
  const requested = domain.toLowerCase();
  const base = publicHost.toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(requested)) return false;
  return requested === base || (requested.endsWith(`.${base}`) && tunnelDomains.some(value => value.toLowerCase() === requested));
}

export function directRelayForNode(
  controllerUrl: string | null | undefined,
  nodeHost: string | undefined,
  serverHost: string | null | undefined
): { url: string; address: string } | null {
  if (!controllerUrl || !nodeHost || !serverHost || !isIP(serverHost)) return null;
  try {
    const controller = new URL(controllerUrl);
    const direct = new URL(`wss://${nodeHost}/relay`);
    if (
      controller.protocol !== "https:" ||
      direct.username || direct.password ||
      isIP(direct.hostname) || direct.hostname.startsWith("[") ||
      (controller.hostname !== direct.hostname &&
        !controller.hostname.endsWith(`.${direct.hostname}`))
    ) return null;
    direct.port = controller.port;
    const addressHost = isIP(serverHost) === 6 ? `[${serverHost}]` : serverHost;
    return { url: direct.href, address: `${addressHost}:${controller.port || "443"}` };
  } catch {
    return null;
  }
}

// 代理链路上的可伪造请求头必须显式开启信任才使用，避免直连场景下伪造来源。
export function resolveClientIp(
  headers: IncomingHttpHeaders,
  remoteAddress: string | undefined,
  trustProxyHeaders: boolean
): string {
  if (trustProxyHeaders) {
    const forwarded = String(
      headers["cf-connecting-ip"] || headers["x-real-ip"] || ""
    )
      .split(",")[0]
      .trim();
    if (forwarded) return forwarded;
  }
  return remoteAddress || "unknown";
}

export function normalizeHost(value: unknown): string {
  return String(value || "")
    .split(",")[0]
    .trim()
    .split(":")[0]
    .replace(/\.$/, "")
    .toLowerCase();
}

// Host 优先、X-Forwarded-Host 兜底：伪造 XFH 只能在 Host 本就匹配不到隧道时生效，
// 而那种请求原本就会 404，因此不会扩大可访问面。
export function tunnelHostCandidates(headers: IncomingHttpHeaders): string[] {
  return [headers.host, headers["x-forwarded-host"]]
    .map(normalizeHost)
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
}

export function originAllowed(
  origin: string | undefined,
  allowedOrigins: Set<string>
): boolean {
  if (!origin) return true;
  if (allowedOrigins.has(origin) || allowedOrigins.has("*")) return true;
  // Allow local dev servers on any ephemeral port while keeping production origins explicit.
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

// 转发路径必须是站点内的绝对路径，返回 null 表示必须拒绝。
// URL 解析器把 `//host/path`、`/\host/path`、完整 URL 等形式视为「更换主机」，
// agent 侧按该路径解析目标时会绕过隧道绑定的本地服务，访问本机任意端口、内网或公网地址。
export function safeForwardPath(value: unknown): string | null {
  const raw = typeof value === "string" && value ? value : "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  // 反斜杠在部分解析器中等同于 `/`，控制字符可能被用于拆分请求行，一并拒绝。
  if (raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
}

// 访问日志只保留用户真正的访问：前端构建产物（JS/CSS/图片/字体/媒体）由浏览器自动
// 请求，不属于「访问了哪个页面」。故意不含 json —— 那可能是应用真实的接口端点。
export const staticAssetExtensions = ["css", "js", "mjs", "cjs", "map", "png", "jpg", "jpeg", "gif",
  "svg", "webp", "avif", "bmp", "ico", "woff", "woff2", "ttf", "otf", "eot", "mp4", "webm", "ogg", "mp3", "wav", "wasm"] as const;

// 与 SQL 中 `path NOT LIKE` 条件等价：按“以扩展名结尾”或“扩展名后紧跟查询串”判断。
// 必须精确到扩展名边界，`%.js%` 会误伤 `.json`，`%.map%` 会误伤 `mappings` 这类路径。
export function isStaticAssetPath(value: unknown): boolean {
  const path = String(value || "").split("?")[0].toLowerCase();
  const dot = path.lastIndexOf(".");
  // 点必须在最后一个路径分隔符之后，否则 `/a.b/c` 这种目录名会被误判。
  if (dot < 0 || dot < path.lastIndexOf("/")) return false;
  return (staticAssetExtensions as readonly string[]).includes(path.slice(dot + 1));
}
export function staticAssetConditions(column = "path"): string[] {
  return staticAssetExtensions.flatMap((extension) => [
    `${column} NOT LIKE '%.${extension}'`,
    `${column} NOT LIKE '%.${extension}?%'`
  ]);
}

// base 与目标 path 解析后的 origin 必须一致；作为路径校验之外的纵深防御。
export function forwardUrlStaysOnOrigin(base: string, path: string): boolean {
  const safe = safeForwardPath(path);
  if (!safe) return false;
  try {
    const baseUrl = new URL(base);
    return new URL(safe, baseUrl).origin === baseUrl.origin;
  } catch {
    return false;
  }
}
