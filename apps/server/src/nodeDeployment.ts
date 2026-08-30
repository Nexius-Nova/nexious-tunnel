import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ServerCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface DeploymentResult {
  alreadyConfigured: boolean;
  controllerUrl: string;
  token: string;
  version: string;
}

function connect(credentials: ServerCredentials): Promise<Client> {
  return new Promise((resolveConnection, reject) => {
    const client = new Client();
    const config: ConnectConfig = {
      host: credentials.host,
      port: credentials.port,
      username: credentials.username,
      password: credentials.password,
      readyTimeout: 12_000,
      keepaliveInterval: 5_000
    };
    client.once("ready", () => resolveConnection(client));
    client.once("error", reject);
    client.connect(config);
  });
}

function exec(client: Client, command: string): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let output = "", stderr = "";
      stream.on("data", (data: Buffer) => output += data.toString());
      stream.stderr.on("data", (data: Buffer) => stderr += data.toString());
      stream.on("close", (code: number) => code === 0
        ? resolveCommand(output.trim())
        : reject(new Error((stderr || output || `命令退出码 ${code}`).trim())));
    });
  });
}

function sftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolveSftp, reject) => client.sftp((error, value) => error ? reject(error) : resolveSftp(value)));
}

function upload(wrapper: SFTPWrapper, local: string, remote: string): Promise<void> {
  return new Promise((resolveUpload, reject) => wrapper.fastPut(local, remote, (error) => error ? reject(error) : resolveUpload()));
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const sudo = (password: string, command: string) => `printf '%s\\n' ${quote(password)} | sudo -S -p '' sh -c ${quote(command)}`;
const controllerSourceFiles = ["index.ts", "db.ts", "nodeDeployment.ts", "proxyHeaders.ts", "util.ts"] as const;

export function resolveControllerSourceRoot(
  moduleRoot = resolve(fileURLToPath(new URL(".", import.meta.url))),
  workingDirectory = process.cwd()
): string | null {
  const candidates = [
    moduleRoot,
    resolve(moduleRoot, "../src"),
    resolve(workingDirectory, "apps/server/src"),
    resolve(workingDirectory, "server/src"),
    resolve(workingDirectory, "resources/server/src")
  ];
  return [...new Set(candidates)].find((candidate) =>
    controllerSourceFiles.every((file) => existsSync(resolve(candidate, file)))
  ) || null;
}

// 探测源站本机是否已有 HTTPS 反向代理（nginx/caddy 等）把 <host>:443 指向控制中心。
// --resolve 强制直连本机 443，绕过 Cloudflare 等外部代理，验证的是源站自身的链路。
async function detectExistingHttpsProxy(
  client: Client,
  host: string,
  port: number,
  token: string,
  log: (message: string) => void
): Promise<boolean> {
  const probe = await exec(
    client,
    `curl -fsSk --max-time 8 --resolve ${host}:443:127.0.0.1 -H 'Authorization: Bearer ${token}' https://${host}/api/tunnels 2>/dev/null || true`
  ).catch(() => "");
  if (probe.trim().startsWith("[")) {
    log(`检测到源站 443 端口已有 HTTPS 反向代理并连通控制中心（127.0.0.1:${port}），复用现有 TLS 入口`);
    return true;
  }
  return false;
}

// 尝试用 Caddy 为节点控制中心启用自动 HTTPS（Let's Encrypt）。
// 返回 false 表示 HTTPS 不可用（安装失败、80/443 被占用、DNS 未解析或证书签发失败），
// 调用方应回退到 HTTP 明文模式并提示用户。
async function enableHttps(
  client: Client,
  host: string,
  port: number,
  token: string,
  password: string,
  log: (message: string) => void
): Promise<boolean> {
  // 80/443 已被现有 Web 服务（nginx 等）占用时直接放弃 Caddy，避免安装后绑定失败。
  const listening = await exec(client, "ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null").catch(() => "");
  if (/[:.](80|443)\s/.test(listening)) {
    log("检测到 80/443 端口已被现有 Web 服务占用，跳过 Caddy 自动 HTTPS");
    return false;
  }
  try {
    await exec(client, sudo(
      password,
      // 先试发行版仓库；Debian 11 等老版本不含 caddy，再走 Caddy 官方 apt 源兜底。
      "command -v caddy >/dev/null 2>&1 || (apt-get update -y >/dev/null 2>&1 && apt-get install -y caddy >/dev/null 2>&1) || (apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null 2>&1 && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null; curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list 2>/dev/null; apt-get update -y >/dev/null 2>&1 && apt-get install -y caddy >/dev/null 2>&1) || (dnf install -y epel-release >/dev/null 2>&1 && dnf install -y caddy >/dev/null 2>&1) || (yum install -y epel-release >/dev/null 2>&1 && yum install -y caddy >/dev/null 2>&1) || apk add --no-cache caddy >/dev/null 2>&1"
    ));
  } catch {
    log("未能自动安装 Caddy");
    return false;
  }
  log("配置 Caddy 反向代理，等待自动证书签发（约 30 秒）");
  const caddyfile = `${host} {\n  reverse_proxy 127.0.0.1:${port}\n}`;
  const caddySetup = [
    "mkdir -p /etc/caddy",
    `printf %s ${quote(caddyfile)} > /etc/caddy/Caddyfile`,
    "if command -v ufw >/dev/null; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi",
    "if command -v firewall-cmd >/dev/null; then firewall-cmd --permanent --add-port=80/tcp >/dev/null && firewall-cmd --permanent --add-port=443/tcp >/dev/null && firewall-cmd --reload >/dev/null; fi",
    "systemctl enable caddy >/dev/null 2>&1 || true",
    "systemctl restart caddy"
  ].join(" && ");
  try {
    await exec(client, sudo(password, caddySetup));
  } catch (error) {
    log(`Caddy 配置失败：${error instanceof Error ? error.message : error}`);
    return false;
  }
  const probe = await exec(
    client,
    `for i in $(seq 1 45); do if curl -fsS --max-time 5 -H 'Authorization: Bearer ${token}' https://${host}/api/health 2>/dev/null; then exit 0; fi; sleep 1; done; exit 1`
  ).catch(() => "");
  return probe.includes('"ok":true');
}

export async function deployNode(credentials: ServerCredentials, log: (message:string)=>void = ()=>{}, force=false, publicHost?: string): Promise<DeploymentResult> {
  // HTTPS 只能采用"包含字母的域名"：纯 IP 形式的 https 地址（如 https://1.2.3.4/api）
  // 无法通过任何客户端的证书校验，agent 与主控都会连接失败。
  const certDomain = [publicHost, credentials.host].find((value) => !!value && /[a-z]/i.test(value)) || null;
  log(`正在连接 ${credentials.username}@${credentials.host}:${credentials.port}`);
  const client = await connect(credentials);
  try {
    log("SSH 连接成功，检查远程系统和 Node.js 环境");
    // 逐项探测而非一次性粗判：环境已满足时完全跳过安装，避免覆盖服务器上已有的 Node.js。
    const nodeVersion = (await exec(client, "node -v 2>/dev/null || true").catch(() => "")).trim();
    const hasNpm = (await exec(client, "command -v npm >/dev/null 2>&1 && echo yes || echo no").catch(() => "no")).trim() === "yes";
    const hasCurl = (await exec(client, "command -v curl >/dev/null 2>&1 && echo yes || echo no").catch(() => "no")).trim() === "yes";
    const nodeMajor = Number((nodeVersion.match(/v(\d+)/) || [])[1] || 0);
    if (nodeMajor >= 20 && hasNpm && hasCurl) {
      log(`远程环境已满足要求（Node.js ${nodeVersion}、npm、curl），跳过环境安装`);
    } else {
      const missing: string[] = [];
      if (nodeMajor < 20) missing.push(nodeVersion ? `Node.js 20（当前 ${nodeVersion}）` : "Node.js 20");
      if (!hasNpm) missing.push("npm");
      if (!hasCurl) missing.push("curl");
      log(`远程环境缺少 ${missing.join("、")}，开始自动安装`);
      if (nodeMajor < 20) {
        log("Node.js/npm/curl 环境不完整，开始自动安装 Node.js 20 LTS");
        const prepare = [
          "if command -v apt-get >/dev/null; then",
          "apt-get update -y && apt-get install -y ca-certificates curl;",
          "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs;",
          "elif command -v dnf >/dev/null; then",
          "dnf install -y ca-certificates curl; curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && dnf install -y nodejs;",
          "elif command -v yum >/dev/null; then",
          "yum install -y ca-certificates curl; curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs;",
          "elif command -v apk >/dev/null; then",
          "apk add --no-cache nodejs npm curl ca-certificates;",
          "else echo '不支持的 Linux 包管理器，无法自动安装 Node.js' >&2; exit 42;",
          "fi;",
          "node -e 'if(Number(process.versions.node.split(\".\")[0])<20)process.exit(1)';",
          "command -v npm >/dev/null; command -v curl >/dev/null"
        ].join(" ");
        await exec(client, sudo(credentials.password, prepare));
        log("Node.js 20、npm 和 curl 已准备完成");
      } else {
        // Node.js 已满足要求，仅补齐缺失的 npm/curl，不覆盖现有 Node.js。
        const fill = [
          "if command -v apt-get >/dev/null; then apt-get update -y >/dev/null 2>&1; apt-get install -y npm curl >/dev/null 2>&1;",
          "elif command -v dnf >/dev/null; then dnf install -y npm curl >/dev/null 2>&1;",
          "elif command -v yum >/dev/null; then yum install -y npm curl >/dev/null 2>&1;",
          "elif command -v apk >/dev/null; then apk add --no-cache npm curl >/dev/null 2>&1;",
          "fi;",
          "command -v npm >/dev/null && command -v curl >/dev/null"
        ].join(" ");
        await exec(client, sudo(credentials.password, fill));
        log("npm 和 curl 已准备完成（保留原有 Node.js）");
      }
    }
    log("Node.js 环境符合要求，检查已有控制中心");
    const existing = await exec(client, "test -f /etc/nexious-node/token && test -f /etc/nexious-node/port && printf '%s:%s' \"$(cat /etc/nexious-node/token)\" \"$(cat /etc/nexious-node/port)\" || true");
    if (existing) {
      const separator=existing.lastIndexOf(":"),existingToken=existing.slice(0,separator),existingPort=Number(existing.slice(separator+1));
      const active=await exec(client,"systemctl is-active nexious-node 2>/dev/null || true");
      const health = active==="active" ? await exec(client, `curl -fsS -H 'Authorization: Bearer ${existingToken}' http://127.0.0.1:${existingPort}/api/health || true`) : "";
      if (health.includes('"ok":true') && !force) {
        // 已有健康实例时优先探测 HTTPS：历史部署可能已是 https，不能把配置降级回 http。
        const httpsHealth = certDomain ? await exec(client, `curl -fsSk --max-time 8 -H 'Authorization: Bearer ${existingToken}' https://${certDomain}/api/health || true`).catch(() => "") : "";
        const controllerUrl = certDomain && httpsHealth.includes('"ok":true')
          ? `https://${certDomain}/api`
          : `http://${credentials.host}:${existingPort}/api`;
        log("发现健康的现有控制中心，复用当前配置");
        return {
          alreadyConfigured: true,
          controllerUrl,
          token: existingToken,
          version: JSON.parse(health).version || "1.0.0"
        };
      }
      if (health.includes('"ok":true') && force) log("发现现有控制中心，按要求执行强制重新部署");
    }

    log("准备远程部署目录并上传控制中心源码");
    const wrapper = await sftp(client);
    const sourceRoot = resolveControllerSourceRoot();
    if (!sourceRoot) throw new Error("安装资源不完整：找不到节点控制中心源码，请重新安装最新版客户端");
    await exec(client, "rm -rf /tmp/nexious-node-deploy && mkdir -p /tmp/nexious-node-deploy/src");
    await Promise.all(controllerSourceFiles.map((file) =>
      upload(wrapper, resolve(sourceRoot, file), `/tmp/nexious-node-deploy/src/${file}`)
    ));
    log("控制中心源码上传完成");
    wrapper.end();
    const selectedPort=8788;
    log(`控制中心将监听 127.0.0.1:${selectedPort}，由 Caddy 对外提供 HTTPS`);
    const token = randomBytes(32).toString("hex");
    const packageJson = JSON.stringify({
      name: "nexious-node-controller", private: true, type: "module",
      scripts: { start: "tsx src/index.ts" },
      dependencies: { cors: "^2.8.5", express: "^5.1.0", ws: "^8.18.0", zod: "^3.24.2", ssh2: "^1.17.0", tsx: "^4.19.3", "better-sqlite3": "^11.10.0" }
    });
    const upstream = process.env.RELAY_UPSTREAM || process.env.RELAY_URL || "";
    const httpUpstream = upstream.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/$/, "");
    // 控制中心只绑定回环地址，公网流量统一经 Caddy 的 TLS 入口转发；
    // HTTP 回退模式会在 Caddy 不可用时把 BIND_HOST 改回 0.0.0.0。
    const service = `[Unit]\nDescription=Nexious Node Controller\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=/opt/nexious-node\nEnvironment=PORT=${selectedPort}\nEnvironment=BIND_HOST=127.0.0.1\nEnvironment=NEXIOUS_DB_PATH=/var/lib/nexious-node/nexious.db\nEnvironment=NEXIOUS_SKIP_SEED=1\nEnvironment=NEXIOUS_NODE_CONTROLLER=1\nEnvironment=NEXIOUS_ADMIN_TOKEN=${token}\nEnvironment=RELAY_URL=ws://${credentials.host}:${selectedPort}\nEnvironment=RELAY_UPSTREAM=${upstream}\nEnvironment=HTTP_UPSTREAM=${httpUpstream}\nEnvironment=NODE_ENV=production\nExecStart=/usr/bin/env npm start\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=multi-user.target\n`;
    const setup = [
      "systemctl stop nexious-node 2>/dev/null || true",
      "mkdir -p /opt/nexious-node/src /var/lib/nexious-node /etc/nexious-node",
      "cp /tmp/nexious-node-deploy/src/*.ts /opt/nexious-node/src/",
      `printf %s ${quote(packageJson)} > /opt/nexious-node/package.json`,
      `printf %s ${quote(token)} > /etc/nexious-node/token && chmod 600 /etc/nexious-node/token`,
      `printf %s ${quote(String(selectedPort))} > /etc/nexious-node/port && chmod 600 /etc/nexious-node/port`,
      `printf %s ${quote(service)} > /etc/systemd/system/nexious-node.service && chmod 600 /etc/systemd/system/nexious-node.service`,
      "cd /opt/nexious-node && npm install --omit=dev --no-audit --no-fund",
      "systemctl daemon-reload && systemctl enable --now nexious-node",
      "sleep 2"
    ].join(" && ");
    log("安装运行依赖并配置 systemd 服务，此步骤可能需要几分钟");
    await exec(client, sudo(credentials.password, setup));
    log("服务已启动，执行健康检查");
    const health = await exec(client, `for i in $(seq 1 20); do if curl -fsS -H 'Authorization: Bearer ${token}' http://127.0.0.1:${selectedPort}/api/health; then exit 0; fi; sleep 1; done; echo '--- systemd status ---' >&2; systemctl status nexious-node --no-pager -l >&2 || true; echo '--- recent logs ---' >&2; journalctl -u nexious-node -n 80 --no-pager >&2 || true; exit 1`);
    const parsed = JSON.parse(health);
    if (!parsed.ok) throw new Error("控制中心健康检查未通过");
    const rebindPublicHttp = "sed -i 's/BIND_HOST=127.0.0.1/BIND_HOST=0.0.0.0/' /etc/systemd/system/nexious-node.service && systemctl daemon-reload && systemctl restart nexious-node && if command -v ufw >/dev/null; then ufw allow 8788/tcp >/dev/null; fi && if command -v firewall-cmd >/dev/null; then firewall-cmd --permanent --add-port=8788/tcp >/dev/null && firewall-cmd --reload >/dev/null; fi";
    if (certDomain) {
      // 1) 端到端探测节点公网域名：已能经 HTTPS（含 Cloudflare/nginx 反代）访问控制中心时直接采用。
      const publicProbe = await exec(client, `curl -fsSk --max-time 8 -H 'Authorization: Bearer ${token}' https://${certDomain}/api/tunnels 2>/dev/null || true`).catch(() => "");
      if (publicProbe.trim().startsWith("[")) {
        log(`检测到节点域名 ${certDomain} 已可通过 HTTPS 访问控制中心，复用现有 TLS 入口`);
        return { alreadyConfigured: false, controllerUrl: `https://${certDomain}/api`, token, version: parsed.version || "1.0.0" };
      }
      // 2) 源站本机 443 已有反代（公网 DNS 暂未指向本机时也能发现）。
      if (await detectExistingHttpsProxy(client, certDomain, selectedPort, token, log)) {
        return { alreadyConfigured: false, controllerUrl: `https://${certDomain}/api`, token, version: parsed.version || "1.0.0" };
      }
      // 3) 尝试 Caddy 自动签发证书。
      if (await enableHttps(client, certDomain, selectedPort, token, credentials.password, log)) {
        log("HTTPS 已启用（Caddy 自动证书），控制中心公网地址为 https 地址");
        return { alreadyConfigured: false, controllerUrl: `https://${certDomain}/api`, token, version: parsed.version || "1.0.0" };
      }
    } else {
      log("节点未配置域名（SSH 地址为 IP），无法启用 HTTPS，控制中心将以 HTTP 模式运行");
    }
    log("警告：自动 HTTPS 不可用（常见原因：域名经 Cloudflare 等代理、80/443 已被其他 Web 服务占用），控制中心回退为 HTTP 明文模式。若已有 nginx 等反向代理，可将该域名的 HTTPS 站点代理到 127.0.0.1:8788（需支持 WebSocket）后重新部署，即可自动启用 HTTPS 地址");
    await exec(client, sudo(credentials.password, rebindPublicHttp));
    // 重启后 tsx 冷启动需要数秒，单次 curl 会因竞态误判部署失败，这里轮询等待就绪。
    const publicHealth = await exec(client, `for i in $(seq 1 20); do if curl -fsS --max-time 5 -H 'Authorization: Bearer ${token}' http://127.0.0.1:${selectedPort}/api/health 2>/dev/null; then exit 0; fi; sleep 1; done; echo '--- systemd status ---' >&2; systemctl status nexious-node --no-pager -l >&2 || true; echo '--- recent logs ---' >&2; journalctl -u nexious-node -n 40 --no-pager >&2 || true; exit 1`);
    if (!publicHealth.includes('"ok":true')) throw new Error("控制中心公网监听检查未通过");
    log("健康检查通过，节点控制中心部署完成（HTTP 模式）");
    return { alreadyConfigured: false, controllerUrl: `http://${credentials.host}:${selectedPort}/api`, token, version: parsed.version || "1.0.0" };
  } finally {
    client.end();
  }
}

export async function inspectNode(credentials: ServerCredentials, token?: string) {
  const client = await connect(credentials);
  try {
    const remoteToken = token || await exec(client, "test -f /etc/nexious-node/token && cat /etc/nexious-node/token || true");
    if (!remoteToken) return { configured: false, healthy: false, message: "服务器尚未部署 Nexious 控制中心" };
    const remotePort=Number(await exec(client,"test -f /etc/nexious-node/port && cat /etc/nexious-node/port || echo 8788"));
    const health = await exec(client, `curl -fsS -H 'Authorization: Bearer ${remoteToken}' http://127.0.0.1:${remotePort}/api/health || true`);
    return { configured: true, healthy: health.includes('"ok":true'), token: remoteToken, port:remotePort, controllerUrl:`http://${credentials.host}:${remotePort}/api`, message: health ? "控制中心运行正常" : "服务已配置但健康检查失败" };
  } finally { client.end(); }
}
