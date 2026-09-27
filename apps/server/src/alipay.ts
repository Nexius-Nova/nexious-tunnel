import { createSign, createVerify } from "node:crypto";

// 支付宝开放平台最小实现（RSA2 签名 + 当面付预下单 + 主动查单），
// 不引入官方 SDK：只用 node:crypto，签名规则见 https://opendocs.alipay.com/common/02kf5q
// 环境变量：
//   ALIPAY_APP_ID       应用 APPID
//   ALIPAY_PRIVATE_KEY  应用私钥（PKCS8，支持单行 base64 或完整 PEM）
//   ALIPAY_SELLER_ID    商户 PID（收款账号）
// 可选：
//   ALIPAY_GATEWAY      网关地址（默认正式环境；沙箱用 https://openapi-sandbox.dl.alipaydev.com/gateway.do）
//   ALIPAY_NOTIFY_URL   异步通知地址（公网可达时配置；未配置时依赖前端轮询 + 主动查单）
//   ALIPAY_PUBLIC_KEY   支付宝公钥（配置后对网关响应与异步通知验签）
export interface AlipayConfig {
  appId: string;
  privateKey: string;
  sellerId: string;
  gateway: string;
  notifyUrl: string;
  alipayPublicKey: string;
  ready: boolean;
}

// 密钥工具导出的单行 base64 也能直接使用：统一补齐 PEM 头尾与换行。
function normalizePem(value: string, type: "PRIVATE KEY" | "PUBLIC KEY") {
  const body = value.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  if (!body) return "";
  return `-----BEGIN ${type}-----\n${(body.match(/.{1,64}/g) || []).join("\n")}\n-----END ${type}-----`;
}

export function alipayConfig(): AlipayConfig {
  const appId = (process.env.ALIPAY_APP_ID || "").trim();
  const privateKey = normalizePem(process.env.ALIPAY_PRIVATE_KEY || "", "PRIVATE KEY");
  const sellerId = (process.env.ALIPAY_SELLER_ID || "").trim();
  const gateway = (process.env.ALIPAY_GATEWAY || "https://openapi.alipay.com/gateway.do").trim();
  const notifyUrl = (process.env.ALIPAY_NOTIFY_URL || "").trim();
  const alipayPublicKey = normalizePem(process.env.ALIPAY_PUBLIC_KEY || "", "PUBLIC KEY");
  return { appId, privateKey, sellerId, gateway, notifyUrl, alipayPublicKey, ready: Boolean(appId && privateKey) };
}

// 网关要求 GMT+8 的 yyyy-MM-dd HH:mm:ss，本地时区无关。
function alipayTimestamp() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
}

// 请求签名：非空参数按 key 的 ASCII 升序拼接（sign 本身除外，sign_type 参与签名）。
function signParams(params: Record<string, string>, privateKey: string) {
  const content = Object.keys(params)
    .filter(key => key !== "sign" && params[key] !== "")
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join("&");
  return createSign("RSA-SHA256").update(content, "utf8").sign(privateKey, "base64");
}

// 异步通知验签：sign 与 sign_type 都不参与拼接（与网关响应验签规则不同）。
export function verifyAlipayNotify(params: Record<string, string>, publicKey: string) {
  const sign = params.sign;
  if (!sign) return false;
  const content = Object.keys(params)
    .filter(key => key !== "sign" && key !== "sign_type" && params[key] !== "")
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join("&");
  try {
    return createVerify("RSA-SHA256").update(content, "utf8").verify(publicKey, sign, "base64");
  } catch {
    return false;
  }
}

// 响应验签：签名内容是原始报文里 `"${nodeName}":` 与 `,"sign"` 之间的 JSON 原文，
// 不能重新序列化（键序会变）。原始报文从 fetch 的 text() 传入。
function verifyResponse(raw: string, nodeName: string, sign: string, publicKey: string) {
  const marker = `"${nodeName}":`;
  const start = raw.indexOf(marker);
  const end = raw.lastIndexOf(',"sign"');
  if (start < 0 || end <= start) return false;
  const content = raw.slice(start + marker.length, end);
  try {
    return createVerify("RSA-SHA256").update(content, "utf8").verify(publicKey, sign, "base64");
  } catch {
    return false;
  }
}

async function alipayRequest(method: string, bizContent: Record<string, unknown>, notifyUrl?: string): Promise<{ raw: string; data: Record<string, any> }> {
  const config = alipayConfig();
  if (!config.ready) throw new Error("支付渠道未配置");
  const params: Record<string, string> = {
    app_id: config.appId,
    method,
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: alipayTimestamp(),
    version: "1.0",
    biz_content: JSON.stringify(bizContent)
  };
  if (notifyUrl) params.notify_url = notifyUrl;
  params.sign = signParams(params, config.privateKey);
  const response = await fetch(config.gateway, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`支付宝网关响应异常（HTTP ${response.status}）`);
  const raw = await response.text();
  let parsed: Record<string, any>;
  try { parsed = JSON.parse(raw); } catch { throw new Error("支付宝网关返回了无法解析的内容"); }
  const node = parsed[`${method.replace(/\./g, "_")}_response`];
  // 配置了支付宝公钥时必须验签，防止网关响应被篡改。
  if (config.alipayPublicKey) {
    const sign = typeof parsed.sign === "string" ? parsed.sign : "";
    if (!sign || !verifyResponse(raw, `${method.replace(/\./g, "_")}_response`, sign, config.alipayPublicKey))
      throw new Error("支付宝响应验签失败");
  }
  return { raw, data: node || {} };
}

// 当面付预下单：返回二维码内容（用户用支付宝 App 扫码支付）。
export async function alipayPrecreate(options: { outTradeNo: string; amountCents: number; subject: string; notifyUrl?: string }): Promise<string> {
  const { data } = await alipayRequest("alipay.trade.precreate", {
    out_trade_no: options.outTradeNo,
    total_amount: (options.amountCents / 100).toFixed(2),
    subject: options.subject
  }, options.notifyUrl);
  if (data.code !== "10000") throw new Error(`支付宝下单失败：${data.sub_msg || data.msg || "未知错误"}`);
  if (!data.qr_code) throw new Error("支付宝未返回收款二维码");
  return String(data.qr_code);
}

export interface AlipayTradeStatus {
  paid: boolean;
  totalAmountCents?: number;
  tradeNo?: string;
}

// 主动查单：交易不存在视为未支付，其余错误抛出。
export async function alipayQuery(outTradeNo: string): Promise<AlipayTradeStatus> {
  const { data } = await alipayRequest("alipay.trade.query", { out_trade_no: outTradeNo });
  if (data.code === "40004" || data.sub_code === "ACQ.TRADE_NOT_EXIST") return { paid: false };
  if (data.code !== "10000") throw new Error(`支付宝查单失败：${data.sub_msg || data.msg || "未知错误"}`);
  const status = String(data.trade_status || "");
  const amount = Number(data.total_amount);
  return {
    paid: status === "TRADE_SUCCESS" || status === "TRADE_FINISHED",
    totalAmountCents: Number.isFinite(amount) ? Math.round(amount * 100) : undefined,
    tradeNo: data.trade_no ? String(data.trade_no) : undefined
  };
}
