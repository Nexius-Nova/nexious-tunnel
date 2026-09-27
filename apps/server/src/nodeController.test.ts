import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { test } from "node:test";
import { requestNodeController } from "./nodeController.js";

test("节点请求透传认证、路径和写入内容，保留 HTTP 错误", async () => {
  const server = createHttpServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-token");
    assert.equal(req.url, "/internal/tunnels/sync?probe=1");
    assert.equal(req.method, "POST");
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(body, '{"action":"upsert"}');
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"message":"unauthorized"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const result = await requestNodeController({
      controller_url: `http://127.0.0.1:${address.port}/api`, controller_token: "test-token"
    }, "/internal/tunnels/sync?probe=1", { method: "POST", body: '{"action":"upsert"}' });
    assert.equal(result.status, 401);
    assert.deepEqual(await result.json(), { message: "unauthorized" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("直连握手失败前不暴露认证和正文，回退后短期避免重复尝试", async (context) => {
  let attempts = 0;
  const server = createTcpServer((socket) => {
    attempts++;
    socket.once("data", (data) => {
      assert.equal(data[0], 0x16); // TLS ClientHello，尚未发送 HTTP 管理请求。
      assert.equal(data.includes(Buffer.from("secret-token")), false);
      assert.equal(data.includes(Buffer.from("upsert")), false);
      socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const node = {
    host: "example.com", server_host: "127.0.0.1",
    controller_url: `https://relay.example.com:${address.port}/api`, controller_token: "secret-token"
  };
  const fallback = context.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, `https://relay.example.com:${address.port}/internal/tunnels/sync`);
    assert.equal(init?.body, '{"action":"upsert"}');
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret-token");
    return Response.json({ ok: true });
  });
  try {
    for (let i = 0; i < 2; i++) {
      const result = await requestNodeController(node, "/internal/tunnels/sync", {
        method: "POST", body: '{"action":"upsert"}'
      });
      assert.deepEqual(await result.json(), { ok: true });
    }
    assert.equal(attempts, 1);
    assert.equal(fallback.mock.callCount(), 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("节点无响应时按请求预算超时", async () => {
  const server = createHttpServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    await assert.rejects(requestNodeController({
      controller_url: `http://127.0.0.1:${address.port}/api`, controller_token: "test-token"
    }, "/api/health", { timeoutMs: 50 }), { name: "TimeoutError" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
