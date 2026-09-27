import assert from "node:assert/strict";
import { test } from "node:test";
import {
  directRelayForNode,
  certificateDomainAllowed,
  forwardUrlStaysOnOrigin,
  isStaticAssetPath,
  normalizeHost,
  originAllowed,
  resolveClientIp,
  safeForwardPath,
  staticAssetConditions,
  tunnelHostCandidates
} from "./util.js";

test("证书授权只允许节点域名及当前已同步的隧道域名", () => {
  assert.equal(certificateDomainAllowed("EXAMPLE.COM", "example.com", []), true);
  assert.equal(certificateDomainAllowed("app.example.com", "example.com", ["app.example.com"]), true);
  for (const domain of ["unknown.example.com", "app.other.com", "example.com.attacker.test", "*.example.com", "app.example.com:443", ["app.example.com"]])
    assert.equal(certificateDomainAllowed(domain, "example.com", ["app.example.com", "app.other.com"]), false);
  assert.equal(certificateDomainAllowed("app.example.com", undefined, ["app.example.com"]), false);
});

test("directRelayForNode 保留域名证书校验并选择节点 IP", () => {
  assert.deepEqual(
    directRelayForNode("https://relay.example.com/api", "example.com", "203.0.113.9"),
    { url: "wss://example.com/relay", address: "203.0.113.9:443" }
  );
  assert.deepEqual(
    directRelayForNode("https://example.com:8443/api", "example.com", "2001:db8::1"),
    { url: "wss://example.com:8443/relay", address: "[2001:db8::1]:8443" }
  );
});

test("directRelayForNode 不为明文、无 IP 或其他域名的控制器生成直连入口", () => {
  for (const controller of ["http://relay.example.com/api", "https://other.example/api", "invalid"]) {
    assert.equal(directRelayForNode(controller, "example.com", "203.0.113.9"), null);
  }
  assert.equal(directRelayForNode("https://example.com/api", "example.com", "origin.example.com"), null);
  assert.equal(directRelayForNode("https://example.com/api", "example.com", null), null);
});

test("normalizeHost 清理端口、逗号与末尾点并转小写", () => {
  assert.equal(normalizeHost("Example.COM:8443"), "example.com");
  assert.equal(normalizeHost("a.com, b.com"), "a.com");
  assert.equal(normalizeHost("a.com."), "a.com");
  assert.equal(normalizeHost(undefined), "");
  assert.equal(normalizeHost(""), "");
});

test("tunnelHostCandidates 优先 Host、X-Forwarded-Host 仅作兜底", () => {
  assert.deepEqual(
    tunnelHostCandidates({ host: "direct.example.com", "x-forwarded-host": "spoof.example.com" }),
    ["direct.example.com", "spoof.example.com"]
  );
  assert.deepEqual(
    tunnelHostCandidates({ host: "direct.example.com" }),
    ["direct.example.com"]
  );
  // 伪造的 XFH 若与 Host 同值不应产生重复候选
  assert.deepEqual(
    tunnelHostCandidates({ host: "a.com", "x-forwarded-host": "a.com" }),
    ["a.com"]
  );
});

test("resolveClientIp 默认不信任伪造头", () => {
  const headers = {
    "cf-connecting-ip": "1.2.3.4",
    "x-real-ip": "5.6.7.8"
  };
  assert.equal(resolveClientIp(headers, "203.0.113.9", false), "203.0.113.9");
});

test("resolveClientIp 在信任代理时读取转发头", () => {
  const headers = {
    "cf-connecting-ip": "1.2.3.4",
    "x-real-ip": "5.6.7.8"
  };
  assert.equal(resolveClientIp(headers, "203.0.113.9", true), "1.2.3.4");
  assert.equal(
    resolveClientIp({ "x-real-ip": "5.6.7.8" }, "203.0.113.9", true),
    "5.6.7.8"
  );
  assert.equal(resolveClientIp({}, "203.0.113.9", true), "203.0.113.9");
  assert.equal(resolveClientIp({}, undefined, false), "unknown");
});

test("originAllowed 放行无 Origin、白名单与本地开发端口", () => {
  const allowed = new Set(["tauri://localhost", "https://nexious-ppt.xyz"]);
  assert.equal(originAllowed(undefined, allowed), true);
  assert.equal(originAllowed("tauri://localhost", allowed), true);
  assert.equal(originAllowed("http://localhost:5173", allowed), true);
  assert.equal(originAllowed("http://127.0.0.1:4173", allowed), true);
  assert.equal(originAllowed("http://[::1]:3000", allowed), true);
});

test("originAllowed 拒绝未知外部来源", () => {
  const allowed = new Set(["tauri://localhost"]);
  assert.equal(originAllowed("https://evil.example.com", allowed), false);
  assert.equal(originAllowed("not a url", allowed), false);
});

test("safeForwardPath 放行站点内绝对路径", () => {
  for (const path of ["/", "/a", "/a/b?c=1", "/api/tunnels", "/%2f%2fnot-a-host", "/a/../b", "/中文"])
    assert.equal(safeForwardPath(path), path);
  assert.equal(safeForwardPath(undefined), "/");
  assert.equal(safeForwardPath(""), "/");
});

test("safeForwardPath 拒绝可改变转发主机或拆分请求行的路径", () => {
  // 这些形式会被 URL 解析器当作「更换主机」，是隧道变开放代理的直接成因。
  for (const path of ["//evil.example/x", "//127.0.0.1:19002/x", "//localhost:18788/api/tunnels", "http://evil.example/x", "https://evil.example", "/\\evil.example", "/a\\b", "a/b", "/a\nHost: x", "/a\r\nx", "/a\u0000b"])
    assert.equal(safeForwardPath(path), null, `应拒绝 ${JSON.stringify(path)}`);
});

test("访问日志按扩展名过滤前端构建产物，且不误伤真实接口路径", () => {
  // 应当过滤：构建产物与媒体资源
  for (const path of ["/assets/app.js", "/assets/app.js?v=1", "/assets/style.css", "/logo.svg",
    "/fonts/x.woff2", "/video.mp4", "/a/b/App.tsx-chunk.mjs", "/icon.PNG"])
    assert.equal(isStaticAssetPath(path), true, path);
  // 不应过滤：页面、接口、以及“扩展名相近但不同”的路径
  for (const path of ["/", "/pricing", "/api/records?page=1&pageSize=10", "/api/data.json",
    "/mappings", "/api/users-list", "/api/v1.2/stats", "/files/archive.tar.gz", "/a.b/c", ""])
    assert.equal(isStaticAssetPath(path), false, path);
  assert.equal(isStaticAssetPath(null), false);
  // SQL 条件必须精确到扩展名边界：用 `%.js%` 会把 .json 一起排除。
  const conditions = staticAssetConditions();
  assert.ok(conditions.includes("path NOT LIKE '%.js'"));
  assert.ok(conditions.includes("path NOT LIKE '%.js?%'"));
  assert.ok(!conditions.some((value) => value.includes("%.js%")), "不得使用 %.js% —— 会误伤 .json");
});
test("forwardUrlStaysOnOrigin 兜底拦截跨 origin 的解析结果", () => {
  assert.equal(forwardUrlStaysOnOrigin("http://127.0.0.1:19001", "/ok"), true);
  assert.equal(forwardUrlStaysOnOrigin("http://127.0.0.1:19001", "//127.0.0.1:19002/x"), false);
  assert.equal(forwardUrlStaysOnOrigin("http://127.0.0.1:19001", "//example.com/"), false);
  assert.equal(forwardUrlStaysOnOrigin("http://127.0.0.1:19001", "//localhost:18788/api/tunnels"), false);
  assert.equal(forwardUrlStaysOnOrigin("not a base", "/ok"), false);
});
