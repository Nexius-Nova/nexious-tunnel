import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import ssh2, { type ServerChannel } from "ssh2";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import {
  activationDeploymentScript, caddyRepositoryKeyScript, controllerCandidates, describeSshFailure, describeTcpFailure,
  nodeEnvironmentSetupScript, parseRemoteConfiguration, probeTcp,
  redactDeploymentError, rollbackDeploymentScript, resetNodeScript, resolveControllerSourceRoot, type DeploymentPaths
} from "./nodeDeployment.js";

test("部署配置严格检查管理令牌与端口", () => {
  assert.deepEqual(parseRemoteConfiguration("test-token-123456\n8788"), { token: "test-token-123456", port: 8788 });
  assert.deepEqual(parseRemoteConfiguration("test-token-123456\r\n\r\n8788\r\n"), { token: "test-token-123456", port: 8788 });
  for (const value of ["", "short\n8788", "test-token-123456\nNaN", "test-token-123456\n0", "test-token-123456\n65536", "'shell injection'\n8788"])
    assert.equal(parseRemoteConfiguration(value), null);
});
test("优先保留节点自己的 HTTPS 入口，不采用其他域名或 URL 凭据", () => {
  // preferred 允许历史遗留的 demo.* 入口（以基础域名为后缀即可），硬编码候选已随域名改名从 demo.* 切换为 node.*
  assert.deepEqual(controllerCandidates("203.0.113.9", 8788, "example.com", "https://demo.example.com/api"),
    ["https://demo.example.com/api", "https://example.com/api", "https://node.example.com/api", "http://example.com/api", "http://node.example.com/api", "http://203.0.113.9:8788/api"]);
  assert.equal(controllerCandidates("203.0.113.9", 8788, "example.com", "http://203.0.113.9:8788/api")[0], "https://example.com/api");
  for (const value of ["https://other.example/api", "https://example.com.attacker.test/api", "https://user:secret@example.com/api"])
    assert.equal(controllerCandidates("203.0.113.9", 8788, "example.com", value).includes(value), false);
  assert.deepEqual(controllerCandidates("2001:db8::1", 8788), ["http://[2001:db8::1]:8788/api"]);
});
test("部署异常不会将密码或管理、中继令牌写入日志", () => {
  const message = redactDeploymentError('password: p\'a$ss Bearer unknown-token NEXIOUS_ADMIN_TOKEN=env-secret /relay?token=url-secret {"agent_token":"agent-secret"}', ["p'a$ss"]);
  for (const value of ["p'a$ss", "unknown-token", "env-secret", "url-secret", "agent-secret"]) assert.equal(message.includes(value), false);
});
test("连接失败时能区分端口不通与协议握手失败并给出排查方向", async () => {
  const credentials = { host: "203.0.113.9", port: 2222, username: "root", password: "secret" };
  assert.match(describeTcpFailure(credentials, "timeout"), /端口不通/);
  assert.match(describeTcpFailure(credentials, "refused"), /拒绝连接/);
  assert.match(describeTcpFailure(credentials, "dns"), /无法解析/);
  assert.match(describeTcpFailure(credentials, "unreachable"), /网络不可达/);
  const auth = Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" });
  assert.match(describeSshFailure(credentials, auth), /拒绝了用户名或密码/);
  assert.match(describeSshFailure(credentials, Object.assign(new Error("read ECONNRESET"), {})), /连接在握手过程中被中断/);
  const probe = await probeTcp("127.0.0.1", 1, 2000);
  assert.equal(probe, "refused");
});
test("打包和开发环境都能定位完整节点源码", () => {
  const root = resolveControllerSourceRoot();
  assert.ok(root);
  for (const file of ["index.ts", "db.ts", "database.ts", "mysqlSchema.ts", "accountSchema.ts", "auth.ts", "accounts.ts", "verification.ts", "membership.ts", "nodeDeployment.ts", "nodeController.ts", "proxyHeaders.ts", "util.ts"])
    assert.equal(existsSync(join(root, file)), true);
  assert.equal(resolveControllerSourceRoot(join(root, "../dist")), root);
});

// 在临时目录执行真正的部署脚本，仅替换系统服务和网络命令。
const bash = process.platform === "win32"
  ? resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../bin/bash.exe") : "bash";
const shellPath = (value: string) => process.platform === "win32"
  ? value.replaceAll("\\", "/").replace(/^([a-z]):/i, (_match, drive: string) => `/${drive.toLowerCase()}`)
  : value;
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nexious-deployment-"));
  const work = join(root, "release's test");
  const paths: DeploymentPaths = { app: join(work, "app"), staged: join(work, "staged"), backup: join(work, "backup"),
    config: join(work, "config"), state: join(work, "state"), service: join(work, "service") };
  for (const value of Object.values(paths)) assert.ok(resolve(value).startsWith(resolve(root) + sep));
  for (const value of [paths.app, paths.staged, paths.backup, paths.config, paths.state, join(work, "bin")]) mkdirSync(value, { recursive: true });
  writeFileSync(join(paths.app, "version"), "old");
  writeFileSync(join(paths.staged, "version"), "new");
  writeFileSync(join(paths.config, "token"), "test-token-original");
  writeFileSync(join(paths.config, "port"), "8788");
  writeFileSync(paths.service, "old-service");
  writeFileSync(join(paths.state, "nexious.db"), "old-database");
  writeFileSync(join(paths.state, "nexious.db-wal"), "old-wal");
  writeFileSync(join(work, "active"), "");
  writeFileSync(join(work, "enabled"), "");
  const commands: Record<string, string> = {
    systemctl: `#!/bin/sh
printf '%s\\n' "$*" >> "$NEXIOUS_TEST_ROOT/service.log"
case "$1" in
  is-active) test -f "$NEXIOUS_TEST_ROOT/active";;
  is-enabled) test -f "$NEXIOUS_TEST_ROOT/enabled";;
  stop) rm -f "$NEXIOUS_TEST_ROOT/active";;
  start) touch "$NEXIOUS_TEST_ROOT/active";;
  enable) touch "$NEXIOUS_TEST_ROOT/enabled"; if test "$2" = --now; then test "$NEXIOUS_TEST_FAIL_START" != 1 || exit 1; touch "$NEXIOUS_TEST_ROOT/active"; fi;;
  disable) rm -f "$NEXIOUS_TEST_ROOT/enabled";;
esac
exit $?
`,
    curl: `#!/bin/sh
printf changed-by-new-version > "$NEXIOUS_TEST_ROOT/state/nexious.db"
test "$NEXIOUS_TEST_FAIL_HEALTH" != 1
`,
    sleep: "#!/bin/sh\nexit 0\n", journalctl: "#!/bin/sh\nexit 0\n", chown: "#!/bin/sh\nexit 0\n"
  };
  for (const [name, content] of Object.entries(commands)) writeFileSync(join(work, "bin", name), content, { mode: 0o755 });
  const posixPaths = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, shellPath(value)])) as unknown as DeploymentPaths;
  writeFileSync(join(paths.backup, "rollback.sh"), rollbackDeploymentScript(posixPaths));
  const run = (script: string, extra: Record<string, string> = {}) => {
    writeFileSync(join(work, "run.sh"), script);
    return spawnSync(bash, ["--noprofile", "--norc", "-c", `export PATH=${shellQuote(shellPath(join(work, "bin")))}:$PATH; sh ${shellQuote(shellPath(join(work, "run.sh")))}`],
      { encoding: "utf8", env: { ...process.env, NEXIOUS_TEST_ROOT: shellPath(work), ...extra }, timeout: 30000 });
  };
  const cleanup = () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("nexious-deployment-"));
    rmSync(root, { recursive: true, force: true });
  };
  return { root, work, paths, posixPaths, run, cleanup };
}

test("软件源更新失败立即中止，不继续安装或检查 SQLite", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.work, "bin/apt-get"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NEXIOUS_TEST_ROOT/environment.log"\nexit 37\n', { mode: 0o755 });
    writeFileSync(join(f.work, "bin/node"), '#!/bin/sh\nprintf node >> "$NEXIOUS_TEST_ROOT/environment.log"\n', { mode: 0o755 });
    const result = f.run(nodeEnvironmentSetupScript(true));
    assert.equal(result.status, 37, result.stderr || String(result.error));
    assert.equal(readFileSync(join(f.work, "environment.log"), "utf8").trim(), "update -y");
  } finally { f.cleanup(); }
});

test("NodeSource 配置失败时不继续使用旧 Node.js 部署", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.work, "bin/apt-get"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NEXIOUS_TEST_ROOT/environment.log"\n', { mode: 0o755 });
    writeFileSync(join(f.work, "bin/curl"), `#!/bin/sh
while test "$#" -gt 0; do
  if test "$1" = -o; then shift; printf '#!/bin/sh\\nexit 38\\n' > "$1"; fi
  shift
done
`, { mode: 0o755 });
    writeFileSync(join(f.work, "bin/node"), '#!/bin/sh\nprintf node >> "$NEXIOUS_TEST_ROOT/environment.log"\n', { mode: 0o755 });
    const result = f.run(nodeEnvironmentSetupScript(true));
    assert.equal(result.status, 38, result.stderr || String(result.error));
    assert.equal(readFileSync(join(f.work, "environment.log"), "utf8").trim(), "update -y\ninstall -y curl ca-certificates");
  } finally { f.cleanup(); }
});

test("Caddy 密钥更新可重复执行，下载或转换失败保留原密钥", () => {
  const f = fixture();
  try {
    const keyring = join(f.work, "caddy-key.gpg");
    writeFileSync(keyring, "old-key");
    writeFileSync(join(f.work, "bin/curl"), `#!/bin/sh
test "$NEXIOUS_TEST_FAIL_DOWNLOAD" != 1 || exit 39
while test "$#" -gt 0; do
  if test "$1" = -o; then shift; printf downloaded-key > "$1"; fi
  shift
done
`, { mode: 0o755 });
    writeFileSync(join(f.work, "bin/gpg"), `#!/bin/sh
while test "$#" -gt 0; do
  if test "$1" = --output; then shift; printf new-key > "$1"; fi
  shift
done
test "$NEXIOUS_TEST_FAIL_CONVERT" != 1 || exit 40
`, { mode: 0o755 });
    const script = `set -e\n${caddyRepositoryKeyScript(shellPath(keyring))}`;
    for (const [variable, code] of [["DOWNLOAD", 39], ["CONVERT", 40]] as const) {
      assert.equal(f.run(script, { [`NEXIOUS_TEST_FAIL_${variable}`]: "1" }).status, code);
      assert.equal(readFileSync(keyring, "utf8"), "old-key");
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = f.run(script);
      assert.equal(result.status, 0, result.stderr || String(result.error));
      assert.equal(readFileSync(keyring, "utf8"), "new-key");
    }
  } finally { f.cleanup(); }
});

test("新服务验证成功后保留备份、原令牌和端口", () => {
  const f = fixture();
  try {
    const result = f.run(activationDeploymentScript(f.posixPaths, "test-token-original", 8788, "new-service"));
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(readFileSync(join(f.paths.app, "version"), "utf8"), "new");
    assert.equal(readFileSync(join(f.paths.backup, "app/version"), "utf8"), "old");
    assert.equal(readFileSync(join(f.paths.config, "token"), "utf8"), "test-token-original");
    assert.equal(readFileSync(join(f.paths.config, "port"), "utf8"), "8788");
    assert.equal(existsSync(join(f.paths.backup, "rolled-back")), false);
  } finally { f.cleanup(); }
});

for (const failure of ["START", "HEALTH"]) test(`${failure === "START" ? "启动" : "认证"}失败自动恢复旧服务、令牌、端口和数据库`, () => {
  const f = fixture();
  try {
    const result = f.run(activationDeploymentScript(f.posixPaths, "test-token-new-version", 8790, "new-service"), { [`NEXIOUS_TEST_FAIL_${failure}`]: "1" });
    assert.equal(result.status, 1, result.stderr || String(result.error));
    assert.equal(readFileSync(join(f.paths.app, "version"), "utf8"), "old");
    assert.equal(readFileSync(f.paths.service, "utf8"), "old-service");
    assert.equal(readFileSync(join(f.paths.config, "token"), "utf8"), "test-token-original");
    assert.equal(readFileSync(join(f.paths.config, "port"), "utf8"), "8788");
    assert.equal(readFileSync(join(f.paths.state, "nexious.db"), "utf8"), "old-database");
    assert.equal(readFileSync(join(f.paths.state, "nexious.db-wal"), "utf8"), "old-wal");
    assert.equal(existsSync(join(f.work, "active")), true);
    assert.equal(existsSync(join(f.work, "enabled")), true);
    assert.equal(f.run(rollbackDeploymentScript(f.posixPaths)).status, 0);
    assert.equal(readFileSync(join(f.paths.app, "version"), "utf8"), "old");
  } finally { f.cleanup(); }
});

test("数据库快照失败时恢复运行中的旧服务而不切换版本", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.work, "bin/cp"), '#!/bin/sh\ncase "$2" in */nexious.db*) exit 42;; esac\n/usr/bin/cp "$@"\n', { mode: 0o755 });
    const result = f.run(activationDeploymentScript(f.posixPaths, "test-token-new-version", 8790, "new-service"));
    assert.equal(result.status, 42, result.stderr || String(result.error));
    assert.equal(readFileSync(join(f.paths.app, "version"), "utf8"), "old");
    assert.equal(existsSync(join(f.work, "active")), true);
    assert.equal(readFileSync(join(f.paths.state, "nexious.db"), "utf8"), "old-database");
  } finally { f.cleanup(); }
});

test("重置先停止并完整备份节点，保留其他网站，备份失败恢复原服务", () => {
  const replacePaths = (script:string,f:ReturnType<typeof fixture>) => {
    const mappings:[[string,string],[string,string],[string,string],[string,string],[string,string]]=[
      ["/var/backups/nexious-node/reset-0123456789abcdef",f.posixPaths.backup],
      ["/etc/systemd/system/nexious-node.service",f.posixPaths.service],
      ["/opt/nexious-node",f.posixPaths.app],["/etc/nexious-node",f.posixPaths.config],["/var/lib/nexious-node",f.posixPaths.state]
    ];
    for(const [index,[from,to]] of mappings.entries())script= index === 0 ? script.replaceAll(shellQuote(from),shellQuote(to)) : script.replaceAll(from,shellQuote(to));
    assert.doesNotMatch(script,/\/opt\/nexious-node|\/etc\/nexious-node|\/var\/lib\/nexious-node|\/etc\/systemd\/system\/nexious-node/);
    return script;
  };
  assert.throws(()=>resetNodeScript("/var/backups/../../etc"));
  for(const fail of [false,true]){
    const f=fixture();
    try{
      const unrelated=join(f.work,"website");mkdirSync(unrelated);writeFileSync(join(unrelated,"index.html"),"other-site");
      if(fail)writeFileSync(join(f.work,"bin","cp"),"#!/bin/sh\nexit 1\n",{mode:0o755});
      const result=f.run(replacePaths(resetNodeScript("/var/backups/nexious-node/reset-0123456789abcdef"),f));
      assert.equal(readFileSync(join(unrelated,"index.html"),"utf8"),"other-site");
      if(fail){assert.notEqual(result.status,0);assert.equal(existsSync(join(f.work,"active")),true);assert.equal(readFileSync(join(f.paths.config,"token"),"utf8"),"test-token-original");}
      else{
        assert.equal(result.status,0,result.stderr);
        for(const key of ["app","config","state","service"] as const){
          assert.equal(existsSync(f.paths[key]),false);
          const copied=join(f.paths.backup,f.posixPaths[key].slice(1));assert.equal(existsSync(copied),true,copied);
        }
        assert.equal(existsSync(join(f.work,"active")),false);assert.equal(existsSync(join(f.work,"enabled")),false);
      }
    }finally{f.cleanup();}
  }
});

test("部署 API 拦截重复操作、恢复后台进度，冲突不会修改节点配置", async () => {
  const root = mkdtempSync(join(tmpdir(), "nexious-deployment-"));
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs1" });
  let blocked: ServerChannel | undefined;
  const sshClients = new Set<import("ssh2").Connection>();
  const ssh = new ssh2.Server({ hostKeys: [key] }, (client) => {
    sshClients.add(client);
    client.on("close", () => sshClients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (context) => context.accept());
    client.on("session", (accept) => {
      accept().on("exec", (acceptCommand, _reject, info) => {
        const channel = acceptCommand();
        channel.on("error", () => {});
        if (info.command.includes("flock -n")) {
          channel.write("locked");
          channel.on("end", () => { channel.exit(0); channel.end(); });
        } else if (info.command.includes("node -v")) blocked = channel;
        else { if (info.command === "id -u") channel.write("0\n"); channel.exit(0); channel.end(); }
      });
    });
  });
  await new Promise<void>(resolveListen => ssh.listen(0, "127.0.0.1", resolveListen));
  const sshPort = (ssh.address() as { port:number }).port;
  const reservation = createServer();
  await new Promise<void>(resolveListen => reservation.listen(0, "127.0.0.1", resolveListen));
  const port = (reservation.address() as { port:number }).port;
  await new Promise<void>(resolveClose => reservation.close(() => resolveClose()));
  const apiProcess = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: resolveControllerSourceRoot()! + "/..",
    env: { ...process.env, NEXIOUS_DB_DRIVER:"sqlite", NEXIOUS_SQLITE_TEST:"1", NEXIOUS_BOOTSTRAP_ADMIN_PASSWORD:"test-bootstrap-password", PORT:String(port), BIND_HOST:"127.0.0.1", NEXIOUS_DB_PATH:join(root,"api.db"),
      NEXIOUS_NODE_CONTROLLER:"0", NEXIOUS_ADMIN_TOKEN:"test-controller-token" }, stdio:["ignore","pipe","pipe"] });
  let output = "";
  apiProcess.stdout.on("data", data => output += data);
  apiProcess.stderr.on("data", data => output += data);
  const request = (path:string, method="GET", body?:unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers:{authorization:"Bearer test-controller-token","content-type":"application/json"},
    ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(5000)
  });
  try {
    let ready = false;
    for(let attempt=0;attempt<60&&!ready;attempt++) {
      try { ready=(await request("/api/health")).ok; } catch { await delay(50); }
    }
    assert.ok(ready, output);
    const first = await request("/api/nodes","POST",{name:"Test node",host:"example.com"}).then(r=>r.json());
    const second = await request("/api/nodes","POST",{name:"Other node",host:"other.example.com"}).then(r=>r.json());
    const input = {connection:"test@127.0.0.1",password:"test-password",port:sshPort};
    const started = await request(`/api/nodes/${first.id}/deploy`,"POST",input);
    assert.equal(started.status,202);
    const {jobId} = await started.json();
    for(let attempt=0;attempt<60&&!blocked;attempt++) await delay(25);
    assert.ok(blocked,JSON.stringify(await request(`/api/deployments/${jobId}`).then(r=>r.json())));
    assert.equal((await request(`/api/nodes/${first.id}/deployment`).then(r=>r.json())).jobId,jobId);
    assert.equal((await request(`/api/deployments/${jobId}?cursor=999`).then(r=>r.json())).status,"running");
    assert.equal((await request(`/api/nodes/${second.id}/deploy`,"POST",input)).status,409);
    assert.equal((await request(`/api/nodes/${first.id}/deploy`,"POST",{...input,connection:"test@different.test"})).status,409);
    assert.equal((await request(`/api/nodes/${first.id}/inspect`,"POST",input)).status,409);
    assert.equal((await request(`/api/nodes/${first.id}`,"PUT",{name:"Changed",host:"changed.example.com"})).status,409);
    assert.equal((await request(`/api/nodes/${first.id}`,"DELETE")).status,409);
    const nodes = await request("/api/nodes").then(r=>r.json());
    assert.equal(nodes.find((node:{id:string})=>node.id===first.id).server_host,"127.0.0.1");
    assert.equal(nodes.find((node:{id:string})=>node.id===second.id).server_host,null);
    blocked.stderr.write("simulated dependency failure");blocked.exit(1);blocked.end();
    let job = {status:"running"};
    for(let attempt=0;attempt<60&&job.status==="running";attempt++) { await delay(25); job=await request(`/api/deployments/${jobId}`).then(r=>r.json()); }
    assert.equal(job.status,"error");
    assert.equal((await request(`/api/nodes/${first.id}/deployment`).then(r=>r.json())).jobId,null);
  } finally {
    apiProcess.kill();
    if(apiProcess.exitCode===null) await once(apiProcess,"exit");
    for(const client of sshClients) client.end();
    await new Promise<void>(resolveClose => ssh.close(()=>resolveClose()));
    assert.equal(dirname(resolve(root)),resolve(tmpdir()));
    assert.ok(basename(root).startsWith("nexious-deployment-"));
    rmSync(root,{recursive:true,force:true});
  }
});
