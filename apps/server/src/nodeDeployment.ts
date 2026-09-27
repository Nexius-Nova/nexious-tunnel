import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createConnection, isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

export interface ServerCredentials { host: string; port: number; username: string; password: string }
export interface DeploymentResult {
  alreadyConfigured: boolean; controllerUrl: string; token: string; version: string;
  transport: "https" | "http"; relayVerified: boolean; backupPath?: string;
}

export function redactDeploymentError(value: string, secrets: string[]): string {
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    value = value.replaceAll(secret, "[已隐藏]");
  return value.replace(/(Bearer\s+|NEXIOUS_ADMIN_TOKEN=|[?&]token=)[^\s'"&]+/gi, "$1[已隐藏]")
    .replace(/("(?:agent_token|controller_token|password|token)"\s*:\s*")[^"]+/gi, "$1[已隐藏]").slice(-2000);
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const sourceFiles = ["index.ts", "db.ts", "database.ts", "mysqlSchema.ts", "accountSchema.ts", "auth.ts", "accounts.ts", "verification.ts", "membership.ts", "nodeDeployment.ts", "nodeController.ts", "proxyHeaders.ts", "util.ts"] as const;
export function resolveControllerSourceRoot(
  moduleRoot = resolve(fileURLToPath(new URL(".", import.meta.url))), workingDirectory = process.cwd()
): string | null {
  const candidates = [moduleRoot, resolve(moduleRoot, "../src"), resolve(workingDirectory, "apps/server/src"),
    resolve(workingDirectory, "server/src"), resolve(workingDirectory, "resources/server/src")];
  return [...new Set(candidates)].find((candidate) => sourceFiles.every((file) => existsSync(resolve(candidate, file)))) || null;
}
type TcpReachability = "open" | "refused" | "timeout" | "unreachable" | "dns";
// 握手超时既可能是端口被防火墙拦截，也可能是端口通但 sshd 未完成协议协商，
// 两种情况排查方向完全不同，因此失败后单独探测一次 TCP 连接以区分。
export function probeTcp(host: string, port: number, timeoutMs = 5000): Promise<TcpReachability> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (value: TcpReachability) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolveProbe(value); };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    socket.once("connect", () => finish("open"));
    socket.once("error", (error: Error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED") finish("refused");
      else if (code === "ENOTFOUND" || code === "EAI_AGAIN") finish("dns");
      else if (code === "EHOSTUNREACH" || code === "ENETUNREACH") finish("unreachable");
      else finish("timeout");
    });
  });
}
export function describeTcpFailure(credentials: ServerCredentials, result: Exclude<TcpReachability, "open">): string {
  const target = `${credentials.host}:${credentials.port}`;
  switch (result) {
    case "dns": return `无法解析服务器地址 ${credentials.host}，请检查主机名是否填写正确`;
    case "refused": return `服务器 ${target} 拒绝连接，SSH 端口未监听。请确认 sshd 正在运行并监听 ${credentials.port} 端口`;
    case "unreachable": return `服务器 ${target} 网络不可达，请检查服务器地址与路由是否正确`;
    default: return `连接 ${target} 超时，${credentials.port} 端口不通。请依次检查：服务器防火墙是否放行、云安全组是否开放、服务商是否封禁 SSH 端口，以及本机网络或代理设置`;
  }
}
export function describeSshFailure(credentials: ServerCredentials, error: Error & { level?: string }): string {
  const target = `${credentials.username}@${credentials.host}:${credentials.port}`;
  const message = error.message || String(error);
  if (error.level === "client-authentication" || /all configured authentication methods failed/i.test(message))
    return `SSH 登录失败：${target} 拒绝了用户名或密码。请确认账号密码正确，并且该账号允许密码登录（sshd 配置 PasswordAuthentication yes）`;
  if (/ECONNRESET|EPIPE|socket hang up|ECONNABORTED/i.test(message))
    return `与 ${target} 的连接在握手过程中被中断，请稍后重试；若持续出现，请检查服务器 sshd 日志`;
  return `连接 ${target} 失败：${message}`;
}
export const handshakeTimeoutMs = 15_000;
const handshakeAttempts = 2;
const isHandshakeTimeout = (error: Error) => /timed out while waiting for handshake/i.test(error.message || "");
function sshHandshake(credentials: ServerCredentials): Promise<Client> {
  return new Promise((resolveConnection, reject) => {
    const client = new Client();
    const config: ConnectConfig = { host: credentials.host, port: credentials.port, username: credentials.username,
      password: credentials.password, readyTimeout: handshakeTimeoutMs, keepaliveInterval: 5000, keepaliveCountMax: 3 };
    client.once("ready", () => resolveConnection(client));
    client.on("error", (error: Error & { level?: string }) => reject(error));
    client.connect(config);
  });
}
async function connect(credentials: ServerCredentials): Promise<Client> {
  // 先探测 TCP 端口：端口不通时立即给出准确原因，避免白等两次完整握手超时。
  const reachability = await probeTcp(credentials.host, credentials.port);
  if (reachability !== "open") throw new Error(describeTcpFailure(credentials, reachability));
  let failure: (Error & { level?: string }) | undefined;
  for (let attempt = 0; attempt < handshakeAttempts; attempt++) {
    try { return await sshHandshake(credentials); }
    catch (error) {
      failure = error as Error & { level?: string };
      // 只有握手超时值得重试；认证失败等确定性错误立即返回，不重复尝试。
      if (!isHandshakeTimeout(failure)) throw new Error(describeSshFailure(credentials, failure));
    }
  }
  throw new Error(`${credentials.host}:${credentials.port} 的 TCP 端口可以连接，但 SSH 协议握手在 ${Math.round(handshakeTimeoutMs * handshakeAttempts / 1000)} 秒内未完成。`
    + `请确认服务器 sshd 运行正常、未限制来源 IP，并支持密码认证${failure ? `（原始错误：${failure.message}）` : ""}`);
}
function exec(client: Client, command: string, timeoutMs = 30000, input?: string): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    let channel: ClientChannel | undefined;
    const timer = setTimeout(() => { channel?.close(); reject(new Error("远程操作超时，请检查服务器网络和服务状态")); }, timeoutMs);
    client.exec(command, (error, stream) => {
      if (error) { clearTimeout(timer); reject(error); return; }
      channel = stream;
      let output = "", stderr = "";
      stream.on("data", (data: Buffer) => { output = (output + data).slice(-65536); });
      stream.stderr.on("data", (data: Buffer) => { stderr = (stderr + data).slice(-65536); });
      stream.on("error", (error: Error) => { clearTimeout(timer); reject(error); });
      stream.on("close", (code: number) => {
        clearTimeout(timer);
        if (code === 0) resolveCommand(output.trim());
        else reject(new Error((stderr || output || `远程命令退出码 ${code}`).trim()));
      });
      stream.end(input);
    });
  });
}
async function privilegedRunner(client: Client, credentials: ServerCredentials) {
  const root = await exec(client, "id -u") === "0";
  const run = (command: string, timeoutMs?: number) => root
    ? exec(client, `sh -c ${quote(command)}`, timeoutMs)
    : exec(client, `sudo -S -p '' sh -c ${quote(command)}`, timeoutMs, `${credentials.password}\n`);
  await run("test \"$(uname -s)\" = Linux && command -v systemctl >/dev/null && test -d /run/systemd/system || { echo '仅支持使用 systemd 的 Linux 服务器' >&2; exit 42; }");
  await run("command -v ss >/dev/null && command -v flock >/dev/null || { echo '请先安装 iproute2 和 util-linux（ss、flock）' >&2; exit 42; }");
  return Object.assign(run, { isRoot: root });
}
type Run = Awaited<ReturnType<typeof privilegedRunner>>;

// 锁由 SSH 通道持有；连接中断后自动释放，避免部署残留锁阻止下次修复。
function acquireDeploymentLock(client: Client, run: Run, password: string): Promise<ClientChannel> {
  return new Promise((resolveLock, reject) => {
    let waiting: ClientChannel | undefined, output = "";
    const command = "umask 077; flock -n /var/lock/nexious-node-deploy.lock sh -c 'printf locked; cat >/dev/null'";
    const timer = setTimeout(() => { waiting?.close(); reject(new Error("获取服务器部署锁超时")); }, 15_000);
    client.exec(run.isRoot ? `sh -c ${quote(command)}` : `sudo -S -p '' sh -c ${quote(command)}`, (error, channel) => {
      if (error) { clearTimeout(timer); reject(error); return; }
      waiting = channel;
      channel.on("data", (data: Buffer) => {
        output = (output + data).slice(-100);
        if (output.includes("locked")) { clearTimeout(timer); resolveLock(channel); }
      });
      channel.on("close", () => { clearTimeout(timer); reject(new Error("服务器已有部署任务，或 flock 不可用")); });
      channel.on("error", (error: Error) => { clearTimeout(timer); reject(error); });
      if (!run.isRoot) channel.write(`${password}\n`);
    });
  });
}
export function parseRemoteConfiguration(value: string): { token: string; port: number } | null {
  const lines = value.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 2) return null;
  const [token, portText] = lines;
  const port = Number(portText);
  return /^[a-zA-Z0-9_-]{16,256}$/.test(token || "") && Number.isInteger(port) && port > 0 && port <= 65535
    ? { token, port } : null;
}
async function remoteConfiguration(run: Run) {
  return parseRemoteConfiguration(await run("if test -r /etc/nexious-node/token && test -r /etc/nexious-node/port; then cat /etc/nexious-node/token; printf '\\n'; cat /etc/nexious-node/port; fi"));
}
function domainName(value?: string) {
  return value && !isIP(value) && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value)
    ? value.toLowerCase() : undefined;
}
export function controllerCandidates(serverHost: string, port: number, publicHost?: string, preferred?: string): string[] {
  const domain = domainName(publicHost) || domainName(serverHost);
  const candidates: string[] = [];
  if (preferred) {
    try {
      const url = new URL(preferred);
      if (!url.username && !url.password && !url.search && !url.hash &&
        (url.hostname === serverHost || (domain && (url.hostname === domain || url.hostname.endsWith(`.${domain}`)))) &&
        ["http:", "https:"].includes(url.protocol)) candidates.push(url.href.replace(/\/$/, ""));
    } catch { /* 忽略旧配置中的无效地址。 */ }
  }
  if (domain) candidates.push(`https://${domain}/api`, `https://demo.${domain}/api`, `http://${domain}/api`, `http://demo.${domain}/api`);
  const address = isIP(serverHost) === 6 ? `[${serverHost}]` : serverHost;
  candidates.push(`http://${address}:${port}/api`);
  return [...new Set(candidates)].sort((a, b) => Number(b.startsWith("https:")) - Number(a.startsWith("https:")));
}
async function verifyRelay(url: string): Promise<void> {
  const target = new URL(url);
  target.searchParams.set("tunnel", "deployment-probe");
  await new Promise<void>((resolveProbe, reject) => {
    let upgraded = false;
    const socket = new WebSocket(target, { handshakeTimeout: 4000 });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("WebSocket 中继验证超时")); }, 5000);
    const finish = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else resolveProbe(); };
    socket.on("open", () => { upgraded = true; });
    socket.on("error", finish);
    socket.on("close", (code) => finish(upgraded && code === 1008 ? undefined : new Error("WebSocket 中继未通过协议验证")));
  });
}
async function verifyController(controllerUrl: string, token: string) {
  // 配置入口必须独立通过验证，不能让直连掩盖 DNS 或反向代理故障。
  const base = controllerUrl.replace(/\/api\/?$/, "");
  const publicResponse = await fetch(`${base}/api/tunnels`, {
    headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(5000)
  });
  if (!publicResponse.ok || !Array.isArray(await publicResponse.json())) throw new Error(`配置入口认证失败 HTTP ${publicResponse.status}`);
  await verifyRelay(controllerUrl.replace(/^http/, "ws").replace(/\/api\/?$/, "/relay"));
}
async function findController(credentials: ServerCredentials, port: number, token: string, publicHost?: string, preferred?: string) {
  for (const candidate of controllerCandidates(credentials.host, port, publicHost, preferred)) {
    try { await verifyController(candidate, token); return candidate; }
    catch { /* 尝试下一个已有入口，最终由调用方给出配置建议。 */ }
  }
  return null;
}
export function caddyRepositoryKeyScript(keyring = "/usr/share/keyrings/caddy-stable-archive-keyring.gpg"): string {
  return `(set -e
    command -v curl >/dev/null && command -v gpg >/dev/null || { echo '修复 Caddy 软件源需要 curl 和 gnupg，请先安装这两个组件' >&2; exit 42; }
    key_dir=$(mktemp -d /tmp/nexious-caddy-key.XXXXXXXX)
    trap 'rm -rf "$key_dir"' EXIT
    curl -fsSL --retry 2 --max-time 60 https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o "$key_dir/key.asc"
    gpg --batch --yes --dearmor --output "$key_dir/key.gpg" "$key_dir/key.asc"
    install -m 644 "$key_dir/key.gpg" ${quote(keyring)}
  )`;
}
export function nodeEnvironmentSetupScript(installRuntime: boolean): string {
  const install = installRuntime
    ? `(set -e
      setup_dir=$(mktemp -d /tmp/nexious-runtime.XXXXXXXX)
      trap 'rm -rf "$setup_dir"' EXIT
      if command -v apt-get >/dev/null; then
        apt-get update -y
        apt-get install -y curl ca-certificates
        curl -fsSL --max-time 60 https://deb.nodesource.com/setup_24.x -o "$setup_dir/setup.sh"
        bash "$setup_dir/setup.sh"
        apt-get install -y nodejs
      elif command -v dnf >/dev/null; then
        dnf install -y curl ca-certificates
        curl -fsSL --max-time 60 https://rpm.nodesource.com/setup_24.x -o "$setup_dir/setup.sh"
        bash "$setup_dir/setup.sh"
        dnf install -y nodejs
      else echo '请先安装支持内置 SQLite 的 Node.js 22.13 或更新版本、npm 和 curl' >&2; exit 42; fi
    )`
    : `if command -v apt-get >/dev/null; then
        apt-get update -y
        apt-get install -y npm curl ca-certificates
      elif command -v dnf >/dev/null; then dnf install -y npm curl ca-certificates
      else echo '请先安装 npm 和 curl' >&2; exit 42; fi`;
  return `set -e
    if command -v apt-get >/dev/null && grep -qs 'https://dl.cloudsmith.io/public/caddy/stable/deb/debian' /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; then
      ${caddyRepositoryKeyScript()}
    fi
    ${install}
    node -e 'require("node:sqlite"); if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
    command -v npm >/dev/null
    command -v curl >/dev/null
  `;
}
async function prepareEnvironment(run: Run, log: (message: string) => void) {
  const status = (await run("printf '%s\\n' \"$(node -v 2>/dev/null || true)\"; command -v npm || true; command -v curl || true")).split("\n");
  const major = Number(status[0]?.match(/^v(\d+)/)?.[1] || 0);
  const sqliteAvailable = major >= 22 && await run("node -e 'require(\"node:sqlite\")' >/dev/null 2>&1 && printf ready || true") === "ready";
  if (sqliteAvailable && status.length >= 3) {
    log(`复用现有 Node.js ${status[0]}、npm 和 curl`); return;
  }
  log("准备 Node.js 运行环境，仅安装缺失的组件");
  await run(nodeEnvironmentSetupScript(!sqliteAvailable), 600000);
}
export interface DeploymentPaths { app: string; staged: string; backup: string; config: string; state: string; service: string }
function restoreHttpsScript(backup: string): string {
  return `if test -f ${quote(`${backup}/caddy-managed`)} && test ! -f ${quote(`${backup}/caddy-restored`)}; then
    systemctl stop caddy
    if test -f ${quote(`${backup}/Caddyfile`)}; then cp -a ${quote(`${backup}/Caddyfile`)} /etc/caddy/Caddyfile; else rm -f /etc/caddy/Caddyfile; fi
    if test -f ${quote(`${backup}/caddy-was-enabled`)}; then systemctl enable caddy; else systemctl disable caddy; fi
    if test -f ${quote(`${backup}/caddy-was-active`)}; then systemctl start caddy; fi
    touch ${quote(`${backup}/caddy-restored`)}
  fi`;
}
export function deploymentCaddyfile(domain: string, port: number): string {
  return `{\n  on_demand_tls {\n    ask http://127.0.0.1:${port}/internal/tls/authorize\n  }\n}\nhttps://${domain} {\n  reverse_proxy 127.0.0.1:${port}\n}\nhttp://${domain} {\n  reverse_proxy 127.0.0.1:${port}\n}\nhttps:// {\n  tls {\n    on_demand\n  }\n  reverse_proxy 127.0.0.1:${port}\n}\nhttp:// {\n  reverse_proxy 127.0.0.1:${port}\n}\n`;
}
export function rollbackDeploymentScript(paths: DeploymentPaths): string {
  const { app, backup, config, state, service } = paths;
  return `set -e
  test -f ${quote(`${backup}/snapshot-ready`)} || exit 0
  test ! -f ${quote(`${backup}/rolled-back`)} || exit 0
  if systemctl is-active --quiet nexious-node; then systemctl stop nexious-node; fi
  rm -rf ${quote(app)}
  if test -d ${quote(`${backup}/app`)}; then cp -a ${quote(`${backup}/app`)} ${quote(app)}; fi
  for file in token port; do
    rm -f ${quote(config)}/"$file"
    if test -f ${quote(backup)}/"$file"; then cp -a ${quote(backup)}/"$file" ${quote(config)}/"$file"; fi
  done
  rm -f ${quote(service)}
  if test -f ${quote(`${backup}/service`)}; then cp -a ${quote(`${backup}/service`)} ${quote(service)}; fi
  rm -f ${quote(`${state}/nexious.db`)} ${quote(`${state}/nexious.db-wal`)} ${quote(`${state}/nexious.db-shm`)}
  for file in ${quote(backup)}/nexious.db*; do test ! -f "$file" || cp -a "$file" ${quote(state)}/; done
  systemctl daemon-reload
  if test -f ${quote(`${backup}/was-active`)}; then systemctl start nexious-node; fi
  if test ! -f ${quote(`${backup}/was-enabled`)}; then systemctl disable nexious-node 2>/dev/null || true; fi
  ${restoreHttpsScript(backup)}
  touch ${quote(`${backup}/rolled-back`)}
  `;
}
export function activationDeploymentScript(paths: DeploymentPaths, token: string, port: number, serviceText: string): string {
  return `set -e
  umask 077
  mkdir -p ${quote(paths.backup)} ${quote(paths.config)} ${quote(paths.state)}
  systemctl is-active --quiet nexious-node && touch ${quote(`${paths.backup}/was-active`)} || true
  systemctl is-enabled --quiet nexious-node && touch ${quote(`${paths.backup}/was-enabled`)} || true
  if test -d ${quote(paths.app)}; then cp -a ${quote(paths.app)} ${quote(`${paths.backup}/app`)}; fi
  for file in token port; do test ! -f ${quote(paths.config)}/"$file" || cp -a ${quote(paths.config)}/"$file" ${quote(paths.backup)}/; done
  if test -f ${quote(paths.service)}; then cp -a ${quote(paths.service)} ${quote(`${paths.backup}/service`)}; fi
  trap ${quote(`if test -f ${quote(`${paths.backup}/snapshot-ready`)}; then sh ${quote(`${paths.backup}/rollback.sh`)}; elif test -f ${quote(`${paths.backup}/was-active`)}; then systemctl start nexious-node; fi`)} EXIT
  if systemctl is-active --quiet nexious-node; then systemctl stop nexious-node; fi
  for file in ${quote(paths.state)}/nexious.db*; do test ! -f "$file" || cp -a "$file" ${quote(paths.backup)}/; done
  touch ${quote(`${paths.backup}/snapshot-ready`)}
  trap ${quote(`sh ${quote(`${paths.backup}/rollback.sh`)}`)} EXIT
  rm -rf ${quote(paths.app)}
  mv ${quote(paths.staged)} ${quote(paths.app)}
  printf %s ${quote(token)} > ${quote(`${paths.config}/token`)}
  printf %s ${quote(String(port))} > ${quote(`${paths.config}/port`)}
  printf %s ${quote(serviceText)} > ${quote(paths.service)}
  chmod 600 ${quote(`${paths.config}/token`)} ${quote(`${paths.config}/port`)} ${quote(paths.service)}
  chown root:root ${quote(`${paths.config}/token`)} ${quote(`${paths.config}/port`)} ${quote(paths.service)}
  systemctl daemon-reload
  systemctl enable --now nexious-node
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if curl -fsS --max-time 3 -H ${quote(`Authorization: Bearer ${token}`)} http://127.0.0.1:${port}/api/tunnels >/dev/null; then trap - EXIT; exit 0; fi
    sleep 1
  done
  journalctl -u nexious-node -n 30 --no-pager >&2 || true
  echo '控制中心启动或认证验证失败，已尝试恢复旧版本' >&2
  exit 1
  `;
}
async function enableHttps(run: Run, domain: string, port: number, backup: string, log: (message: string) => void) {
  const occupied = await run("ss -ltn '( sport = :80 or sport = :443 )' 2>/dev/null | tail -n +2");
  if (occupied || await run("test ! -s /etc/caddy/Caddyfile || printf exists")) {
    // 面板或已有站点占用了 80/443，此时必须由用户自行代理；这里直接给出目标地址和必要设置，
    // 否则用户不知道该把域名指向哪里，也不知道 Host 与 WebSocket 必须放行。
    log(`已有 Web 服务或 Caddy 配置，保留现有站点；请在现有反向代理中把节点域名及其泛域名（如 *.${domain}）代理到 http://127.0.0.1:${port}，`
      + "并保留原始 Host 请求头、开启 WebSocket 支持。完成后回到本窗口重新检查即可");
    return false;
  }
  log("安装 Caddy 并准备节点 HTTPS 入口");
  try {
    await run(`set -e; systemctl is-active --quiet caddy && touch ${quote(`${backup}/caddy-was-active`)} || true; systemctl is-enabled --quiet caddy && touch ${quote(`${backup}/caddy-was-enabled`)} || true; if test -f /etc/caddy/Caddyfile; then cp -a /etc/caddy/Caddyfile ${quote(`${backup}/Caddyfile`)}; fi; touch ${quote(`${backup}/caddy-managed`)}`);
    await run(`set -e
      if ! command -v caddy >/dev/null; then
        if command -v apt-get >/dev/null; then
          apt-get install -y curl ca-certificates gnupg
          ${caddyRepositoryKeyScript()}
          source_file=$(mktemp /tmp/nexious-caddy-source.XXXXXXXX)
          trap 'rm -f "$source_file"' EXIT
          curl -fsSL --retry 2 --max-time 60 https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o "$source_file"
          install -m 644 "$source_file" /etc/apt/sources.list.d/caddy-stable.list
          apt-get update -y
          apt-get install -y caddy
        elif command -v dnf >/dev/null; then dnf install -y caddy
        else exit 42; fi
      fi`, 300000);
    const text = deploymentCaddyfile(domain, port);
    await run(`set -e; mkdir -p /etc/caddy; printf %s ${quote(text)} > /etc/caddy/Caddyfile; caddy validate --config /etc/caddy/Caddyfile; systemctl enable caddy; systemctl restart caddy; if command -v ufw >/dev/null; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi; if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then firewall-cmd --permanent --add-service=http --add-service=https >/dev/null; firewall-cmd --reload >/dev/null; fi`, 45000);
    log("HTTPS 入口已启动，等待证书和域名连接验证"); return true;
  } catch (error) {
    log(`Caddy 自动配置未完成：${redactDeploymentError(String(error), [])}`);
    await run(restoreHttpsScript(backup)).catch(() => {}); return false;
  }
}
export async function deployNode(credentials: ServerCredentials, log: (message: string) => void = () => {}, force = false,
  publicHost?: string, preferredController?: string): Promise<DeploymentResult> {
  const sourceRoot = resolveControllerSourceRoot();
  if (!sourceRoot) throw new Error("安装资源不完整：找不到节点控制中心源码，请重新安装最新版客户端");
  const secrets = [credentials.password], id = randomBytes(8).toString("hex");
  const paths: DeploymentPaths = { app: "/opt/nexious-node", staged: `/opt/nexious-node-staging-${id}`,
    backup: `/var/backups/nexious-node/${id}`, config: "/etc/nexious-node", state: "/var/lib/nexious-node",
    service: "/etc/systemd/system/nexious-node.service" };
  log(`正在连接 ${credentials.username}@${credentials.host}:${credentials.port}`);
  const client = await connect(credentials);
  let run: Run | undefined, uploadDir = "", lock: ClientChannel | undefined, activated = false;
  try {
    run = await privilegedRunner(client, credentials);
    log("SSH 与系统权限检查通过，检查已有节点配置");
    lock = await acquireDeploymentLock(client, run, credentials.password);
    const existing = await remoteConfiguration(run), token = existing?.token || randomBytes(32).toString("hex"), port = existing?.port || 8788;
    secrets.push(token);
    if (existing && !force) {
      const controllerUrl = await findController(credentials, port, token, publicHost, preferredController);
      if (controllerUrl) {
        log("现有节点认证接口和 WebSocket 验证通过，复用管理令牌和访问入口");
        return { alreadyConfigured: true, controllerUrl, token, version: "1.0.0",
          transport: controllerUrl.startsWith("https:") ? "https" : "http", relayVerified: true };
      }
      log("已有节点入口不可用，尝试修复并保留管理令牌、端口和隧道数据");
    }
    await prepareEnvironment(run, log);
    const occupied = await run(`ss -ltnp '( sport = :${port} )' | tail -n +2`);
    if (occupied) {
      const pids = [...occupied.matchAll(/pid=(\d+)/g)].map(match => match[1]);
      const ownService = pids.length && await run(pids.map(pid => `grep -F '/nexious-node.service' /proc/${pid}/cgroup >/dev/null`).join(" || ") + " && printf own || true");
      if (!ownService) throw new Error(`端口 ${port} 已被其他服务占用，请释放该端口后重试`);
    }
    uploadDir = await exec(client, "mktemp -d /tmp/nexious-node-deploy.XXXXXXXX");
    if (!/^\/tmp\/nexious-node-deploy\.[a-zA-Z0-9]+$/.test(uploadDir)) throw new Error("远程临时目录创建失败");
    await exec(client, `mkdir ${quote(`${uploadDir}/src`)}`);
    const wrapper = await new Promise<SFTPWrapper>((resolveSftp, reject) => client.sftp((error, value) => error ? reject(error) : resolveSftp(value)));
    try {
      await Promise.all(sourceFiles.map((file) => new Promise<void>((resolveUpload, reject) => {
        const timer = setTimeout(() => reject(new Error(`上传 ${file} 超时`)), 30000);
        wrapper.fastPut(resolve(sourceRoot, file), `${uploadDir}/src/${file}`, (error) => {
          clearTimeout(timer); if (error) reject(error); else resolveUpload();
        });
      })));
    } finally { wrapper.end(); }
    const packageJson = JSON.stringify({ name: "nexious-node-controller", private: true, type: "module",
      dependencies: { cors: "^2.8.5", express: "^5.1.0", ws: "^8.18.0", zod: "^3.24.2", ssh2: "^1.17.0", tsx: "^4.19.3", mysql2: "^3.24.4" } });
    log("源码上传完成，准备新版本依赖；现有服务继续运行");
    await run(`set -e; mkdir -p ${quote(paths.staged)} ${quote(paths.backup)}; chmod 700 ${quote(paths.backup)}; cp -a ${quote(`${uploadDir}/src`)} ${quote(paths.staged)}/; printf %s ${quote(packageJson)} > ${quote(`${paths.staged}/package.json`)}; cd ${quote(paths.staged)}; npm install --omit=dev --no-audit --no-fund --fetch-retries=2 --fetch-timeout=30000; node --import tsx -e 'require("node:sqlite"); require("cors"); require("express"); require("ws"); require("zod"); require("ssh2"); require("mysql2/promise")'`, 600000);
    const nodePath = await run("command -v node");
    if (!/^\/[a-zA-Z0-9/_.-]+$/.test(nodePath)) throw new Error("Node.js 可执行文件路径不受支持");
    const tuning = await run("if test -r /etc/systemd/system/nexious-node.service; then grep -E '^Environment=NEXIOUS_(MAX_BODY_MB|LOG_RETENTION_DAYS|TRAFFIC_RETENTION_DAYS|TRUST_PROXY_HEADERS)=[0-9]+$' /etc/systemd/system/nexious-node.service || true; fi");
    const service = `[Unit]\nDescription=Nexious Node Controller\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${paths.app}\nEnvironment=PORT=${port}\nEnvironment=BIND_HOST=127.0.0.1\nEnvironment=NEXIOUS_DB_DRIVER=sqlite\nEnvironment=NEXIOUS_DB_PATH=${paths.state}/nexious.db\nEnvironment=NEXIOUS_NODE_CONTROLLER=1\nEnvironment=NEXIOUS_PUBLIC_HOST=${domainName(publicHost) || domainName(credentials.host) || ""}\nEnvironment=NEXIOUS_ADMIN_TOKEN=${token}\n${tuning ? tuning + "\n" : ""}Environment=NODE_ENV=production\nExecStart=${nodePath} ${paths.app}/node_modules/tsx/dist/cli.mjs ${paths.app}/src/index.ts\nRestart=always\nRestartSec=3\nTimeoutStopSec=15\n\n[Install]\nWantedBy=multi-user.target\n`;
    await run(`umask 077; printf %s ${quote(rollbackDeploymentScript(paths))} > ${quote(`${paths.backup}/rollback.sh`)}`);
    log(`新版本准备完成，备份并切换服务；备份位置：${paths.backup}`);
    activated = true;
    await run(activationDeploymentScript(paths, token, port, service), 90000);
    let controllerUrl = await findController(credentials, port, token, publicHost, preferredController);
    const domain = domainName(publicHost) || domainName(credentials.host);
    if (!controllerUrl && domain && await enableHttps(run, domain, port, paths.backup, log)) {
      for (let attempt = 0; attempt < 6 && !controllerUrl; attempt++) {
        controllerUrl = await findController(credentials, port, token, publicHost, preferredController);
        if (!controllerUrl) await new Promise(resolveWait => setTimeout(resolveWait, 1000));
      }
    }
    if (!controllerUrl) {
      log("HTTPS 入口尚不可用，启用 HTTP 备用入口并验证公网连通性");
      await run(`set -e; sed -i 's/BIND_HOST=127.0.0.1/BIND_HOST=0.0.0.0/' ${quote(paths.service)}; systemctl daemon-reload; systemctl restart nexious-node; if command -v ufw >/dev/null; then ufw allow ${port}/tcp >/dev/null; fi; if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then firewall-cmd --permanent --add-port=${port}/tcp >/dev/null; firewall-cmd --reload >/dev/null; fi`);
      for (let attempt = 0; attempt < 3 && !controllerUrl; attempt++) controllerUrl = await findController(credentials, port, token, publicHost, preferredController);
    }
    if (!controllerUrl) throw new Error("本机服务已启动，但管理接口或 WebSocket 无法从主控连接；请检查域名、反向代理、服务器防火墙与安全组");
    const transport = controllerUrl.startsWith("https:") ? "https" : "http";
    if (transport === "http") log("当前使用 HTTP 备用入口，管理和中继链路为明文；配置 HTTPS 反向代理后可再次检查切换");
    await run(`touch ${quote(`${paths.backup}/committed`)}`);
    log("认证接口与 WebSocket 验证通过，节点服务部署完成");
    return { alreadyConfigured: false, controllerUrl, token, version: "1.0.0", transport, relayVerified: true, backupPath: paths.backup };
  } catch (error) {
    if (activated && run) {
      log("部署未完成，正在恢复旧版本和节点数据");
      try { await run(`sh ${quote(`${paths.backup}/rollback.sh`)}`, 90000); log("旧版本与配置已恢复"); }
      catch { log(`自动恢复未完成，请检查服务器备份：${paths.backup}`); }
    }
    throw new Error(redactDeploymentError(error instanceof Error ? error.message : String(error), secrets));
  } finally {
    if (uploadDir) await exec(client, `rm -rf ${quote(uploadDir)}`).catch(() => {});
    if (run) {
      await run(`rm -rf ${quote(paths.staged)}`).catch(() => {});
    }
    lock?.end();
    client.end();
  }
}
export function resetNodeScript(backupPath: string): string {
  if (!/^\/var\/backups\/nexious-node\/reset-[a-f0-9]{16}$/.test(backupPath)) throw new Error("重置备份路径无效");
  return `set -e
umask 077
backup=${quote(backupPath)}
mkdir -p "$backup"
was_active=0
if systemctl is-active --quiet nexious-node.service; then was_active=1; systemctl stop nexious-node.service; fi
trap 'if test "$was_active" = 1; then systemctl start nexious-node.service || true; fi' EXIT
for path in /opt/nexious-node /etc/nexious-node /var/lib/nexious-node /etc/systemd/system/nexious-node.service; do
  if test -e "$path" || test -L "$path"; then cp -a --parents -- "$path" "$backup"; fi
done
trap - EXIT
if systemctl cat nexious-node.service >/dev/null 2>&1; then
  systemctl stop nexious-node.service
  systemctl disable nexious-node.service
fi
rm -rf -- /opt/nexious-node /etc/nexious-node /var/lib/nexious-node
rm -f -- /etc/systemd/system/nexious-node.service
systemctl daemon-reload
touch "$backup/reset-complete"
printf '%s' "$backup"`;
}
export async function resetNode(credentials: ServerCredentials): Promise<{ backupPath: string }> {
  const client = await connect(credentials);
  let lock: ClientChannel | undefined;
  try {
    const run = await privilegedRunner(client, credentials);
    lock = await acquireDeploymentLock(client, run, credentials.password);
    const backupPath = `/var/backups/nexious-node/reset-${randomBytes(8).toString("hex")}`;
    await run(resetNodeScript(backupPath), 120000);
    return { backupPath };
  } catch (error) {
    throw new Error(redactDeploymentError(error instanceof Error ? error.message : String(error), [credentials.password]));
  } finally { lock?.end(); client.end(); }
}
export async function inspectNode(credentials: ServerCredentials, publicHost?: string, preferredController?: string): Promise<{
  configured:boolean; healthy:boolean; token?:string; port?:number; controllerUrl?:string; message:string
}> {
  const client = await connect(credentials);
  let remoteToken = "";
  try {
    const run = await privilegedRunner(client, credentials), existing = await remoteConfiguration(run);
    if (!existing) return { configured: false, healthy: false, message: "服务器尚未部署 Nexious 控制中心，或节点配置不完整" };
    remoteToken = existing.token;
    const controllerUrl = await findController(credentials, existing.port, existing.token, publicHost, preferredController);
    return { configured: true, healthy: !!controllerUrl, token: existing.token, port: existing.port,
      ...(controllerUrl ? { controllerUrl } : {}),
      message: controllerUrl ? "认证接口和 WebSocket 中继连接正常" : "已有配置，但主控无法连接认证接口或 WebSocket 中继，请检查入口配置" };
  } catch (error) {
    throw new Error(redactDeploymentError(error instanceof Error ? error.message : String(error), [credentials.password, remoteToken]));
  } finally { client.end(); }
}
