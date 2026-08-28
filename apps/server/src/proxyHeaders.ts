import type { IncomingHttpHeaders } from "node:http";

export const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export function sanitizeForwardedRequestHeaders(
  headers: IncomingHttpHeaders
): Record<string, string | string[]> {
  const forwarded: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (
      value === undefined ||
      hopByHopHeaders.has(normalizedKey) ||
      ["host", "content-length", "origin", "referer"].includes(normalizedKey)
    ) continue;
    forwarded[key] = value;
  }
  return forwarded;
}

export function sanitizeForwardedWebSocketHeaders(
  headers: IncomingHttpHeaders
): Record<string, string | string[]> {
  const forwarded = sanitizeForwardedRequestHeaders(headers);
  for (const name of [
    "sec-websocket-extensions",
    "sec-websocket-key",
    "sec-websocket-version"
  ]) delete forwarded[name];
  return forwarded;
}

export function normalizeLocalCookieDomain(cookie: string): string {
  return cookie.replace(
    /;\s*domain=\.?(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?=;|$)/gi,
    ""
  );
}

const unsupportedOriginTrialFeatures = new Set([
  "attribution-reporting",
  "browsing-topics",
  "compute-pressure",
  "join-ad-interest-group",
  "private-aggregation",
  "run-ad-auction"
]);

export function normalizePermissionsPolicy(policy: string): string {
  return policy
    .split(",")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .filter((directive) => {
      const feature = directive.split("=", 1)[0]?.trim().toLowerCase();
      return feature && !unsupportedOriginTrialFeatures.has(feature);
    })
    .join(", ");
}
