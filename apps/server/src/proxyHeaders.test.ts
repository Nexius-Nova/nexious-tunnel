import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hopByHopHeaders,
  normalizeLocalCookieDomain,
  normalizePermissionsPolicy,
  sanitizeForwardedRequestHeaders,
  sanitizeForwardedWebSocketHeaders
} from "./proxyHeaders.js";

test("sanitizeForwardedRequestHeaders 剔除逐跳头与寻址头", () => {
  const forwarded = sanitizeForwardedRequestHeaders({
    host: "tunnel.example.com",
    "content-length": "12",
    origin: "https://tunnel.example.com",
    referer: "https://tunnel.example.com/x",
    connection: "keep-alive",
    "transfer-encoding": "chunked",
    "x-custom": "keep-me"
  });
  assert.deepEqual(forwarded, { "x-custom": "keep-me" });
});

test("sanitizeForwardedWebSocketHeaders 额外剔除 WebSocket 握手头", () => {
  const forwarded = sanitizeForwardedWebSocketHeaders({
    "sec-websocket-key": "abc",
    "sec-websocket-version": "13",
    "sec-websocket-extensions": "permessage-deflate",
    "x-forwarded-for": "203.0.113.9"
  });
  assert.deepEqual(forwarded, { "x-forwarded-for": "203.0.113.9" });
});

test("normalizeLocalCookieDomain 移除绑定到本地地址的 Domain", () => {
  assert.equal(
    normalizeLocalCookieDomain("sid=abc; Domain=localhost; Path=/"),
    "sid=abc; Path=/"
  );
  assert.equal(
    normalizeLocalCookieDomain("sid=abc; domain=127.0.0.1; HttpOnly"),
    "sid=abc; HttpOnly"
  );
  assert.equal(
    normalizeLocalCookieDomain("sid=abc; Domain=.example.com"),
    "sid=abc; Domain=.example.com"
  );
});

test("normalizePermissionsPolicy 过滤浏览器不再支持的 Origin Trial 特性", () => {
  assert.equal(
    normalizePermissionsPolicy(
      "geolocation=(), browsing-topics=(), camera=(self), attribution-reporting=()"
    ),
    "geolocation=(), camera=(self)"
  );
  assert.equal(normalizePermissionsPolicy(""), "");
});

test("hopByHopHeaders 覆盖标准逐跳头", () => {
  for (const name of ["connection", "keep-alive", "transfer-encoding", "upgrade", "te"]) {
    assert.ok(hopByHopHeaders.has(name));
  }
});
