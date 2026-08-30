import type { IncomingHttpHeaders } from "node:http";

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
