import { Client, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { randomBytes } from "node:crypto";
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

export async function deployNode(credentials: ServerCredentials, log: (message:string)=>void = ()=>{}, force=false): Promise<DeploymentResult> {
  log(`正在连接 ${credentials.username}@${credentials.host}:${credentials.port}`);
  const client = await connect(credentials);
  try {
    log("SSH 连接成功，检查远程系统和 Node.js 环境");
    const runtimeCheck = await exec(client, "sh -c 'node -e \"process.exit(Number(process.versions.node.split(\".\")[0])>=20?0:1)\" 2>/dev/null && command -v npm >/dev/null && command -v curl >/dev/null && echo ready || echo missing'");
    if (runtimeCheck !== "ready") {
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
      log("远程 Node.js、npm 和 curl 环境已满足要求");
    }
    log("Node.js 环境符合要求，检查已有控制中心");
    const existing = await exec(client, "test -f /etc/nexious-node/token && test -f /etc/nexious-node/port && printf '%s:%s' \"$(cat /etc/nexious-node/token)\" \"$(cat /etc/nexious-node/port)\" || true");
    if (existing) {
      const separator=existing.lastIndexOf(":"),existingToken=existing.slice(0,separator),existingPort=Number(existing.slice(separator+1));
      const active=await exec(client,"systemctl is-active nexious-node 2>/dev/null || true");
      const health = active==="active" ? await exec(client, `curl -fsS -H 'Authorization: Bearer ${existingToken}' http://127.0.0.1:${existingPort}/api/health || true`) : "";
      if (health.includes('"ok":true') && !force) { log("发现健康的现有控制中心，复用当前配置"); return {
        alreadyConfigured: true,
        controllerUrl: `http://${credentials.host}:${existingPort}/api`,
        token: existingToken,
        version: JSON.parse(health).version || "1.0.0"
      }; }
      if (health.includes('"ok":true') && force) log("发现现有控制中心，按要求执行强制重新部署");
    }

    log("准备远程部署目录并上传控制中心源码");
    const wrapper = await sftp(client);
    const sourceRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
    await exec(client, "rm -rf /tmp/nexious-node-deploy && mkdir -p /tmp/nexious-node-deploy/src");
    await Promise.all([
      upload(wrapper, resolve(sourceRoot, "index.ts"), "/tmp/nexious-node-deploy/src/index.ts"),
      upload(wrapper, resolve(sourceRoot, "db.ts"), "/tmp/nexious-node-deploy/src/db.ts"),
      upload(wrapper, resolve(sourceRoot, "nodeDeployment.ts"), "/tmp/nexious-node-deploy/src/nodeDeployment.ts")
    ]);
    log("控制中心源码上传完成");
    wrapper.end();
    const selectedPort=Number(await exec(client,"for port in $(seq 8788 8799); do if ! ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE \"[:.]${port}$\"; then echo $port; exit 0; fi; done; exit 1"));
    log(`已选择空闲控制中心端口 ${selectedPort}`);
    const token = randomBytes(32).toString("hex");
    const packageJson = JSON.stringify({
      name: "nexious-node-controller", private: true, type: "module",
      scripts: { start: "tsx src/index.ts" },
      dependencies: { cors: "^2.8.5", express: "^5.1.0", ws: "^8.18.0", zod: "^3.24.2", ssh2: "^1.17.0", tsx: "^4.19.3", "better-sqlite3": "^11.10.0" }
    });
    const upstream = process.env.RELAY_UPSTREAM || process.env.RELAY_URL || "";
    const httpUpstream = upstream.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/$/, "");
    const service = `[Unit]\nDescription=Nexious Node Controller\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=/opt/nexious-node\nEnvironment=PORT=${selectedPort}\nEnvironment=BIND_HOST=0.0.0.0\nEnvironment=NEXIOUS_DB_PATH=/var/lib/nexious-node/nexious.db\nEnvironment=NEXIOUS_SKIP_SEED=1\nEnvironment=NEXIOUS_ADMIN_TOKEN=${token}\nEnvironment=RELAY_URL=ws://${credentials.host}:${selectedPort}\nEnvironment=RELAY_UPSTREAM=${upstream}\nEnvironment=HTTP_UPSTREAM=${httpUpstream}\nEnvironment=NODE_ENV=production\nExecStart=/usr/bin/env npm start\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=multi-user.target\n`;
    const setup = [
      "systemctl stop nexious-node 2>/dev/null || true",
      "mkdir -p /opt/nexious-node/src /var/lib/nexious-node /etc/nexious-node",
      "cp /tmp/nexious-node-deploy/src/*.ts /opt/nexious-node/src/",
      "sed -i 's/INSERT INTO nodes VALUES (@id,@name,@region,@city,@latency,@load,@status,@host)/INSERT INTO nodes (id,name,region,city,latency,load,status,host) VALUES (@id,@name,@region,@city,@latency,@load,@status,@host)/' /opt/nexious-node/src/db.ts",
      "sed -i 's/^seed();$/if (process.env.NEXIOUS_SKIP_SEED !== \"1\") seed();/' /opt/nexious-node/src/db.ts",
      `printf %s ${quote(packageJson)} > /opt/nexious-node/package.json`,
      `printf %s ${quote(token)} > /etc/nexious-node/token`,
      `printf %s ${quote(String(selectedPort))} > /etc/nexious-node/port`,
      `printf %s ${quote(service)} > /etc/systemd/system/nexious-node.service`,
      "cd /opt/nexious-node && npm install --omit=dev --no-audit --no-fund",
      `if command -v ufw >/dev/null; then ufw allow ${selectedPort}/tcp >/dev/null; fi`,
      `if command -v firewall-cmd >/dev/null; then firewall-cmd --permanent --add-port=${selectedPort}/tcp >/dev/null && firewall-cmd --reload >/dev/null; fi`,
      "systemctl daemon-reload && systemctl enable --now nexious-node",
      "sleep 2"
    ].join(" && ");
    log("安装运行依赖并配置 systemd 服务，此步骤可能需要几分钟");
    await exec(client, sudo(credentials.password, setup));
    log("服务已启动，执行健康检查");
    const health = await exec(client, `for i in $(seq 1 20); do if curl -fsS -H 'Authorization: Bearer ${token}' http://127.0.0.1:${selectedPort}/api/health; then exit 0; fi; sleep 1; done; echo '--- systemd status ---' >&2; systemctl status nexious-node --no-pager -l >&2 || true; echo '--- recent logs ---' >&2; journalctl -u nexious-node -n 80 --no-pager >&2 || true; exit 1`);
    const parsed = JSON.parse(health);
    if (!parsed.ok) throw new Error("控制中心健康检查未通过");
    const publicHealth = await exec(client, `curl -fsS --max-time 8 -H 'Authorization: Bearer ${token}' http://127.0.0.1:${selectedPort}/api/health`);
    if (!publicHealth.includes('"ok":true')) throw new Error("控制中心公网监听检查未通过");
    log("健康检查通过，节点控制中心部署完成");
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
