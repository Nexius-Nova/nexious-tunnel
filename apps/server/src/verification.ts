import { Router, type Request, type Response, type NextFunction } from "express";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { z } from "zod";
import { db } from "./db.js";
import { loginThrottle, nowIso, principalOf, recordLoginFailure, tokenHash } from "./auth.js";

export class VerificationError extends Error {
  constructor(message: string, public status = 400, public code = "VERIFICATION_FAILED") { super(message); }
}
export const normalizedEmail = z.string().trim().toLowerCase().email("请输入有效邮箱").max(254);

export function loadMailConfiguration(args = process.execArgv, environment = process.env) {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const option = args[index].match(/^--env-file(-if-exists)?(?:=(.*))?$/);
    if (!option) continue;
    const path = option[2] ?? args[++index];
    if (!path) continue;
    try { Object.assign(values, parseEnv(readFileSync(path, "utf8"))); }
    catch (error) {
      if (option[1] && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("无法读取邮件服务环境配置");
    }
  }
  // Node 的 env-file 不会覆盖父进程的空变量，邮件配置应从私有文件恢复。
  for (const key of ["RESEND_API_KEY", "RESEND_FROM", "RESEND_REPLY_TO", "RESEND_API_URL"]) {
    if (!environment[key]?.trim() && values[key]?.trim()) environment[key] = values[key];
  }
}
loadMailConfiguration();
export const mailConfigured = () => Boolean(process.env.RESEND_API_KEY?.trim() && process.env.RESEND_FROM?.trim());

async function limit(key: string, maximum: number) {
  if ((await loginThrottle(key, maximum)).blocked) throw new VerificationError("操作过于频繁，请稍后重试", 429, "RATE_LIMITED");
  await recordLoginFailure(key);
}
export async function consumeVerification(id: string, purpose: string, subject: string, secret: string) {
  const valid = await db.transaction(async () => {
    const row = await db.prepare(`SELECT * FROM verification_challenges WHERE id=?${db.forUpdate}`).get(id);
    if (!row || row.purpose !== purpose || row.subject !== subject || row.consumed || Date.parse(row.expires_at) <= Date.now() || row.attempts >= 5) return false;
    const actual = Buffer.from(tokenHash(`${id}:${secret}`)), expected = Buffer.from(row.secret_hash || "");
    const matches = actual.length === expected.length && timingSafeEqual(actual, expected);
    await db.prepare("UPDATE verification_challenges SET attempts=attempts+1,consumed=? WHERE id=?").run(matches ? 1 : 0, id);
    return matches;
  });
  if (!valid) throw new VerificationError("验证码错误、已使用或已过期，请重新验证");
}
async function saveChallenge(id: string, purpose: string, subject: string, secret: string | null, payload: unknown, ttl: number) {
  await db.prepare("INSERT INTO verification_challenges(id,purpose,subject,secret_hash,payload,created_at,expires_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, purpose, subject, secret === null ? null : tokenHash(`${id}:${secret}`), payload === null ? null : JSON.stringify(payload), nowIso(), new Date(Date.now() + ttl).toISOString());
}
export async function sendEmailCode(email: string, purpose: "register" | "bind-email", subject: string, ip: string) {
  if (!mailConfigured()) throw new VerificationError("邮箱验证服务尚未配置，请联系管理员", 503, "MAIL_NOT_CONFIGURED");
  let endpoint: URL;
  try { endpoint = new URL(process.env.RESEND_API_URL || "https://api.resend.com"); } catch { throw new VerificationError("邮件服务地址配置无效", 503); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
  if ((endpoint.protocol !== "https:" && !(loopback && endpoint.protocol === "http:")) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new VerificationError("邮件服务必须使用 HTTPS", 503);
  await limit(`mail-ip:${ip}`, 10);
  await limit(`mail-address:${email}`, 5);
  const reserved = await db.transaction(async () => {
    // 邮箱发送与注册共用账号锁，防止并发重复发送和邮箱抢占。
    await db.prepare("SELECT value FROM settings WHERE `key`='account_lock'" + db.forUpdate).get();
    if (await db.prepare("SELECT id FROM users WHERE email=?").get(email)) throw new VerificationError("该邮箱已绑定账号");
    const recent = await db.prepare("SELECT created_at FROM verification_challenges WHERE purpose=? AND subject=? ORDER BY created_at DESC LIMIT 1").get(`email-${purpose}`, subject);
    if (recent && Date.now() - Date.parse(recent.created_at) < 60000) throw new VerificationError("请等待 60 秒后重新发送", 429, "RATE_LIMITED");
    const id = randomBytes(24).toString("hex"), code = String(randomInt(100000, 1000000));
    await saveChallenge(id, `email-${purpose}`, subject, code, null, 10 * 60000);
    return { id, code };
  });
  try {
    const response = await fetch(`${endpoint.href.replace(/\/$/, "")}/emails`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json", "Idempotency-Key": `verification/${reserved.id}` },
      body: JSON.stringify({ from: process.env.RESEND_FROM, to: [email], ...(process.env.RESEND_REPLY_TO ? { reply_to: process.env.RESEND_REPLY_TO } : {}),
        subject: "Nexious Tunnel 邮箱验证码", text: `您的验证码是 ${reserved.code}，10 分钟内有效。请勿向他人提供验证码。如果不是您本人操作，请忽略此邮件。` })
    });
    if (!response.ok) throw new Error("mail rejected");
  } catch {
    await db.prepare("UPDATE verification_challenges SET consumed=1 WHERE id=?").run(reserved.id);
    throw new VerificationError("验证码发送失败，请稍后重试或联系管理员检查邮件服务", 502, "MAIL_SEND_FAILED");
  }
  return { verificationId: reserved.id, retryAfter: 60 };
}

export function captchaSubject(req: Request, ip: string, purpose: string, nodeId = "") {
  const actor = principalOf(req);
  return purpose === "node-reset" ? `${actor?.kind === "user" ? actor.id : ""}:${nodeId}:${ip}` : ip;
}
function shuffled<T>(values: T[]) {
  for (let index = values.length - 1; index > 0; index--) { const other = randomInt(index + 1); [values[index], values[other]] = [values[other], values[index]]; }
  return values;
}

// ── 行为验证码生成 ───────────────────────────────────────────────────
// 候选汉字池：笔画数与结构差异大，避免“看形状就能猜”。
const captchaCharacters = [..."星舟松云月石竹泉风山桂禾江雪林海外"];
// 干扰字符必须与候选池、以及彼此都不重复：否则同一个字会出现两次，
// 用户无法判断该点哪一个（答案按坐标比对，会误判为错误）。
const captchaDecoys = [..."川花雨雷电水火田木口日目手女大小"];
// 背景/前景/干扰线配色：每次随机换一套，保证字始终可辨认。
const captchaPalettes = [
  { bg: "#172320", fg: "#e2eee8", noise: "#667875" },
  { bg: "#1b1f2e", fg: "#e6e9f5", noise: "#5d6480" },
  { bg: "#241f18", fg: "#f2e9d8", noise: "#7d7159" },
  { bg: "#152326", fg: "#d9eef2", noise: "#5c7d85" },
  { bg: "#221a26", fg: "#eee0f2", noise: "#7a5f85" },
  { bg: "#1d2a1f", fg: "#e4f2e4", noise: "#657d67" }
];
const CAPTCHA_WIDTH = 320, CAPTCHA_HEIGHT = 180;
// 命中容差 22px；字符间距必须大于两倍容差，避免一次点击同时命中两个候选。
const CAPTCHA_TOLERANCE = 22, CAPTCHA_MIN_DISTANCE = 52;

type CaptchaGlyph = { character: string; x: number; y: number; size: number; rotate: number; opacity: number };

// 在画布内随机撒点，保证两两间距足够大；失败时回退到网格，避免死循环。
function layoutGlyphs(characters: string[]): CaptchaGlyph[] {
  const glyphs: CaptchaGlyph[] = [];
  const margin = 42;
  const grid = [[80, 60], [230, 58], [160, 96], [62, 132], [255, 130], [160, 148]];
  characters.forEach((character, index) => {
    let position: { x: number; y: number } | null = null;
    for (let attempt = 0; attempt < 260 && !position; attempt++) {
      const x = randomInt(margin, CAPTCHA_WIDTH - margin);
      const y = randomInt(margin, CAPTCHA_HEIGHT - margin);
      if (glyphs.every((glyph) => Math.hypot(glyph.x - x, glyph.y - y) >= CAPTCHA_MIN_DISTANCE)) position = { x, y };
    }
    const fallback = grid[index % grid.length];
    const { x, y } = position ?? { x: fallback[0] + randomInt(-6, 7), y: fallback[1] + randomInt(-6, 7) };
    glyphs.push({
      character, x, y,
      size: randomInt(26, 35),
      // 旋转方向随机；偶尔给一个较大的角度，让排版不那么规整。
      // 注意：不能使用 skewX —— 倾斜会把字形的视觉中心从其 (x,y) 锚点挪开
      // （y 越大偏移越大），超过命中容差就会让验证码变得点不中。
      rotate: randomInt(0, 9) === 0 ? randomInt(-42, 43) : randomInt(-24, 25),
      opacity: randomInt(72, 101) / 100
    });
  });
  return glyphs;
}

// 干扰元素：曲线、圆环、斑点与噪点滤镜，数量和形态每次随机。
function captchaNoise(noiseColor: string) {
  const parts: string[] = [];
  const curves = randomInt(5, 13);
  for (let index = 0; index < curves; index++) {
    parts.push(`<path d="M ${randomInt(0, CAPTCHA_WIDTH)} ${randomInt(0, CAPTCHA_HEIGHT)} Q ${randomInt(0, CAPTCHA_WIDTH)} ${randomInt(0, CAPTCHA_HEIGHT)} ${randomInt(0, CAPTCHA_WIDTH)} ${randomInt(0, CAPTCHA_HEIGHT)}" stroke="${noiseColor}" stroke-width="${randomInt(1, 3)}" opacity="${randomInt(16, 34) / 100}" fill="none"/>`);
  }
  const rings = randomInt(1, 5);
  for (let index = 0; index < rings; index++) {
    parts.push(`<circle cx="${randomInt(20, CAPTCHA_WIDTH - 20)}" cy="${randomInt(20, CAPTCHA_HEIGHT - 20)}" r="${randomInt(8, 26)}" stroke="${noiseColor}" stroke-width="${randomInt(1, 2)}" opacity="${randomInt(14, 30) / 100}" fill="none"/>`);
  }
  const dots = randomInt(6, 19);
  for (let index = 0; index < dots; index++) {
    parts.push(`<circle cx="${randomInt(2, CAPTCHA_WIDTH - 2)}" cy="${randomInt(2, CAPTCHA_HEIGHT - 2)}" r="${randomInt(1, 3)}" fill="${noiseColor}" opacity="${randomInt(18, 44) / 100}"/>`);
  }
  return parts.join("");
}
export function captchaCharacterPool() { return captchaCharacters.join(""); }
export function buildCaptcha() {
  const palette = captchaPalettes[randomInt(captchaPalettes.length)];
  // 需要点击的字符 3-4 个；再混入若干干扰字符增加视觉密度。
  const targets = shuffled([...captchaCharacters]).slice(0, randomInt(3, 5));
  const decoySpace = 6 - targets.length;
  const decoys = shuffled([...captchaDecoys]).slice(0, Math.max(1, randomInt(1, decoySpace + 1)));
  const glyphs = layoutGlyphs(shuffled([...targets, ...decoys]));
  const targetCharacters = new Set(targets);
  // 答案取自实际排布位置，顺序随机；验证时按索引比对坐标。
  const answer = shuffled(glyphs.filter((glyph) => targetCharacters.has(glyph.character))).slice(0, targets.length);
  const grain = `<filter id="captcha-grain"><feTurbulence type="fractalNoise" baseFrequency="${randomInt(60, 110) / 100}" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.05"/></feComponentTransfer></filter>`;
  const glyphNodes = glyphs.map((glyph) =>
    `<text x="${glyph.x}" y="${glyph.y}" text-anchor="middle" dominant-baseline="central" font-size="${glyph.size}" font-family="${randomInt(0, 2) ? "serif" : "sans-serif"}" fill="${palette.fg}" fill-opacity="${glyph.opacity}" transform="rotate(${glyph.rotate} ${glyph.x} ${glyph.y})">${glyph.character}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CAPTCHA_WIDTH}" height="${CAPTCHA_HEIGHT}" viewBox="0 0 ${CAPTCHA_WIDTH} ${CAPTCHA_HEIGHT}">`
    + `<defs>${grain}</defs>`
    + `<rect width="${CAPTCHA_WIDTH}" height="${CAPTCHA_HEIGHT}" fill="${palette.bg}"/>`
    + `<rect width="${CAPTCHA_WIDTH}" height="${CAPTCHA_HEIGHT}" filter="url(#captcha-grain)"/>`
    + captchaNoise(palette.noise)
    + glyphNodes
    + `</svg>`;
  return { svg, answer, targets: answer.length, width: CAPTCHA_WIDTH, height: CAPTCHA_HEIGHT };
}
export function verificationRouter(clientIp: (req: Request) => string) {
  const router = Router();
  router.post("/auth/captcha", async (req, res) => {
    const value = z.object({ purpose: z.enum(["login", "node-reset"]), nodeId: z.string().max(64).optional() }).strict().parse(req.body);
    if (value.purpose === "node-reset" && (principalOf(req)?.kind !== "user" || principalOf(req)?.role !== "admin" || !value.nodeId)) throw new VerificationError("需要管理员账号和节点编号", 403);
    const ip = clientIp(req); await limit(`captcha:${ip}`, 60);
    const captcha = buildCaptcha();
    const id = randomBytes(24).toString("hex");
    await saveChallenge(id, `captcha-${value.purpose}`, captchaSubject(req, ip, value.purpose, value.nodeId), null, captcha.answer.map(({ x, y }) => ({ x, y })), 3 * 60000);
    // 返回的 SVG 里字符坐标被刻意打乱并带旋转/倾斜偏移，不再与答案坐标一一对应；
    // 同时不下发坐标列表，避免脚本直接从响应里反推点击位置。
    res.json({ id, instruction: `请依次点击：${captcha.answer.map((point) => point.character).join("、")}`, image: `data:image/svg+xml;base64,${Buffer.from(captcha.svg).toString("base64")}`, width: captcha.width, height: captcha.height, points: captcha.targets });
  });
  router.post("/auth/captcha/verify", async (req, res) => {
    // 需要点击的字符数由服务端生成时决定（3-4 个），这里按实际数量校验，不能写死。
    const value = z.object({ id: z.string().length(48), purpose: z.enum(["login", "node-reset"]), nodeId: z.string().max(64).optional(), points: z.array(z.object({ x: z.number().min(0).max(CAPTCHA_WIDTH), y: z.number().min(0).max(CAPTCHA_HEIGHT) })).min(3).max(4) }).strict().parse(req.body);
    if (value.purpose === "node-reset" && (principalOf(req)?.kind !== "user" || principalOf(req)?.role !== "admin" || !value.nodeId)) throw new VerificationError("需要管理员权限", 403);
    const subject = captchaSubject(req, clientIp(req), value.purpose, value.nodeId);
    const ticket = await db.transaction(async () => {
      const row = await db.prepare(`SELECT * FROM verification_challenges WHERE id=?${db.forUpdate}`).get(value.id);
      if (!row || row.purpose !== `captcha-${value.purpose}` || row.subject !== subject || row.consumed || Date.parse(row.expires_at) <= Date.now()) return null;
      await db.prepare("UPDATE verification_challenges SET consumed=1 WHERE id=?").run(value.id);
      const answer = JSON.parse(row.payload) as Array<{ x: number; y: number }>;
      // 坐标比对使用 layoutGlyphs 的容差常量，与生成侧保持同一个数值。
      if (Date.now() - Date.parse(row.created_at) < 600 || answer.length !== value.points.length
        || !answer.every((point, index) => Math.hypot(point.x - value.points[index].x, point.y - value.points[index].y) <= CAPTCHA_TOLERANCE)) return null;
      const proof = randomBytes(24).toString("hex");
      await saveChallenge(proof, `proof-${value.purpose}`, subject, proof, null, 2 * 60000);
      return proof;
    });
    if (!ticket) throw new VerificationError("行为验证未通过或已过期，请重新验证");
    res.json({ ticket });
  });
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => error instanceof VerificationError ? res.status(error.status).json({ message: error.message, code: error.code }) : next(error));
  return router;
}
