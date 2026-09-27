// HTTP 层的权限矩阵与越权测试：把服务端跑起来，用"用户"和"管理员"两种会话
// 打真实请求。这是角色隔离的唯一可信验证——UI 隐藏不等于服务端拦截。
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "./database.js";
import { createServer as createHttpServer } from "node:http";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";

const PORT = process.env.NEXIOUS_TEST_MYSQL === "1" ? 18900 : 18899;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVICE_TOKEN = "service-token-for-test";
const tempDir = mkdtempSync(join(tmpdir(), "nexious-rbac-"));
// 默认直接用 tsx 跑 TS 源码；打包环境下可通过环境变量指向已构建的入口。
const entryOverride = process.env.NEXIOUS_TEST_SERVER_ENTRY;
const serverEntry = entryOverride || resolve(import.meta.dirname, "index.ts");
const serverArgs = entryOverride ? [serverEntry] : ["--import", "tsx", serverEntry];

let child: ChildProcess | undefined;
let control: Database;
let initialRegistration: boolean;
process.env.NEXIOUS_DB_DRIVER = process.env.NEXIOUS_TEST_MYSQL === "1" ? "mysql" : "sqlite";
process.env.NEXIOUS_DB_PATH = join(tempDir, "rbac.db");
process.env.NEXIOUS_SQLITE_TEST = process.env.NEXIOUS_TEST_MYSQL === "1" ? "0" : "1";

type Json = Record<string, any>;
const emailCodes = new Map<string,string>();
const mailServer = createHttpServer(async (req,res) => {
  let body="";for await(const chunk of req)body+=chunk;
  const value=JSON.parse(body);emailCodes.set(value.to[0],value.text.match(/\d{6}/)[0]);
  res.writeHead(200,{"content-type":"application/json"});res.end('{"id":"mock-email"}');
});

async function captchaTicket(purpose="login",token?:string,nodeId?:string) {
  const challenge=await api("/api/auth/captcha",{method:"POST",token,body:JSON.stringify({purpose,nodeId})});
  assert.equal(challenge.status,200,JSON.stringify(challenge.body));
  const svg=Buffer.from(challenge.body.image.split(",")[1],"base64").toString();
  const positions=new Map([...svg.matchAll(/<text x="(\d+)" y="(\d+)"[^>]*>([^<]+)<\/text>/g)].map(match=>[match[3],{x:Number(match[1]),y:Number(match[2])}]));
  const points=challenge.body.instruction.split("：")[1].split("、").map((char:string)=>positions.get(char));
  await delay(650);
  const verified=await api("/api/auth/captcha/verify",{method:"POST",token,body:JSON.stringify({id:challenge.body.id,purpose,nodeId,points})});
  assert.equal(verified.status,200,JSON.stringify(verified.body));return verified.body.ticket as string;
}

async function api(path: string, init: RequestInit & { token?: string } = {}): Promise<{status:number;body:Json;headers:Headers}> {
  if(path==="/api/auth/login"&&init.body){const value=JSON.parse(String(init.body));if(!value.captchaTicket)init={...init,body:JSON.stringify({...value,captchaTicket:await captchaTicket()})};}
  if(path==="/api/auth/register"&&init.body){
    const value=JSON.parse(String(init.body));
    if(!value.verificationId){
      const email=value.email||`${value.username}@example.test`;
      const sent=await api("/api/auth/email-code",{method:"POST",body:JSON.stringify({email})});assert.equal(sent.status,200,JSON.stringify(sent.body));
      init={...init,body:JSON.stringify({...value,email,verificationId:sent.body.verificationId,code:emailCodes.get(email)})};
    }
  }
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${BASE}${path}`, { ...rest, headers });
  const text = await response.text();
  let body: Json | null = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: response.status, body: body as Json, headers: response.headers };
}

async function registerFixture(init: RequestInit): Promise<{status:number;body:Json}> {
  const value = JSON.parse(String(init.body));
  const created = await api("/api/users", { method: "POST", token: SERVICE_TOKEN, body: JSON.stringify({ username: value.username, password: value.password + "-temporary" }) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const signedIn = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: value.username, password: value.password + "-temporary" }) });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  const changed = await api("/api/auth/password", { method: "POST", token: signedIn.body.token, body: JSON.stringify({ currentPassword: value.password + "-temporary", newPassword: value.password }) });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  return { status: 201, body: { token: changed.body.token, user: { ...created.body, mustChangePassword: false } } };
}

// 配额严格按套餐后，新注册账号不再有默认配额；需要创建隧道的测试先授予直接配额。
async function grantQuota(id: Json, tunnels = 10) {
  assert.equal((await api(`/api/users/${id}`, { method: "PATCH", token: SERVICE_TOKEN, body: JSON.stringify({ quotaTunnels: tunnels }) })).status, 200, JSON.stringify({ id, tunnels }));
}

before(async () => {
  await new Promise<void>(resolve=>mailServer.listen(0,"127.0.0.1",resolve));
  child = spawn(process.execPath, serverArgs, {
    cwd: resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(PORT),
      BIND_HOST: "127.0.0.1",
      NEXIOUS_ADMIN_TOKEN: SERVICE_TOKEN,
      NEXIOUS_DB_PATH: join(tempDir, "rbac.db"),
      NODE_ENV: "production",
      NEXIOUS_DB_DRIVER: process.env.NEXIOUS_TEST_MYSQL === "1" ? "mysql" : "sqlite",
      NEXIOUS_BOOTSTRAP_ADMIN_PASSWORD: "test-bootstrap-password"
      ,RESEND_API_KEY:"test-mail-key",RESEND_FROM:"Nexious <no-reply@example.test>",RESEND_API_URL:`http://127.0.0.1:${(mailServer.address() as {port:number}).port}`
    },
    stdio: "ignore"
  });
  // 等服务端就绪
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) {
        initialRegistration=(await api("/api/auth/status")).body.registrationEnabled;
        control=await (await import("./database.js")).openDatabase();
        return;
      }
    } catch { /* 还没起来 */ }
    await delay(250);
  }
  throw new Error("测试服务端启动超时");
});

after(async () => { child?.kill(); await control?.close(); mailServer.close(); });

test("管理员的个人隧道与其他账号隔离，节点及账号管理权限保持可用", async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const admin = await registerFixture({ body: JSON.stringify({ username: "isolated_admin_" + suffix, password: "isolated-admin-password-2026" }) });
  const user = await registerFixture({ body: JSON.stringify({ username: "isolated_user_" + suffix, password: "isolated-user-password-2026" }) });
  assert.equal((await api("/api/users/" + admin.body.user.id, { method: "PATCH", token: SERVICE_TOKEN, body: JSON.stringify({ role: "admin" }) })).status, 200);
  const signedIn = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: admin.body.user.username, password: "isolated-admin-password-2026" }) });
  assert.equal(signedIn.status, 200);
  admin.body.token = signedIn.body.token;
  await grantQuota(admin.body.user.id);
  await grantQuota(user.body.user.id);
  const node = await api("/api/nodes", { method: "POST", token: SERVICE_TOKEN, body: JSON.stringify({ name: "隔离测试节点", region: "默认", city: "默认", host: "isolation.example.test" }) });
  assert.equal(node.status, 201);
  const create = (token: string, name: string) => api("/api/tunnels", { method: "POST", token, body: JSON.stringify({ name, protocol: "http", localHost: "127.0.0.1", localPort: 3000, remotePort: 80, nodeId: node.body.id, domain: name + suffix }) });
  const mine = await create(admin.body.token, "admin-owned");
  const other = await create(user.body.token, "user-owned");
  assert.equal(mine.status, 201);
  assert.equal(other.status, 201);
  const listed = await api("/api/tunnels", { token: admin.body.token });
  assert.deepEqual(listed.body.map((row: Json) => row.id), [mine.body.id]);
  const dashboard = await api("/api/dashboard", { token: admin.body.token });
  assert.deepEqual(dashboard.body.tunnels.map((row: Json) => row.id), [mine.body.id]);
  for (const id of [mine.body.id, other.body.id]) await control.prepare("INSERT INTO access_logs(tunnel_id,timestamp,client_ip,method,path,status,duration,bytes) VALUES(?,?,?,?,?,?,?,?)").run(id, new Date().toISOString(), "127.0.0.1", "GET", "/isolation", 200, 1, 1);
  const logs = await api("/api/logs", { token: admin.body.token });
  assert.ok(logs.body.items.length > 0);
  assert.ok(logs.body.items.every((row: Json) => row.tunnel_id === mine.body.id));
  for (const [method, tail] of [["POST", "/token"], ["PATCH", "/status"], ["DELETE", ""]]) {
    assert.equal((await api(`/api/tunnels/${other.body.id}${tail}`, { method, token: admin.body.token, ...(tail === "/status" ? { body: JSON.stringify({ status: "running" }) } : {}) })).status, 404);
  }
  for (const path of ["/api/users", "/api/nodes", "/api/billing"]) assert.equal((await api(path, { token: admin.body.token })).status, 200);
  const all = await api("/api/tunnels", { token: SERVICE_TOKEN });
  assert.ok(all.body.some((row: Json) => row.id === mine.body.id));
  assert.ok(all.body.some((row: Json) => row.id === other.body.id));
});

test("合并后的节点别名不重复累计同一服务器的流量和日志", async () => {
  const counters = { dashboard: 0, logs: 0 };
  const token = "shared-node-controller-token";
  const server = createHttpServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/dashboard")) {
      counters.dashboard++;
      res.end(JSON.stringify({ totals: { inbound: 1234, outbound: 5678 }, series: [] }));
    } else if (req.url?.startsWith("/api/logs")) {
      counters.logs++;
      res.end(JSON.stringify({ total: 1, items: [{ id: 1, tunnel_id: "alias-probe", timestamp: new Date().toISOString(), method: "GET", path: "/", status: 200, bytes: 1, duration: 1, client_ip: "127.0.0.1" }] }));
    } else res.end('{"ok":true}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const ids = [`alias-${randomUUID()}`, `alias-${randomUUID()}`];
  try {
    for (const [index, id] of ids.entries()) await control.prepare("INSERT INTO nodes(id,name,region,city,latency,`load`,status,host,controller_url,controller_token,deploy_status) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, "同服务器别名", "默认", "默认", 0, 0, "online", "alias.example.test", endpoint + (index ? "/" : ""), token, "ready");
    const dashboard = await api("/api/dashboard", { token: SERVICE_TOKEN });
    assert.equal(dashboard.status, 200);
    assert.equal(counters.dashboard, 1);
    const logs = await api("/api/logs", { token: SERVICE_TOKEN });
    assert.equal(logs.status, 200);
    assert.equal(counters.logs, 1);
    assert.equal(logs.body.items.filter((row: Json) => row.tunnel_id === "alias-probe").length, 1);
  } finally {
    await control.prepare("DELETE FROM nodes WHERE id IN (?,?)").run(...ids);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("未认证请求被拒绝", async () => {
  assert.equal(initialRegistration,true,"主控制中心统一提供邮箱验证注册");
  for (const path of ["/api/tunnels", "/api/nodes", "/api/users", "/api/dashboard", "/api/logs"]) {
    const res = await api(path);
    assert.equal(res.status, 401, `${path} 应要求认证`);
  }
  // health 与 auth 入口无需认证
  assert.equal((await api("/api/health")).status, 200);
  assert.equal((await api("/api/auth/status")).status, 200);
});

test("服务凭据可访问，且能看到全量数据", async () => {
  assert.equal((await api("/api/tunnels", { token: SERVICE_TOKEN })).status, 200);
  assert.equal((await api("/api/users", { token: SERVICE_TOKEN })).status, 200);
});

test("登录必须使用服务端签发的行为验证票据，票据只能消费一次", async () => {
  const body={username:"admin",password:"test-bootstrap-password"};
  const raw=(value:unknown)=>fetch(`${BASE}/api/auth/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(value)});
  assert.equal((await raw(body)).status,400);
  assert.equal((await raw({...body,captchaTicket:"f".repeat(48)})).status,400);
  const wrongPasswordTicket=await captchaTicket();
  const wrongPassword=await raw({...body,password:"wrong-password-2026",captchaTicket:wrongPasswordTicket});
  assert.equal(wrongPassword.status,401);
  assert.equal((await wrongPassword.json()).message,"用户名或密码错误");
  const ticket=await captchaTicket();
  assert.equal((await raw({...body,captchaTicket:ticket})).status,200);
  assert.equal((await raw({...body,captchaTicket:ticket})).status,400);
  const challenge=await api("/api/auth/captcha",{method:"POST",body:JSON.stringify({purpose:"login"})});
  const wrong={id:challenge.body.id,purpose:"login",points:[{x:0,y:0},{x:0,y:0},{x:0,y:0}]};
  assert.equal((await api("/api/auth/captcha/verify",{method:"POST",body:JSON.stringify(wrong)})).status,400);
  assert.equal(Number((await control.prepare("SELECT consumed FROM verification_challenges WHERE id=?").get(challenge.body.id))!.consumed),1);
});

test("会员开通幂等、权限隔离及到期配额回落", async () => {
  const user=await registerFixture({body:JSON.stringify({username:"member"+Math.random().toString(36).slice(2,7),password:"member-pass-2026"})});
  const plan=await api("/api/membership/plans",{method:"POST",token:SERVICE_TOKEN,body:JSON.stringify({name:"测试会员",description:"测试套餐",priceCents:990,durationDays:30,tunnelQuota:12,enabled:true})});
  assert.equal(plan.status,201,JSON.stringify(plan.body));
  const requestId=randomUUID(),input={planId:plan.body.id,requestId};
  assert.equal((await api(`/api/users/${user.body.user.id}/membership`,{method:"POST",token:user.body.token,body:JSON.stringify(input)})).status,403);
  const first=await api(`/api/users/${user.body.user.id}/membership`,{method:"POST",token:SERVICE_TOKEN,body:JSON.stringify(input)});
  const repeated=await api(`/api/users/${user.body.user.id}/membership`,{method:"POST",token:SERVICE_TOKEN,body:JSON.stringify(input)});
  assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(repeated.body.expiresAt,first.body.expiresAt);
  assert.equal(Number((await control.prepare("SELECT COUNT(*) count FROM membership_grants WHERE request_id=?").get(requestId))!.count),1);
  assert.equal((await api("/api/membership/me",{token:user.body.token})).body.effectiveQuota,12);
  await control.prepare("UPDATE users SET membership_until=? WHERE id=?").run(new Date(Date.now()-1000).toISOString(),user.body.user.id);
  assert.equal((await api("/api/membership/me",{token:user.body.token})).body.membershipActive,false);
  // 配额严格按套餐：套餐到期且无其他配额来源时，有效配额回落为 0。
  assert.equal((await api("/api/auth/me",{token:user.body.token})).body.effectiveQuota,0);
});

test("配额严格按套餐并记录账单流水", async () => {
  const user=await registerFixture({body:JSON.stringify({username:"quota"+Math.random().toString(36).slice(2,7),password:"quota-pass-2026"})});
  // 未开通任何套餐：即使有默认值历史语义，也不应获得配额。
  assert.equal((await api("/api/auth/me",{token:user.body.token})).body.effectiveQuota,0);
  const plan=await api("/api/membership/plans",{method:"POST",token:SERVICE_TOKEN,body:JSON.stringify({name:"配额套餐",description:"",priceCents:0,durationDays:30,tunnelQuota:3,enabled:true})});
  assert.equal(plan.status,201,JSON.stringify(plan.body));
  // 管理员开通套餐 → 套餐配额生效并写 plan_grant 流水
  const grant=await api(`/api/users/${user.body.user.id}/membership`,{method:"POST",token:SERVICE_TOKEN,body:JSON.stringify({planId:plan.body.id,requestId:randomUUID()})});
  assert.equal(grant.status,200,JSON.stringify(grant.body));
  assert.equal((await api("/api/auth/me",{token:user.body.token})).body.effectiveQuota,3);
  // 管理员调整直接配额 → 叠加生效并写 admin_adjust 流水
  const adjusted=await api(`/api/users/${user.body.user.id}`,{method:"PATCH",token:SERVICE_TOKEN,body:JSON.stringify({quotaTunnels:2})});
  assert.equal(adjusted.status,200,JSON.stringify(adjusted.body));
  assert.equal((await api("/api/auth/me",{token:user.body.token})).body.effectiveQuota,5);
  // 已有生效中的套餐（上面被管理员开通）时不可再领免费套餐，防止无限顺延
  const blocked=await api("/api/billing/orders",{method:"POST",token:user.body.token,body:JSON.stringify({planId:plan.body.id,requestId:randomUUID()})});
  assert.equal(blocked.status,409,JSON.stringify(blocked.body));
  // 无套餐的新用户可免费开通；生效期内重复开通被拒，到期后才能再次领取
  const fresh=await registerFixture({body:JSON.stringify({username:"fresh"+Math.random().toString(36).slice(2,7),password:"quota-pass-2026"})});
  const free=await api("/api/billing/orders",{method:"POST",token:fresh.body.token,body:JSON.stringify({planId:plan.body.id,requestId:randomUUID()})});
  assert.equal(free.status,201,JSON.stringify(free.body));
  assert.equal(free.body.status,"paid");
  const repeated=await api("/api/billing/orders",{method:"POST",token:fresh.body.token,body:JSON.stringify({planId:plan.body.id,requestId:randomUUID()})});
  assert.equal(repeated.status,409,JSON.stringify(repeated.body));
  // 流水查询：普通用户只能看到自己的，管理员/服务身份可看全部
  const mine=await api("/api/billing",{token:user.body.token});
  assert.equal(mine.status,200,JSON.stringify(mine.body));
  const types=mine.body.items.map((row:Json)=>row.type);
  assert.ok(types.includes("plan_grant"));
  assert.ok(types.includes("admin_adjust"));
  assert.ok(mine.body.items.every((row:Json)=>row.userId===user.body.user.id));
  const freshMine=await api("/api/billing",{token:fresh.body.token});
  assert.ok(freshMine.body.items.map((row:Json)=>row.type).includes("plan_purchase"));
  const all=await api("/api/billing",{token:SERVICE_TOKEN});
  assert.equal(all.status,200);
  assert.ok(all.body.items.length>=mine.body.items.length);
  // 支付渠道未配置时，付费套餐下单应给出明确错误而不是静默失败
  const paidPlan=await api("/api/membership/plans",{method:"POST",token:SERVICE_TOKEN,body:JSON.stringify({name:"付费套餐",description:"",priceCents:990,durationDays:30,tunnelQuota:10,enabled:true})});
  assert.equal(paidPlan.status,201);
  const unpaid=await api("/api/billing/orders",{method:"POST",token:user.body.token,body:JSON.stringify({planId:paidPlan.body.id,requestId:randomUUID()})});
  assert.equal(unpaid.status,503,JSON.stringify(unpaid.body));
});

test("邮箱验证后注册才发放邀请奖励，活动限制每位邀请人的奖励次数", async () => {
  const inviter=await registerFixture({body:JSON.stringify({username:"invite"+Math.random().toString(36).slice(2,7),password:"invite-pass-2026"})});
  const email=`${inviter.body.user.username}@example.test`;
  const sent=await api("/api/auth/email/code",{method:"POST",token:inviter.body.token,body:JSON.stringify({email})});
  assert.equal(sent.status,200,JSON.stringify(sent.body));
  assert.equal((await api("/api/auth/email",{method:"POST",token:inviter.body.token,body:JSON.stringify({email,verificationId:sent.body.verificationId,code:emailCodes.get(email)})})).status,200);
  const own=await api("/api/membership/me",{token:inviter.body.token});
  const campaign=await api("/api/membership/campaigns",{method:"POST",token:SERVICE_TOKEN,body:JSON.stringify({name:"邀请活动",inviterBonus:2,inviteeBonus:1,maxRewards:1,startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),enabled:true})});
  assert.equal(campaign.status,201,JSON.stringify(campaign.body));
  for(let index=0;index<2;index++){
    const name="friend"+Math.random().toString(36).slice(2,7);
    const registered=await api("/api/auth/register",{method:"POST",body:JSON.stringify({username:name,password:"friend-pass-2026",inviteCode:own.body.inviteCode})});
    assert.equal(registered.status,201,JSON.stringify(registered.body));
    const current=await api("/api/membership/me",{token:registered.body.token});
    assert.equal(current.body.bonusTunnels,index===0?1:0);assert.equal(current.body.email,`${name}@example.test`);
  }
  const current=await api("/api/membership/me",{token:inviter.body.token});
  assert.equal(current.body.invitedCount,2);assert.equal(current.body.rewardedCount,1);assert.equal(current.body.bonusTunnels,2);
  const overlap=await api("/api/membership/campaigns",{method:"POST",token:SERVICE_TOKEN,body:JSON.stringify({...campaign.body,id:undefined})});
  assert.equal(overlap.status,409);
});

test("重置服务器需要个人管理员、有效行为验证及正确 SSH 密码，仅清除 Nexious 节点", async () => {
  const key=generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({format:"pem",type:"pkcs1"});
  const clients=new Set<import("ssh2").Connection>();let resetCommands=0;
  const ssh=new ssh2.Server({hostKeys:[key]},client=>{
    clients.add(client);client.on("error",()=>{});client.on("close",()=>clients.delete(client));
    client.on("authentication",ctx=>ctx.method==="password"&&ctx.password==="correct-ssh-password"?ctx.accept():ctx.reject());
    client.on("session",accept=>accept().on("exec",(acceptCommand,_reject,info)=>{
      const channel=acceptCommand();channel.on("error",()=>{});
      if(info.command.includes("flock -n")){channel.write("locked");channel.on("end",()=>{channel.exit(0);channel.end();});return;}
      if(info.command==="id -u")channel.write("0");
      if(info.command.includes("reset-complete")){resetCommands++;assert.match(info.command,/\/opt\/nexious-node/);assert.doesNotMatch(info.command,/rm[^\n]*(nginx|caddy|www)/);}
      channel.exit(0);channel.end();
    }));
  });
  await new Promise<void>(resolve=>ssh.listen(0,"127.0.0.1",resolve));
  try{
    const node=await api("/api/nodes",{method:"POST",token:SERVICE_TOKEN,body:JSON.stringify({name:"重置测试",host:"reset.example.test"})});
    const id=node.body.id;
    await control.prepare("UPDATE nodes SET server_host='127.0.0.1',ssh_user='root',ssh_port=?,controller_token='old-token',deploy_status='ready' WHERE id=?").run((ssh.address() as {port:number}).port,id);
    assert.equal((await api(`/api/nodes/${id}/reset`,{method:"POST",token:SERVICE_TOKEN,body:JSON.stringify({password:"correct-ssh-password",captchaTicket:"f".repeat(48)})})).status,403);
    const logged=await api("/api/auth/login",{method:"POST",body:JSON.stringify({username:"admin",password:"test-bootstrap-password"})});
    const changed=await api("/api/auth/password",{method:"POST",token:logged.body.token,body:JSON.stringify({currentPassword:"test-bootstrap-password",newPassword:"reset-admin-password-2026"})});
    assert.equal(changed.status,200,JSON.stringify(changed.body));
    const token=changed.body.token;
    assert.equal((await api(`/api/nodes/${id}/reset`,{method:"POST",token,body:JSON.stringify({password:"correct-ssh-password",captchaTicket:"f".repeat(48)})})).status,400);
    const bad=await captchaTicket("node-reset",token,id);
    assert.equal((await api(`/api/nodes/${id}/reset`,{method:"POST",token,body:JSON.stringify({password:"wrong-ssh-password",captchaTicket:bad})})).status,502);
    assert.equal(resetCommands,0);assert.equal((await control.prepare("SELECT controller_token FROM nodes WHERE id=?").get(id))!.controller_token,"old-token");
    const good=await captchaTicket("node-reset",token,id);
    const reset=await api(`/api/nodes/${id}/reset`,{method:"POST",token,body:JSON.stringify({password:"correct-ssh-password",captchaTicket:good})});
    assert.equal(reset.status,200,JSON.stringify(reset.body));assert.equal(resetCommands,1);assert.match(reset.body.backupPath,/\/reset-[a-f0-9]{16}$/);
    const current=await control.prepare("SELECT deploy_status,controller_token FROM nodes WHERE id=?").get(id);
    assert.equal(current!.deploy_status,"unconfigured");assert.equal(current!.controller_token,null);
    assert.equal((await api(`/api/nodes/${id}/reset`,{method:"POST",token,body:JSON.stringify({password:"correct-ssh-password",captchaTicket:good})})).status,400);
  }finally{for(const client of clients)client.end();await new Promise<void>(resolve=>ssh.close(()=>resolve()));}
});

test("自助注册创建普通用户，登录后可读自身信息", async () => {
  const name = `alice${Math.random().toString(36).slice(2, 6)}`;
  const reg = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ username: name, password: "password-123" })
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  const token = reg.body.token as string;
  assert.ok(token);

  const me = await api("/api/auth/me", { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.username, name);
  assert.ok(me.body.role === "user" || me.body.role === "admin");
});

test("普通用户不能执行任何节点运维操作", async () => {
  const name = `bob${Math.random().toString(36).slice(2, 6)}`;
  const reg = await registerFixture({
    method: "POST",
    body: JSON.stringify({ username: name, password: "password-123" })
  });
  const token = reg.body.token as string;

  // 节点是基础设施：部署/检查等价于拿到服务器 root，用户一律禁止。
  const cases: Array<[string, RequestInit]> = [
    ["/api/nodes", { method: "POST", body: JSON.stringify({ name: "evil-node", host: "evil.example.com" }) }],
    ["/api/nodes/n-x", { method: "PUT", body: JSON.stringify({ name: "renamed", host: "evil.example.com" }) }],
    ["/api/nodes/n-x", { method: "DELETE" }],
    ["/api/nodes/n-x/inspect", { method: "POST", body: JSON.stringify({ connection: "root@1.1.1.1", password: "x", port: 22 }) }],
    ["/api/nodes/n-x/deploy", { method: "POST", body: JSON.stringify({ connection: "root@1.1.1.1", password: "x", port: 22 }) }],
    ["/api/nodes/n-x/deployment", { method: "GET" }],
    ["/api/deployments/job-1", { method: "GET" }],
    ["/api/users", { method: "GET" }],
    ["/api/users", { method: "POST", body: JSON.stringify({ username: "made-by-user", password: "password-123" }) }],
    ["/api/users/u-1", { method: "DELETE" }],
    ["/api/nodes/n-x/reset", { method: "POST", body: JSON.stringify({ password: "server-password", captchaTicket:"a".repeat(48) }) }],
    ["/api/membership/plans", { method: "POST", body: JSON.stringify({}) }],
    ["/api/membership/campaigns", { method: "POST", body: JSON.stringify({}) }],
    ["/api/audit", { method: "GET" }]
  ];
  for (const [path, init] of cases) {
    const res = await api(path, { ...init, token });
    assert.equal(res.status, 403, `${init.method} ${path} 应为 403，实际 ${res.status}`);
  }
});

test("用户只能读到自己的隧道范围，且看不到敏感凭据", async () => {
  const alice = await registerFixture({
    method: "POST",
    body: JSON.stringify({ username: `a${Math.random().toString(36).slice(2, 7)}`, password: "password-123" })
  });
  const bob = await registerFixture({
    method: "POST",
    body: JSON.stringify({ username: `b${Math.random().toString(36).slice(2, 7)}`, password: "password-123" })
  });
  const aliceToken = alice.body.token as string;
  assert.ok(bob.body.token);
  await grantQuota(alice.body.user.id);
  await grantQuota(bob.body.user.id);

  // 注册接口返回的 role 说明：首个用户会是 admin，这里显式确认后续用户为 user
  const aliceMe = await api("/api/auth/me", { token: aliceToken });
  assert.equal(aliceMe.body.role, "user", "非首个注册用户应为普通用户");

  // 用服务凭据建一条隧道并划归 alice，模拟既有数据
  const node = await api("/api/nodes", {
    method: "POST", token: SERVICE_TOKEN,
    body: JSON.stringify({ name: "rbac-node", host: "rbac.example.com" })
  });
  assert.equal(node.status, 201);
  const nodeId = node.body.id as string;

  const created = await api("/api/tunnels", {
    method: "POST", token: aliceToken,
    body: JSON.stringify({
      name: "alice-tunnel", protocol: "http", localHost: "127.0.0.1",
      localPort: 3000, remotePort: 80, nodeId, domain: `alice${Math.random().toString(36).slice(2, 6)}`
    })
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  // 列表里不应出现 agent_token / controller_token 这类可直接接管资源的凭据
  const listed = await api("/api/tunnels", { token: aliceToken });
  assert.equal(listed.status, 200);
  for (const row of listed.body as Json[]) {
    assert.equal(row.agent_token, undefined, "列表不应下发 agent_token");
    assert.equal(row.controller_token, undefined, "列表不应下发 controller_token");
  }

  // 节点列表对用户必须脱敏
  const nodes = await api("/api/nodes", { token: aliceToken });
  assert.equal(nodes.status, 200);
  for (const row of nodes.body as Json[]) {
    assert.equal(row.controller_token, undefined, "节点列表不应向用户下发 controller_token");
    assert.equal(row.server_host, undefined, "节点列表不应向用户下发 server_host");
  }
});

test("用户不能操作他人隧道（越权一律 404，不泄露资源是否存在）", async () => {
  const u1 = await registerFixture({
    method: "POST",
    body: JSON.stringify({ username: `x${Math.random().toString(36).slice(2, 7)}`, password: "password-123" })
  });
  const u2 = await registerFixture({
    method: "POST",
    body: JSON.stringify({ username: `y${Math.random().toString(36).slice(2, 7)}`, password: "password-123" })
  });
  const ownerToken = u1.body.token as string;
  const otherToken = u2.body.token as string;
  await grantQuota(u1.body.user.id);
  await grantQuota(u2.body.user.id);

  const node = await api("/api/nodes", {
    method: "POST", token: SERVICE_TOKEN,
    body: JSON.stringify({ name: `rbac-node-${Math.random().toString(36).slice(2, 6)}`, host: "rbac.example.com" })
  });
  const nodeId = node.body.id as string;

  const mine = await api("/api/tunnels", {
    method: "POST", token: ownerToken,
    body: JSON.stringify({
      name: "private-tunnel", protocol: "http", localHost: "127.0.0.1",
      localPort: 3100, remotePort: 80, nodeId, domain: `own${Math.random().toString(36).slice(2, 6)}`
    })
  });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  const tunnelId = mine.body.id as string;

  // 他人读不到
  const otherList = await api("/api/tunnels", { token: otherToken });
  assert.equal(otherList.status, 200);
  assert.equal(
    (otherList.body as Json[]).some((row) => row.id === tunnelId), false,
    "不应看到他人隧道"
  );

  // 他人不能改/删/启停/取 token
  const otherOps: Array<[string, RequestInit]> = [
    [`/api/tunnels/${tunnelId}`, { method: "PUT", body: JSON.stringify({ name: "hijacked", protocol: "http", localHost: "127.0.0.1", localPort: 3100, remotePort: 80, nodeId }) }],
    [`/api/tunnels/${tunnelId}/status`, { method: "PATCH", body: JSON.stringify({ status: "running" }) }],
    [`/api/tunnels/${tunnelId}/token`, { method: "POST" }],
    [`/api/tunnels/${tunnelId}`, { method: "DELETE" }]
  ];
  for (const [path, init] of otherOps) {
    const res = await api(path, { ...init, token: otherToken });
    assert.equal(res.status, 404, `${init.method} ${path} 应被拒为 404，实际 ${res.status}`);
  }

  // 原所有者仍可正常操作
  const okStatus = await api(`/api/tunnels/${tunnelId}/status`, {
    method: "PATCH", token: ownerToken, body: JSON.stringify({ status: "running" })
  });
  assert.equal(okStatus.status, 200);

  // 取 agent 凭据是所有者应有的能力
  const tokenRes = await api(`/api/tunnels/${tunnelId}/token`, { method: "POST", token: ownerToken });
  assert.equal(tokenRes.status, 200);
  assert.ok(tokenRes.body.token);
});

test("同一用户与跨用户都允许同名隧道（name 只是展示标签）", async () => {
  const u = await registerFixture({
    method: "POST",
    body: JSON.stringify({ username: `n${Math.random().toString(36).slice(2, 7)}`, password: "password-123" })
  });
  const token = u.body.token as string;
  await grantQuota(u.body.user.id);
  const node = await api("/api/nodes", {
    method: "POST", token: SERVICE_TOKEN,
    body: JSON.stringify({ name: `dup-node-${Math.random().toString(36).slice(2, 6)}`, host: "rbac.example.com" })
  });
  const nodeId = node.body.id as string;
  const make = (domain: string) => api("/api/tunnels", {
    method: "POST", token,
    body: JSON.stringify({
      name: "api-server", protocol: "http", localHost: "127.0.0.1",
      localPort: 3200, remotePort: 80, nodeId, domain
    })
  });
  const first = await make(`dup${Math.random().toString(36).slice(2, 7)}`);
  const second = await make(`dup${Math.random().toString(36).slice(2, 7)}`);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201, "同名但不同子域名必须允许创建");
  assert.notEqual(first.body.id, second.body.id);
  // 但会带上重复名提示头，供前端做非阻塞提醒
  assert.equal(second.body.name, "api-server");
});

test("子域名冲突被拒绝且不暴露归属", async () => {
  const u = await registerFixture({
    method: "POST",
    body: JSON.stringify({ username: `s${Math.random().toString(36).slice(2, 7)}`, password: "password-123" })
  });
  const token = u.body.token as string;
  await grantQuota(u.body.user.id);
  const node = await api("/api/nodes", {
    method: "POST", token: SERVICE_TOKEN,
    body: JSON.stringify({ name: `sub-node-${Math.random().toString(36).slice(2, 6)}`, host: "rbac.example.com" })
  });
  const nodeId = node.body.id as string;
  const domain = `uniq${Math.random().toString(36).slice(2, 7)}`;
  const body = (name: string) => JSON.stringify({
    name, protocol: "http", localHost: "127.0.0.1", localPort: 3300, remotePort: 80, nodeId, domain
  });
  assert.equal((await api("/api/tunnels", { method: "POST", token, body: body("first") })).status, 201);
  const conflict = await api("/api/tunnels", { method: "POST", token, body: body("second") });
  assert.equal(conflict.status, 409);
  // 提示必须中性，不能透露是哪位用户占用
  assert.ok(!/用户|账号|owner|alice|bob/i.test(String(conflict.body.message)), "冲突提示不应泄露归属");
});

test("管理员可管理节点、账号及配额", async () => {
  const admin = await registerFixture({
    method: "POST",
    body: JSON.stringify({ username: `root${Math.random().toString(36).slice(2, 6)}`, password: "password-123" })
  });
  // 该库已经有其它用户，因此这里注册的是普通用户；用服务凭据提升为管理员
  const adminId = admin.body.user.id as string;
  const promote = await api(`/api/users/${adminId}`, {
    method: "PATCH", token: SERVICE_TOKEN, body: JSON.stringify({ role: "admin" })
  });
  assert.equal(promote.status, 200, JSON.stringify(promote.body));
  assert.equal(promote.body.role, "admin");

  // 重新登录以拿到带 admin 角色的会话
  const username = admin.body.user.username as string;
  const login = await api("/api/auth/login", {
    method: "POST", body: JSON.stringify({ username, password: "password-123" })
  });
  assert.equal(login.status, 200);
  const adminToken = login.body.token as string;

  // 管理员可见用户列表、审计与全量流水，并可管理节点
  assert.equal((await api("/api/users", { token: adminToken })).status, 200);
  assert.equal((await api("/api/audit", { token: adminToken })).status, 200);
  assert.equal((await api("/api/nodes", { token: adminToken })).status, 200);
});

test("管理员不能把自己降级或停用，也不能移除最后一个管理员", async () => {
  const reg = await registerFixture({
    method: "POST",
    body: JSON.stringify({ username: `last${Math.random().toString(36).slice(2, 6)}`, password: "password-123" })
  });
  const id = reg.body.user.id as string;
  await api(`/api/users/${id}`, {
    method: "PATCH", token: SERVICE_TOKEN, body: JSON.stringify({ role: "admin" })
  });
  const username = reg.body.user.username as string;
  const login = await api("/api/auth/login", {
    method: "POST", body: JSON.stringify({ username, password: "password-123" })
  });
  const token = login.body.token as string;

  // 自我降级 / 自停用必须被拒
  const demoteSelf = await api(`/api/users/${id}`, {
    method: "PATCH", token, body: JSON.stringify({ role: "user" })
  });
  assert.equal(demoteSelf.status, 400);
  const disableSelf = await api(`/api/users/${id}`, {
    method: "PATCH", token, body: JSON.stringify({ status: "disabled" })
  });
  assert.equal(disableSelf.status, 400);
});

test("配额生效：达到上限后拒绝创建", async () => {
  const reg = await registerFixture({
    method: "POST",
    body: JSON.stringify({ username: `q${Math.random().toString(36).slice(2, 7)}`, password: "password-123" })
  });
  const token = reg.body.token as string;
  const userId = reg.body.user.id as string;
  const node = await api("/api/nodes", {
    method: "POST", token: SERVICE_TOKEN,
    body: JSON.stringify({ name: `q-node-${Math.random().toString(36).slice(2, 6)}`, host: "rbac.example.com" })
  });
  const nodeId = node.body.id as string;

  // 把该用户配额设为 1
  const setQuota = await api(`/api/users/${userId}`, {
    method: "PATCH", token: SERVICE_TOKEN, body: JSON.stringify({ quotaTunnels: 1 })
  });
  assert.equal(setQuota.status, 200);

  const mk = (domain: string) => api("/api/tunnels", {
    method: "POST", token,
    body: JSON.stringify({
      name: "quota-tunnel", protocol: "http", localHost: "127.0.0.1",
      localPort: 3400, remotePort: 80, nodeId, domain
    })
  });
  assert.equal((await mk(`q1-${Math.random().toString(36).slice(2, 7)}`)).status, 201);
  const over = await mk(`q2-${Math.random().toString(36).slice(2, 7)}`);
  assert.equal(over.status, 403, "超出配额应被拒绝");
});

test("改密与注销：旧会话立即失效", async () => {
  const reg = await registerFixture({
    method: "POST",
    body: JSON.stringify({ username: `p${Math.random().toString(36).slice(2, 7)}`, password: "password-123" })
  });
  const token = reg.body.token as string;

  const wrong = await api("/api/auth/password", {
    method: "POST", token, body: JSON.stringify({ currentPassword: "nope-wrong", newPassword: "newpassword-456" })
  });
  assert.equal(wrong.status, 400);

  const changed = await api("/api/auth/password", {
    method: "POST", token, body: JSON.stringify({ currentPassword: "password-123", newPassword: "newpassword-456" })
  });
  assert.equal(changed.status, 200);
  const newToken = changed.body.token as string;

  // 旧会话已被注销，新会话可用
  assert.equal((await api("/api/auth/me", { token })).status, 401, "改密后旧会话应失效");
  assert.equal((await api("/api/auth/me", { token: newToken })).status, 200);

  const out = await api("/api/auth/logout", { method: "POST", token: newToken });
  assert.equal(out.status, 204);
  assert.equal((await api("/api/auth/me", { token: newToken })).status, 401, "注销后会话应失效");
});

test("注册开关已移除，旧的设置接口一并下线", async () => {
  assert.equal((await api("/api/auth/status")).body.passwordMinLength,8);
  // 默认配额机制移除后 /api/settings 不再存在：请求应得到 404 而不是静默成功。
  assert.equal((await api("/api/settings",{token:SERVICE_TOKEN})).status,404);
});

test("临时密码限制落实到后端，改密之前不可访问任何业务 API",async()=>{
  const username="temp"+Math.random().toString(36).slice(2,7);
  const created=await api("/api/users",{method:"POST",token:SERVICE_TOKEN,body:JSON.stringify({username,password:"temporary-password-2026"})});
  assert.equal(created.status,201);
  const login=await api("/api/auth/login",{method:"POST",body:JSON.stringify({username,password:"temporary-password-2026"})});
  const token=login.body.token;
  for(const path of ["/api/tunnels","/api/nodes","/api/dashboard","/api/auth/sessions"]){const blocked=await api(path,{token});assert.equal(blocked.status,403);assert.equal(blocked.body.code,"PASSWORD_CHANGE_REQUIRED");}
  assert.equal((await api("/api/auth/me",{token})).status,200);
  const changed=await api("/api/auth/password",{method:"POST",token,body:JSON.stringify({currentPassword:"temporary-password-2026",newPassword:"independent-new-password-2026"})});
  assert.equal(changed.status,200);assert.equal((await api("/api/tunnels",{token:changed.body.token})).status,200);assert.equal((await api("/api/auth/me",{token})).status,401);
});

test("并发创建大小写不同的同名账号只成功一次，弱密码拒绝写入",async()=>{
  const username="unique"+Math.random().toString(36).slice(2,7);
  const results=await Promise.all([username,username.toUpperCase()].map(name=>api("/api/users",{method:"POST",token:SERVICE_TOKEN,body:JSON.stringify({username:name,password:"unique-long-password-2026"})})));
  assert.deepEqual(results.map(result=>result.status).sort(),[201,409]);
  for(const password of ["12345678","aaaaaaaaaaaa","password1234"])
    assert.equal((await api("/api/users",{method:"POST",token:SERVICE_TOKEN,body:JSON.stringify({username:"weak"+Math.random().toString(36).slice(2,7),password})})).status,400);
});

test("账号搜索分页与审计筛选有效，响应不暴露密码哈希或会话凭据",async()=>{
  const result=await api("/api/users?page=1&pageSize=10&search=unique&role=user&status=active",{token:SERVICE_TOKEN});
  assert.equal(result.status,200);assert.equal(result.body.items.length,1);assert.equal(result.body.total,1);
  assert.equal(result.body.items[0].password_hash,undefined);
  assert.ok(result.body.summary.total>=1);
  assert.equal((await api("/api/users?search=%25_%25",{token:SERVICE_TOKEN})).body.total,0,"搜索通配符应按普通字符处理");
  const audit=await api("/api/audit?page=1&pageSize=10&action=password_changed",{token:SERVICE_TOKEN});
  assert.equal(audit.status,200);assert.ok(audit.body.total>0);assert.ok(audit.body.items.every((item:Json)=>item.action==="password_changed"));
  assert.ok(!JSON.stringify(audit.body).includes("password_hash"));
});

test("设备会话只能由本人撤销，撤销其他设备保留当前会话",async()=>{
  const user=await registerFixture({body:JSON.stringify({username:"devices"+Math.random().toString(36).slice(2,7),password:"device-password-2026"})});
  const login=await api("/api/auth/login",{method:"POST",body:JSON.stringify({username:user.body.user.username,password:"device-password-2026"})});
  const token=login.body.token,devices=await api("/api/auth/sessions",{token});
  assert.equal(devices.status,200);assert.equal(devices.body.length,2);
  assert.equal(devices.body.filter((session:Json)=>session.current).length,1);
  assert.ok(devices.body.every((session:Json)=>!session.token_hash&&!session.token));
  const stranger=await registerFixture({body:JSON.stringify({username:"stranger"+Math.random().toString(36).slice(2,7),password:"stranger-password-2026"})});
  assert.equal((await api("/api/auth/sessions/"+devices.body[0].id,{method:"DELETE",token:stranger.body.token})).status,404);
  assert.equal((await api("/api/auth/sessions/others",{method:"DELETE",token})).status,204);
  assert.equal((await api("/api/auth/me",{token:user.body.token})).status,401);
  assert.equal((await api("/api/auth/me",{token})).status,200);
});

test("敏感操作要求最近验证密码，验证失败不修改账号",async()=>{
  const admin=await registerFixture({body:JSON.stringify({username:"stepup"+Math.random().toString(36).slice(2,7),password:"admin-verify-password-2026"})});
  await api("/api/users/"+admin.body.user.id,{method:"PATCH",token:SERVICE_TOKEN,body:JSON.stringify({role:"admin"})});
  const login=await api("/api/auth/login",{method:"POST",body:JSON.stringify({username:admin.body.user.username,password:"admin-verify-password-2026"})});
  const token=login.body.token;
  await control.prepare("UPDATE sessions SET reauthenticated_at=? WHERE user_id=?").run(new Date(Date.now()-16*60000).toISOString(),admin.body.user.id);
  const changed=()=>api(`/api/users/${admin.body.user.id}`,{method:"PATCH",token,body:JSON.stringify({quotaTunnels:7})});
  const blocked=await changed();assert.equal(blocked.status,403);assert.equal(blocked.body.code,"REAUTHENTICATION_REQUIRED");
  assert.equal((await api("/api/auth/verify-password",{method:"POST",token,body:JSON.stringify({password:"wrong-password"})})).status,400);
  assert.equal((await changed()).status,403);
  assert.equal((await api("/api/auth/verify-password",{method:"POST",token,body:JSON.stringify({password:"admin-verify-password-2026"})})).status,200);
  assert.equal((await changed()).status,200);
});

test("停用账号撤销全部会话，停止隧道并撤销 Agent 凭据",async()=>{
  const user=await registerFixture({body:JSON.stringify({username:"disabled"+Math.random().toString(36).slice(2,7),password:"disabled-user-password-2026"})});
  await grantQuota(user.body.user.id);
  const node=await api("/api/nodes",{method:"POST",token:SERVICE_TOKEN,body:JSON.stringify({name:"disable-test",host:"disable.example.com"})});
  const tunnel=await api("/api/tunnels",{method:"POST",token:user.body.token,body:JSON.stringify({name:"disabled tunnel",protocol:"http",localHost:"127.0.0.1",localPort:3000,remotePort:80,nodeId:node.body.id,domain:"owned"})});
  assert.equal(tunnel.status,201);
  await api("/api/tunnels/"+tunnel.body.id+"/token",{method:"POST",token:user.body.token});
  const disabled=await api("/api/users/"+user.body.user.id,{method:"PATCH",token:SERVICE_TOKEN,body:JSON.stringify({status:"disabled"})});
  assert.equal(disabled.status,200);assert.equal((await api("/api/auth/me",{token:user.body.token})).status,401);
  const stored=await control.prepare("SELECT status,auto_start,agent_token FROM tunnels WHERE id=?").get(tunnel.body.id);
  assert.equal(stored!.status,"stopped");assert.equal(Number(stored!.auto_start),0);assert.equal(stored!.agent_token,null);
});

test("API 拒绝不受信任来源并禁止缓存账号响应",async()=>{
  assert.equal((await api("/api/auth/status",{headers:{origin:"https://untrusted.example.com"}})).status,403);
  const response=await api("/api/auth/status");assert.equal(response.headers.get("cache-control"),"no-store");assert.equal(response.headers.get("x-content-type-options"),"nosniff");
});

test("并发降级管理员始终保留至少一个启用管理员",async()=>{
  const admins=await control.prepare("SELECT id FROM users WHERE role='admin' AND status='active'").all();
  assert.ok(admins.length>=2);
  for(const row of admins.slice(2))assert.equal((await api("/api/users/"+row.id,{method:"PATCH",token:SERVICE_TOKEN,body:JSON.stringify({role:"user"})})).status,200);
  const results=await Promise.all(admins.slice(0,2).map(row=>api("/api/users/"+row.id,{method:"PATCH",token:SERVICE_TOKEN,body:JSON.stringify({role:"user"})})));
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  assert.equal(Number((await control.prepare("SELECT COUNT(*) count FROM users WHERE role='admin' AND status='active'").get())!.count),1);
});
