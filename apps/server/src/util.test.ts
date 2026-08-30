import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeHost,
  originAllowed,
  resolveClientIp,
  tunnelHostCandidates
} from "./util.js";

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
