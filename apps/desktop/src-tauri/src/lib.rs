use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::{
    collections::HashMap,
    fs,
    io::Write as _,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent,
};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    http::{HeaderName, HeaderValue},
    Message,
};

const LOCAL_API_URL: &str = "http://127.0.0.1:8787";
// 出厂默认连接官方控制中心。直连服务器 IP（TLS 不发 SNI），绕开运营商按
// SNI 匹配未备案域名的拦截；服务器证书由专用 CA 签发（SAN 含服务器 IP），
// CA 证书内置下方，作为直连入口的信任锚。域名入口（cc.nexious-ppt.xyz）
// 在域名完成 ICP 备案后可作为后备入口恢复。
const DEFAULT_API_URL: &str = "https://8.134.156.74:8443";
// 官方控制中心专用 CA 证书（仅公钥；签发私钥只存在于服务器）。
// 注意：该文件必须是无 BOM 的纯 ASCII PEM（include_bytes! 原样嵌入，
// 带 BOM/CRLF 的副本会导致 rustls 证书解析异常）。
const OFFICIAL_CA_CERT: &[u8] = include_bytes!("../certs/ca.crt");
// 历史出厂默认：内置本地服务、官方域名入口两代。加载时一次性迁移到 DEFAULT_API_URL。
const LEGACY_DEFAULT_API_URLS: [&str; 4] = [
    "http://127.0.0.1:8787",
    "http://localhost:8787",
    "https://cc.nexious-ppt.xyz",
    "https://cc.nexious-ppt.xyz:8443",
];
mod secure_session;
const LOCAL_API_PORT: u16 = 8787;
// 隧道响应体上限：整包 base64+JSON 转发在内存中完成，必须限制大小防止打爆内存。
const TUNNEL_RESPONSE_LIMIT: usize = 64 * 1024 * 1024;

#[derive(Default)]
struct AgentManager(Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>);

#[derive(Clone, Deserialize)]
struct DirectRelay {
    url: String,
    address: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(default)]
struct DesktopPreferences {
    auto_start: bool,
    minimize_to_tray: bool,
    api_url: String,
    api_token: String,
    // 本地控制中心运行参数；保存后自动重启 node 进程生效。
    max_body_mb: u32,
    log_retention_days: u32,
    traffic_retention_days: u32,
    // 偏好结构版本：0/1/2=历史出厂配置（默认地址经历本地服务 → 官方域名入口
    // 两代），≥3=当前版本（IP 直连入口）。字段级 serde(default) 让旧文件缺该
    // 字段时取 0，触发默认地址迁移。
    #[serde(default)]
    schema_version: u32,
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            auto_start: false,
            minimize_to_tray: true,
            api_url: DEFAULT_API_URL.to_string(),
            api_token: String::new(),
            max_body_mb: 25,
            log_retention_days: 30,
            traffic_retention_days: 90,
            schema_version: 3,
        }
    }
}

struct DesktopPreferencesState {
    value: Mutex<DesktopPreferences>,
    path: PathBuf,
    local_api_token: String,
}

struct ApiClient(reqwest::Client);

// 信任官方控制中心自签 CA 的 API 客户端；在系统根证书之外追加，
// 访问其他 HTTPS 地址的行为不受影响。
fn build_api_client() -> reqwest::Client {
    let certificate = reqwest::Certificate::from_pem(OFFICIAL_CA_CERT).expect("内置 CA 证书无效");
    reqwest::Client::builder()
        .add_root_certificate(certificate)
        .build()
        .expect("无法构建 API 客户端")
}

// 本地控制中心的管理 token 不再硬编码在二进制里，而是首次启动时随机生成并
// 保存到用户配置目录，避免本机低权限进程从安装包中直接读出固定口令。
fn load_or_create_local_api_token(path: &PathBuf) -> String {
    if let Ok(value) = fs::read_to_string(path) {
        let token = value.trim().to_string();
        if token.len() >= 32 {
            return token;
        }
    }
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::write(path, &token).is_err() {
        // 配置目录不可写时退化为仅本次会话有效的随机 token。
    }
    token
}

fn append_local_api_log(data_dir: &PathBuf, message: &str) {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    if let Ok(mut log) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("local-api.log"))
    {
        let _ = writeln!(log, "[{seconds}] {message}");
    }
}

// 通过原始 TCP 发起极简 GET 请求，探测本地控制中心；返回原始响应文本。
fn probe_local_api(path: &str, token: Option<&str>) -> Option<String> {
    use std::io::Read;
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", LOCAL_API_PORT)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_millis(800)))
        .ok()?;
    let authorization = token
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n{authorization}Connection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    Some(response)
}

fn parse_listening_pids(netstat_output: &str, port: u16) -> Vec<u32> {
    let mut pids = Vec::new();
    for line in netstat_output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // TCP    127.0.0.1:8787    0.0.0.0:0    LISTENING    1234
        if fields.len() >= 5
            && fields[0].eq_ignore_ascii_case("TCP")
            && fields[3].eq_ignore_ascii_case("LISTENING")
            && fields[1].rsplit(':').next().unwrap_or("").parse::<u16>() == Ok(port)
        {
            if let Ok(pid) = fields[4].parse::<u32>() {
                if pid != 0 && !pids.contains(&pid) {
                    pids.push(pid);
                }
            }
        }
    }
    pids
}

// 结束占用本地 API 端口的残留进程（旧版本升级后遗留、或上次异常退出未清理）。
#[cfg(target_os = "windows")]
fn terminate_stale_local_api() {
    let Ok(output) = Command::new("netstat.exe").arg("-ano").output() else {
        return;
    };
    for pid in parse_listening_pids(&String::from_utf8_lossy(&output.stdout), LOCAL_API_PORT) {
        let _ = Command::new("taskkill.exe")
            .args(["/F", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(not(target_os = "windows"))]
fn terminate_stale_local_api() {}

struct LocalApiState(Mutex<Option<Child>>);

#[cfg(target_os = "windows")]
fn node_compatible_path(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = value.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

#[cfg(not(target_os = "windows"))]
fn node_compatible_path(path: PathBuf) -> PathBuf {
    path
}

#[tauri::command]
fn start_agent(
    manager: tauri::State<'_, AgentManager>,
    tunnel_id: String,
    token: String,
    relay: String,
    target: String,
    direct_relay: Option<DirectRelay>,
) -> Result<(), String> {
    let mut processes = manager
        .0
        .lock()
        .map_err(|_| "Agent 状态不可用".to_string())?;
    if let Some(existing) = processes.remove(&tunnel_id) {
        existing.abort();
    }
    let key = tunnel_id.clone();
    let task = tauri::async_runtime::spawn(run_agent(relay, tunnel_id, token, target, direct_relay));
    processes.insert(key, task);
    Ok(())
}

#[tauri::command]
fn stop_agent(manager: tauri::State<'_, AgentManager>, tunnel_id: String) -> Result<(), String> {
    let mut processes = manager
        .0
        .lock()
        .map_err(|_| "Agent 状态不可用".to_string())?;
    if let Some(process) = processes.remove(&tunnel_id) {
        process.abort();
    }
    Ok(())
}

/// 退出登录时停止所有本机 agent：agent 持有的是隧道 token，与用户会话无关，
/// 不主动停止的话用户登出后转发仍在后台进行（服务端 agent 掉线会把状态收敛为 stopped）。
#[tauri::command]
fn stop_all_agents(manager: tauri::State<'_, AgentManager>) -> Result<(), String> {
    let mut processes = manager
        .0
        .lock()
        .map_err(|_| "Agent 状态不可用".to_string())?;
    for (_, process) in processes.drain() {
        process.abort();
    }
    Ok(())
}

// 解析单个 PEM 证书为 DER。内置 CA 证书格式受控（无 BOM 的纯 ASCII PEM）。
fn pem_certificate_der(pem: &[u8]) -> Option<rustls::pki_types::CertificateDer<'static>> {
    let text = std::str::from_utf8(pem).ok()?;
    let begin = text.find("-----BEGIN CERTIFICATE-----")? + "-----BEGIN CERTIFICATE-----".len();
    let end = text.find("-----END CERTIFICATE-----")?;
    let body: String = text[begin..end].chars().filter(|c| !c.is_whitespace()).collect();
    let der = BASE64.decode(body).ok()?;
    Some(rustls::pki_types::CertificateDer::from(der))
}

// relay 连接的 TLS 配置：webpki 公共根之外追加内置官方 CA，使 agent 能验证控制中心
// 的 IP 直连自签证书，信任范围与 API 客户端（reqwest）保持一致。
// 显式指定 ring provider，不依赖进程级默认（避免多 provider 时的歧义 panic）。
fn relay_tls_connector() -> tokio_tungstenite::Connector {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    if let Some(certificate) = pem_certificate_der(OFFICIAL_CA_CERT) {
        let _ = roots.add(certificate);
    }
    let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(rustls::ALL_VERSIONS)
        .expect("TLS 协议版本无效")
        .with_root_certificates(roots)
        .with_no_client_auth();
    tokio_tungstenite::Connector::Rustls(std::sync::Arc::new(config))
}

async fn connect_agent_relay(
    request: tokio_tungstenite::tungstenite::http::Request<()>,
    direct_relay: Option<&DirectRelay>,
) -> Result<
    (
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        tokio_tungstenite::tungstenite::handshake::client::Response,
    ),
    String,
> {
    tokio::time::timeout(Duration::from_secs(8), async {
        if let Some(direct) = direct_relay {
            if request.uri().scheme_str() != Some("wss") {
                return Err("direct relay requires TLS".to_string());
            }
            let stream = tokio::net::TcpStream::connect(&direct.address)
                .await
                .map_err(|error| error.to_string())?;
            stream.set_nodelay(true).map_err(|error| error.to_string())?;
            // TLS 仍按 URL 主机名校验证书（IP 入口校验 IP SAN），地址仅用于 TCP 连接。
            tokio_tungstenite::client_async_tls_with_config(
                request,
                stream,
                None,
                Some(relay_tls_connector()),
            )
            .await
            .map_err(|error| error.to_string())
        } else {
            tokio_tungstenite::connect_async_tls_with_config(
                request,
                None,
                true,
                Some(relay_tls_connector()),
            )
            .await
            .map_err(|error| error.to_string())
        }
    })
    .await
    .map_err(|_| "relay connection timeout".to_string())?
}

async fn run_agent(
    relay: String,
    tunnel_id: String,
    token: String,
    target: String,
    direct_relay: Option<DirectRelay>,
) {
    let client = reqwest::Client::new();
    let mut use_direct = direct_relay.is_some();
    loop {
        let candidate = direct_relay.as_ref().filter(|_| use_direct);
        let relay_url = candidate
            .map(|value| value.url.as_str())
            .unwrap_or(&relay);
        let endpoint = format!(
            "{}?tunnel={}&token={}",
            relay_url,
            url::form_urlencoded::byte_serialize(tunnel_id.as_bytes()).collect::<String>(),
            url::form_urlencoded::byte_serialize(token.as_bytes()).collect::<String>()
        );
        // token 同时放入 Authorization 头，避免被中间代理的访问日志记录在 URL 中。
        let connect_request = match endpoint.as_str().into_client_request() {
            Ok(mut request) => {
                if let Ok(value) = HeaderValue::from_str(&format!("Bearer {token}")) {
                    request
                        .headers_mut()
                        .insert(HeaderName::from_static("authorization"), value);
                }
                request
            }
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                continue;
            }
        };
        let connection = connect_agent_relay(connect_request, candidate).await;
        let (socket, _) = match connection {
            Ok(socket) => socket,
            Err(error) => {
                // 连接失败必须留痕：静默重试会让"agent 未连接"完全无法定位（TLS/认证/网络各有不同原因）。
                eprintln!(
                    "[agent] {tunnel_id}: {}连接失败: {error}",
                    if use_direct { "直连" } else { "配置" }
                );
                if use_direct {
                    use_direct = false;
                    continue;
                }
                tokio::time::sleep(Duration::from_millis(1500)).await;
                use_direct = direct_relay.is_some();
                continue;
            }
        };
        let connected_at = Instant::now();
        eprintln!(
            "[agent] {tunnel_id}: {}",
            if use_direct { "直连加密入口" } else { "配置入口" }
        );
        let (mut writer, mut reader) = socket.split();
        let (relay_sender, mut relay_outbound) = mpsc::unbounded_channel::<Message>();
        let relay_writer = tauri::async_runtime::spawn(async move {
            while let Some(message) = relay_outbound.recv().await {
                if writer.send(message).await.is_err() {
                    break;
                }
            }
        });
        let mut local_websockets =
            HashMap::<String, mpsc::UnboundedSender<serde_json::Value>>::new();
        // 服务端以 1008 关闭表示凭据已失效（token 被重新签发）或本连接已被更新的 agent 接管。
        // 这两种情况重试都不会成功：前者永远被拒，后者会与新连接互相顶替形成抖动，
        // 因此必须识别并退出循环，不能像普通断线那样无条件重连。
        let mut rejected = false;
        while let Some(result) = reader.next().await {
            let Ok(message) = result else {
                break;
            };
            if let Message::Close(frame) = &message {
                rejected = frame.as_ref().map(|value| u16::from(value.code)) == Some(1008);
                break;
            }
            if !message.is_text() {
                continue;
            }
            let Ok(request) =
                serde_json::from_str::<serde_json::Value>(message.to_text().unwrap_or(""))
            else {
                continue;
            };
            let message_type = request
                .get("type")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            let id = request
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string();
            if message_type == "ws-open" {
                if let Some(existing) = local_websockets.remove(&id) {
                    drop(existing);
                }
                let (local_sender, local_inbound) = mpsc::unbounded_channel();
                local_websockets.insert(id.clone(), local_sender);
                tauri::async_runtime::spawn(run_local_websocket(
                    id,
                    target.clone(),
                    request,
                    relay_sender.clone(),
                    local_inbound,
                ));
                continue;
            }
            if message_type == "ws-data" || message_type == "ws-close" {
                if let Some(local) = local_websockets.get(&id) {
                    let _ = local.send(request);
                }
                if message_type == "ws-close" {
                    local_websockets.remove(&id);
                }
                continue;
            }
            // HTTP 请求改为独立任务并发处理：慢请求不再阻塞整条隧道的其他消息。
            tauri::async_runtime::spawn(handle_http_request(
                client.clone(),
                target.clone(),
                request,
                relay_sender.clone(),
            ));
        }
        local_websockets.clear();
        relay_writer.abort();
        if rejected {
            eprintln!(
                "[agent] {tunnel_id}: 被服务端拒绝（1008 凭据失效或已被新连接接管），停止重连"
            );
            return;
        }
        if use_direct && connected_at.elapsed() < Duration::from_secs(5) {
            use_direct = false;
            continue;
        }
        use_direct = direct_relay.is_some();
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
}

async fn handle_http_request(
    client: reqwest::Client,
    target: String,
    request: serde_json::Value,
    relay_sender: mpsc::UnboundedSender<Message>,
) {
    let id = request
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let path = request
        .get("path")
        .and_then(|value| value.as_str())
        .unwrap_or("/");
    let method = request
        .get("method")
        .and_then(|value| value.as_str())
        .unwrap_or("GET")
        .parse()
        .unwrap_or(reqwest::Method::GET);
    let Some(url) = resolve_forward_url(&target, path) else {
        return;
    };
    let body = request
        .get("body")
        .and_then(|value| value.as_str())
        .and_then(|value| BASE64.decode(value).ok())
        .unwrap_or_default();
    let mut local_request = client.request(method, url).body(body);
    if let Some(headers) = request.get("headers").and_then(|value| value.as_object()) {
        for (name, value) in headers {
            if is_hop_by_hop_header(name)
                || name.eq_ignore_ascii_case("host")
                || name.eq_ignore_ascii_case("content-length")
            {
                continue;
            }
            let values = value
                .as_array()
                .map(|values| values.iter().collect::<Vec<_>>())
                .unwrap_or_else(|| vec![value]);
            for value in values {
                if let Some(value) = value.as_str() {
                    local_request = local_request.header(name, value);
                }
            }
        }
    }
    let payload = match local_request.send().await {
        Ok(mut response) => {
            let status = response.status().as_u16();
            if response.content_length().unwrap_or(0) as usize > TUNNEL_RESPONSE_LIMIT {
                serde_json::json!({"id":id,"status":413,"headers":{"content-type":"text/plain; charset=utf-8"},"body":BASE64.encode("tunnel response exceeds size limit")})
            } else {
                let mut headers = serde_json::Map::new();
                for (key, value) in response.headers() {
                    if is_hop_by_hop_header(key.as_str())
                        || key.as_str().eq_ignore_ascii_case("content-length")
                    {
                        continue;
                    }
                    if let Ok(value) = value.to_str() {
                        insert_response_header(&mut headers, key.to_string(), value.to_string());
                    }
                }
                let mut buffer = Vec::<u8>::new();
                let mut overflow = false;
                let mut failed = false;
                loop {
                    match response.chunk().await {
                        Ok(Some(chunk)) => {
                            if buffer.len().saturating_add(chunk.len()) > TUNNEL_RESPONSE_LIMIT {
                                overflow = true;
                                break;
                            }
                            buffer.extend_from_slice(&chunk);
                        }
                        Ok(None) => break,
                        Err(_) => {
                            failed = true;
                            break;
                        }
                    }
                }
                if overflow {
                    serde_json::json!({"id":id,"status":413,"headers":{"content-type":"text/plain; charset=utf-8"},"body":BASE64.encode("tunnel response exceeds size limit")})
                } else if failed {
                    serde_json::json!({"id":id,"status":502,"headers":{"content-type":"text/plain; charset=utf-8"},"body":BASE64.encode("local service unavailable")})
                } else {
                    serde_json::json!({"id":id,"status":status,"headers":headers,"body":BASE64.encode(buffer)})
                }
            }
        }
        Err(_) => {
            serde_json::json!({"id":id,"status":502,"headers":{"content-type":"text/plain; charset=utf-8"},"body":BASE64.encode("local service unavailable")})
        }
    };
    let _ = relay_sender.send(Message::Text(payload.to_string().into()));
}

async fn run_local_websocket(
    id: String,
    target: String,
    request: serde_json::Value,
    relay_sender: mpsc::UnboundedSender<Message>,
    mut inbound: mpsc::UnboundedReceiver<serde_json::Value>,
) {
    let path = request
        .get("path")
        .and_then(|value| value.as_str())
        .unwrap_or("/");
    let Some(mut url) = resolve_forward_url(&target, path) else {
        send_local_websocket_close(&relay_sender, &id, 1011, "unsafe forward path");
        return;
    };
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    if url.set_scheme(scheme).is_err() {
        send_local_websocket_close(&relay_sender, &id, 1011, "invalid websocket scheme");
        return;
    }
    let Ok(mut local_request) = url.as_str().into_client_request() else {
        send_local_websocket_close(&relay_sender, &id, 1011, "invalid websocket request");
        return;
    };
    if let Some(headers) = request.get("headers").and_then(|value| value.as_object()) {
        for (name, value) in headers {
            if is_local_websocket_reserved_header(name) {
                continue;
            }
            let Ok(name) = HeaderName::try_from(name.as_str()) else {
                continue;
            };
            let values = value
                .as_array()
                .map(|values| values.iter().collect::<Vec<_>>())
                .unwrap_or_else(|| vec![value]);
            for value in values {
                let Some(value) = value.as_str() else {
                    continue;
                };
                let Ok(value) = HeaderValue::try_from(value) else {
                    continue;
                };
                local_request.headers_mut().append(name.clone(), value);
            }
        }
    }
    let Ok((local, _)) = tokio_tungstenite::connect_async_with_config(local_request, None, true).await else {
        send_local_websocket_close(&relay_sender, &id, 1011, "local websocket unavailable");
        return;
    };
    let (mut local_writer, mut local_reader) = local.split();
    loop {
        tokio::select! {
            incoming = local_reader.next() => match incoming {
                Some(Ok(Message::Text(value))) => send_local_websocket_data(&relay_sender, &id, false, value.as_bytes()),
                Some(Ok(Message::Binary(value))) => send_local_websocket_data(&relay_sender, &id, true, &value),
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame.map(|value| (u16::from(value.code), value.reason.to_string())).unwrap_or((1000, String::new()));
                    send_local_websocket_close(&relay_sender, &id, code, &reason);
                    break;
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => {
                    send_local_websocket_close(&relay_sender, &id, 1011, "local websocket disconnected");
                    break;
                }
            },
            command = inbound.recv() => match command {
                Some(command) if command.get("type").and_then(|value| value.as_str()) == Some("ws-data") => {
                    let bytes = command.get("data").and_then(|value| value.as_str()).and_then(|value| BASE64.decode(value).ok()).unwrap_or_default();
                    let message = if command.get("binary").and_then(|value| value.as_bool()).unwrap_or(false) {
                        Message::Binary(bytes.into())
                    } else {
                        Message::Text(String::from_utf8_lossy(&bytes).into_owned().into())
                    };
                    if local_writer.send(message).await.is_err() { break; }
                }
                Some(_) | None => {
                    let _ = local_writer.send(Message::Close(None)).await;
                    break;
                }
            }
        }
    }
}

fn send_local_websocket_data(
    relay_sender: &mpsc::UnboundedSender<Message>,
    id: &str,
    binary: bool,
    data: &[u8],
) {
    let payload =
        serde_json::json!({"type":"ws-data","id":id,"binary":binary,"data":BASE64.encode(data)});
    let _ = relay_sender.send(Message::Text(payload.to_string().into()));
}

fn send_local_websocket_close(
    relay_sender: &mpsc::UnboundedSender<Message>,
    id: &str,
    code: u16,
    reason: &str,
) {
    let payload = serde_json::json!({"type":"ws-close","id":id,"code":code,"reason":reason});
    let _ = relay_sender.send(Message::Text(payload.to_string().into()));
}

fn is_local_websocket_reserved_header(name: &str) -> bool {
    is_hop_by_hop_header(name)
        || matches!(
            name.to_ascii_lowercase().as_str(),
            "host"
                | "content-length"
                | "sec-websocket-extensions"
                | "sec-websocket-key"
                | "sec-websocket-version"
        )
}

fn insert_response_header(
    headers: &mut serde_json::Map<String, serde_json::Value>,
    name: String,
    value: String,
) {
    match headers.get_mut(&name) {
        Some(serde_json::Value::String(previous)) => {
            let previous = previous.clone();
            *headers.get_mut(&name).expect("header exists") = serde_json::json!([previous, value]);
        }
        Some(serde_json::Value::Array(values)) => {
            values.push(serde_json::Value::String(value));
        }
        Some(existing) => *existing = serde_json::Value::String(value),
        None => {
            headers.insert(name, serde_json::Value::String(value));
        }
    }
}

fn is_hop_by_hop_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

// 转发路径必须是以单个 `/` 开头的站点内路径。`//host/path`、`/\host` 之类的值会被 URL 解析器
// 当作「更换主机」，让公网请求绕过隧道绑定的本地目标去访问本机任意端口、内网或公网地址。
fn safe_forward_path(value: &str) -> Option<&str> {
    let raw = if value.is_empty() { "/" } else { value };
    if !raw.starts_with('/') || raw.starts_with("//") {
        return None;
    }
    if raw.contains('\\') || raw.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(raw)
}

// 在 base 上解析转发目标；路径非法或解析结果脱离了 base 绑定的 origin 时返回 None。
fn resolve_forward_url(base: &str, path: &str) -> Option<reqwest::Url> {
    let raw = safe_forward_path(path)?;
    let base_url = reqwest::Url::parse(base).ok()?;
    let target = base_url.join(raw).ok()?;
    // 纵深防御：即便路径校验被绕过，也绝不允许跨 origin 转发。
    if target.origin() != base_url.origin() {
        return None;
    }
    Some(target)
}

#[cfg(test)]
mod tests {
    use super::{
        build_api_client, insert_response_header, normalize_loaded_preferences,
        uses_bundled_local_api, with_local_api_token, DesktopPreferences, DEFAULT_API_URL,
        LOCAL_API_URL,
    };

    #[tokio::test]
    async fn direct_relay_rejects_unencrypted_connections() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        let direct = super::DirectRelay {
            url: "ws://localhost/relay".into(),
            address: "127.0.0.1:1".into(),
        };
        let result = super::connect_agent_relay(
            direct.url.as_str().into_client_request().unwrap(),
            Some(&direct),
        ).await;
        assert!(matches!(result, Err(message) if message == "direct relay requires TLS"));
    }

    #[tokio::test]
    async fn agent_falls_back_when_direct_tls_handshake_fails() {
        use tokio::io::AsyncReadExt;

        let origin = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin_address = origin.local_addr().unwrap().to_string();
        let broken_tls = tokio::spawn(async move {
            let (mut stream, _) = origin.accept().await.unwrap();
            let mut first_byte = [0];
            stream.read_exact(&mut first_byte).await.unwrap();
            assert_eq!(first_byte[0], 0x16); // 必须先发 TLS 握手，而不是明文认证。
        });
        let fallback = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fallback_address = fallback.local_addr().unwrap();
        let agent = tokio::spawn(super::run_agent(
            format!("ws://{fallback_address}/relay"),
            "probe-tunnel".into(),
            "probe-token".into(),
            "http://127.0.0.1:1".into(),
            Some(super::DirectRelay { url: "wss://localhost/relay".into(), address: origin_address }),
        ));
        let result = tokio::time::timeout(std::time::Duration::from_secs(4), async {
            let (stream, _) = fallback.accept().await.unwrap();
            tokio_tungstenite::accept_hdr_async(stream, |request: &tokio_tungstenite::tungstenite::handshake::server::Request, response| {
                assert_eq!(request.headers()["authorization"], "Bearer probe-token");
                assert_eq!(request.uri().path(), "/relay");
                Ok(response)
            }).await.unwrap()
        }).await;
        agent.abort();
        broken_tls.abort();
        assert!(result.is_ok(), "直连 TLS 失败后应连接配置入口");
    }

    #[test]
    fn safe_forward_path_accepts_in_site_paths() {
        use super::safe_forward_path;
        for path in ["/", "/a", "/a/b?c=1", "/api/tunnels", "/a/../b"] {
            assert_eq!(safe_forward_path(path), Some(path), "应放行 {path}");
        }
        assert_eq!(safe_forward_path(""), Some("/"));
    }

    #[test]
    fn safe_forward_path_rejects_host_switching_paths() {
        use super::safe_forward_path;
        // 这些值会被 URL 解析器当作「更换主机」，让公网请求绕过隧道绑定的本地目标。
        for path in [
            "//evil.example/x",
            "//127.0.0.1:19002/x",
            "//localhost:18788/api/tunnels",
            "http://evil.example/x",
            "/\\evil.example",
            "/a\\b",
            "a/b",
            "/a\nx",
            "/a\u{0}b",
        ] {
            assert_eq!(safe_forward_path(path), None, "应拒绝 {path:?}");
        }
    }

    #[test]
    fn resolve_forward_url_stays_within_tunnel_target_origin() {
        use super::resolve_forward_url;
        let target = "http://127.0.0.1:19001";
        assert_eq!(
            resolve_forward_url(target, "/ok").map(|url| url.to_string()),
            Some("http://127.0.0.1:19001/ok".to_string())
        );
        for path in ["//127.0.0.1:19002/x", "//example.com/", "//localhost:18788/api/tunnels"] {
            assert!(resolve_forward_url(target, path).is_none(), "应拒绝 {path}");
        }
    }

    #[test]
    fn serializes_single_headers_as_strings_and_repeated_headers_as_arrays() {
        let mut headers = serde_json::Map::new();
        insert_response_header(
            &mut headers,
            "content-type".into(),
            "text/javascript".into(),
        );
        insert_response_header(&mut headers, "set-cookie".into(), "session=abc".into());
        insert_response_header(&mut headers, "set-cookie".into(), "csrf=xyz".into());

        assert_eq!(headers["content-type"], "text/javascript");
        assert_eq!(
            headers["set-cookie"],
            serde_json::json!(["session=abc", "csrf=xyz"])
        );
    }

    #[test]
    fn keeps_user_selected_remote_control_center_after_reload() {
        let preferences = normalize_loaded_preferences(DesktopPreferences {
            api_url: "https://relay.nexious-ppt.xyz/api/".to_string(),
            api_token: "remote-token".to_string(),
            ..DesktopPreferences::default()
        });

        assert_eq!(preferences.api_url, "https://relay.nexious-ppt.xyz/api");
        assert_eq!(preferences.api_token, "remote-token");
    }

    #[test]
    fn restores_bundled_token_only_for_local_control_center() {
        let local = with_local_api_token(
            DesktopPreferences {
                api_url: LOCAL_API_URL.to_string(),
                ..DesktopPreferences::default()
            },
            "generated-token-0123456789abcdef",
        );
        assert_eq!(local.api_token, "generated-token-0123456789abcdef");
        let remote = with_local_api_token(
            DesktopPreferences {
                api_url: "https://relay.example.com/api".to_string(),
                ..DesktopPreferences::default()
            },
            "generated-token-0123456789abcdef",
        );
        assert_eq!(remote.api_token, "");
        // 出厂默认即官方控制中心，不注入本地令牌。
        let default_remote = with_local_api_token(
            DesktopPreferences::default(),
            "generated-token-0123456789abcdef",
        );
        assert_eq!(default_remote.api_token, "");
    }

    #[test]
    fn migrates_legacy_default_to_official_control_center() {
        // 旧本地默认（schema 0）迁移到官方控制中心。
        let migrated = normalize_loaded_preferences(DesktopPreferences {
            api_url: "http://127.0.0.1:8787".to_string(),
            schema_version: 0,
            ..DesktopPreferences::default()
        });
        assert_eq!(migrated.api_url, DEFAULT_API_URL);
        assert_eq!(migrated.schema_version, 3);
        assert_eq!(migrated.api_token, "");

        let also_legacy = normalize_loaded_preferences(DesktopPreferences {
            api_url: "http://localhost:8787".to_string(),
            schema_version: 0,
            ..DesktopPreferences::default()
        });
        assert_eq!(also_legacy.api_url, DEFAULT_API_URL);

        // 官方域名入口两代（未带端口 / 8443 域名形式）都迁移到当前 IP 直连入口。
        let previous_official = normalize_loaded_preferences(DesktopPreferences {
            api_url: "https://cc.nexious-ppt.xyz".to_string(),
            schema_version: 1,
            ..DesktopPreferences::default()
        });
        assert_eq!(previous_official.api_url, DEFAULT_API_URL);
        assert_eq!(previous_official.schema_version, 3);

        let previous_official_port = normalize_loaded_preferences(DesktopPreferences {
            api_url: "https://cc.nexious-ppt.xyz:8443".to_string(),
            schema_version: 2,
            ..DesktopPreferences::default()
        });
        assert_eq!(previous_official_port.api_url, DEFAULT_API_URL);

        // 当前版本（schema ≥3）的地址不再被改写。
        let current = normalize_loaded_preferences(DesktopPreferences {
            api_url: "http://127.0.0.1:8787".to_string(),
            schema_version: 3,
            ..DesktopPreferences::default()
        });
        assert_eq!(current.api_url, "http://127.0.0.1:8787");
    }

    // 实测桌面端 TLS 栈（rustls）经内置 CA 直连官方控制中心 IP 入口。
    // 该路径 TLS 不发 SNI，可绕开运营商对未备案域名的 SNI 拦截。
    // 依赖真实网络与服务器状态，默认忽略：cargo test probes_official -- --ignored
    #[test]
    #[ignore]
    fn probes_official_control_center_via_rustls() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("failed to build tokio runtime");
        let response = runtime
            .block_on(async {
                build_api_client()
                    .get("https://8.134.156.74:8443/api/auth/status")
                    .timeout(std::time::Duration::from_secs(10))
                    .send()
                    .await
            })
            .expect("rustls request failed");
        assert!(response.status().is_success(), "status: {}", response.status());
    }

    #[test]
    fn starts_bundled_api_only_for_local_addresses() {
        assert!(uses_bundled_local_api("http://127.0.0.1:8787"));
        assert!(uses_bundled_local_api("http://localhost:8787/api"));
        assert!(!uses_bundled_local_api("https://relay.example.com/api"));
        assert!(!uses_bundled_local_api("http://127.0.0.1:8788"));
    }

    #[test]
    fn extracts_listening_pids_from_netstat_output() {
        let output = "\n  协议  本地地址          外部地址        状态           PID\n  TCP    127.0.0.1:8787     0.0.0.0:0    LISTENING    19444\n  TCP    127.0.0.1:8787     0.0.0.0:0    LISTENING    19444\n  TCP    127.0.0.1:61572    127.0.0.1:8787  TIME_WAIT   0\n  TCP    [::1]:8787         0.0.0.0:0    LISTENING    2210\n  TCP    127.0.0.1:8788     0.0.0.0:0    LISTENING    3333\n";
        assert_eq!(
            super::parse_listening_pids(output, 8787),
            vec![19444, 2210]
        );
        assert!(super::parse_listening_pids(output, 9999).is_empty());
    }

    #[test]
    fn validates_runtime_settings_ranges() {
        use super::validate_runtime_settings;
        assert!(validate_runtime_settings(&DesktopPreferences::default()).is_ok());
        let mut settings = DesktopPreferences::default();
        settings.max_body_mb = 0;
        assert!(validate_runtime_settings(&settings).is_err());
        settings.max_body_mb = 2048;
        assert!(validate_runtime_settings(&settings).is_err());
        settings.max_body_mb = 25;
        settings.log_retention_days = 0;
        assert!(validate_runtime_settings(&settings).is_err());
        settings.log_retention_days = 30;
        settings.traffic_retention_days = 4000;
        assert!(validate_runtime_settings(&settings).is_err());
        settings.traffic_retention_days = 90;
        assert!(validate_runtime_settings(&settings).is_ok());
    }
}

fn normalize_loaded_preferences(mut preferences: DesktopPreferences) -> DesktopPreferences {
    preferences.api_url = preferences.api_url.trim().trim_end_matches('/').to_string();
    if preferences.api_url.is_empty() {
        preferences.api_url = DesktopPreferences::default().api_url;
    }
    // 一次性迁移：历史出厂默认（内置本地服务 / 官方域名入口两代）统一迁到当前默认。
    // 设置页已不提供地址编辑入口，历史默认地址只可能来自出厂配置或历史版本；
    // schema_version ≥3 的配置视为当前版本产物，不再改写。
    if preferences.schema_version < 3 && LEGACY_DEFAULT_API_URLS.contains(&preferences.api_url.as_str()) {
        preferences.api_url = DEFAULT_API_URL.to_string();
        // 旧本地令牌对远程控制中心无意义，随迁移一并清除。
        preferences.api_token = String::new();
    }
    preferences.schema_version = preferences.schema_version.max(3);
    preferences
}

fn with_local_api_token(mut preferences: DesktopPreferences, local_token: &str) -> DesktopPreferences {
    if preferences.api_url == LOCAL_API_URL {
        preferences.api_token = local_token.to_string();
    }
    preferences
}

fn uses_bundled_local_api(api_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(api_url) else {
        return false;
    };
    if url.scheme() != "http" || url.port_or_known_default() != Some(8787) {
        return false;
    }
    matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"))
}

fn load_preferences(path: &PathBuf) -> DesktopPreferences {
    normalize_loaded_preferences(
        fs::read_to_string(path)
            .ok()
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_default(),
    )
}

fn start_local_api(
    app: &tauri::AppHandle,
    admin_token: &str,
    settings: &DesktopPreferences,
) -> Result<Option<Child>, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法定位应用资源目录: {error}"))?;
    let bundled_dir = node_compatible_path(if resource_dir.join("node.exe").exists() {
        resource_dir
    } else {
        resource_dir.join("resources")
    });
    let node = bundled_dir.join("node.exe");
    let entry = bundled_dir.join("server").join("dist").join("index.js");
    if !node.exists() || !entry.exists() {
        let log_dir = app.path().app_data_dir().map_err(|error| format!("无法定位应用数据目录: {error}"))?;
        fs::create_dir_all(&log_dir).map_err(|error| format!("无法创建应用数据目录: {error}"))?;
        append_local_api_log(&log_dir, &format!("本地控制中心运行资源未准备完成，等待后续请求补启动：{}", bundled_dir.display()));
        return Ok(None);
    }
    let data_dir = node_compatible_path(
        app.path()
            .app_data_dir()
            .map_err(|error| format!("无法定位应用数据目录: {error}"))?,
    );
    fs::create_dir_all(&data_dir).map_err(|error| format!("无法创建应用数据目录: {error}"))?;
    // 端口已被占用时按占用者身份处理：兼容的新实例直接复用；携带旧 token 的
    // 残留进程（升级遗留/异常退出）结束它后重新拉起，否则 UI 会一直认证失败；
    // 无关程序则不触碰，仅记录并跳过。
    if let Some(response) = probe_local_api("/api/health", None) {
        if response.contains("\"ok\":true") {
            let authorized = probe_local_api("/api/tunnels", Some(admin_token))
                .map(|response| response.contains(" 200 "))
                .unwrap_or(false);
            if authorized && response.contains("\"database\":\"mysql\"") {
                append_local_api_log(&data_dir, "8787 端口已有兼容的本地控制中心在运行，直接复用");
                return Ok(None);
            }
            append_local_api_log(
                &data_dir,
                "检测到旧令牌或旧 SQLite 控制中心，正在结束并启动 MySQL 控制中心",
            );
            terminate_stale_local_api();
            std::thread::sleep(Duration::from_millis(600));
        } else {
            append_local_api_log(&data_dir, "8787 端口被其他程序占用，本地控制中心未启动");
            return Ok(None);
        }
    }
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("local-api.log"))
        .map_err(|error| format!("无法创建本地控制中心日志: {error}"))?;
    let error_log = log
        .try_clone()
        .map_err(|error| format!("无法初始化本地控制中心日志: {error}"))?;
    let mut command = Command::new(node);
    command
        .arg("--env-file-if-exists")
        .arg(data_dir.join("local-api.env"))
        .arg(entry)
        .current_dir(&bundled_dir)
        .env("PORT", LOCAL_API_PORT.to_string())
        .env("BIND_HOST", "127.0.0.1")
        .env_remove("NEXIOUS_DB_PATH")
        .env_remove("NEXIOUS_SQLITE_TEST")
        .env_remove("NEXIOUS_NODE_CONTROLLER")
        .env("NEXIOUS_DB_DRIVER", "mysql")
        .env("NEXIOUS_EMBEDDED", "1")
        .env("NEXIOUS_ADMIN_TOKEN", admin_token)
        .env("NEXIOUS_MAX_BODY_MB", settings.max_body_mb.to_string())
        .env(
            "NEXIOUS_LOG_RETENTION_DAYS",
            settings.log_retention_days.to_string()
        )
        .env(
            "NEXIOUS_TRAFFIC_RETENTION_DAYS",
            settings.traffic_retention_days.to_string()
        )
        .env("NODE_ENV", "production")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log));
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            // 启动失败不应阻断整个应用；UI 会通过健康检查显示控制中心离线。
            append_local_api_log(&data_dir, &format!("本地控制中心启动失败: {error}"));
            return Ok(None);
        }
    };
    append_local_api_log(&data_dir, "本地控制中心进程已启动，等待端口就绪...");
    let monitor_dir = data_dir.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut ready = false;
        while Instant::now() < deadline {
            if std::net::TcpStream::connect(("127.0.0.1", LOCAL_API_PORT)).is_ok() {
                ready = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        if ready {
            append_local_api_log(&monitor_dir, "本地控制中心已就绪 (127.0.0.1:8787)");
        } else {
            append_local_api_log(
                &monitor_dir,
                "本地控制中心 15 秒内未监听 8787 端口，可能是端口被占用或依赖缺失",
            );
        }
    });
    Ok(Some(child))
}

fn ensure_local_api_ready(app: &tauri::AppHandle, settings: &DesktopPreferences) -> Result<(), String> {
    // 启动检查共用一把锁，多个页面并发请求只会拉起一个主控进程。
    // 在发送业务请求前等待服务就绪，避免自动重放已经发送的写入。
    let state = app.state::<LocalApiState>();
    let mut child = state.0.lock().map_err(|_| "本地控制中心状态不可用".to_string())?;
    let running = match child.as_mut() {
        Some(process) => process.try_wait().map_err(|_| "无法检查本地控制中心进程".to_string())?.is_none(),
        None => false,
    };
    if !running {
        child.take();
        let token = app.state::<DesktopPreferencesState>().local_api_token.clone();
        *child = start_local_api(app, &token, settings)?;
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if probe_local_api("/api/health", None).is_some_and(|response|
            response.contains(" 200 ") && response.contains("\"database\":\"mysql\"")) {
            return Ok(());
        }
        if let Some(process) = child.as_mut() {
            if process.try_wait().map_err(|_| "无法检查本地控制中心进程".to_string())?.is_some() {
                child.take();
                return Err("本机主控启动失败，请检查 MySQL 连接配置及 local-api.log".to_string());
            }
        } else {
            return Err("本机主控运行资源尚未准备完成，请稍后重试；开发模式请先完成运行时构建".to_string());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("本机主控尚未就绪，请检查 MySQL 服务及 local-api.log".to_string())
}

fn stop_local_api(state: &LocalApiState) {
    if let Ok(mut child) = state.0.lock() {
        if let Some(mut process) = child.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
    }
}

fn sync_auto_start(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        let status = if enabled {
            let executable =
                std::env::current_exe().map_err(|error| format!("无法定位应用程序: {error}"))?;
            let value = format!("\"{}\"", executable.display());
            Command::new("reg.exe")
                .args([
                    "add",
                    key,
                    "/v",
                    "NexiousTunnel",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &value,
                    "/f",
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
        } else {
            Command::new("reg.exe")
                .args(["delete", key, "/v", "NexiousTunnel", "/f"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
        }
        .map_err(|error| format!("无法更新开机启动设置: {error}"))?;
        if enabled && !status.success() {
            return Err("开机启动设置写入失败".to_string());
        }
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        if enabled {
            return Err("当前系统暂不支持开机启动".to_string());
        }
        Ok(())
    }
}

#[tauri::command]
fn get_desktop_preferences(
    state: tauri::State<'_, DesktopPreferencesState>,
) -> Result<DesktopPreferences, String> {
    state
        .value
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "桌面设置不可用".to_string())
}

// ── 检查更新 ─────────────────────────────────────────────────────────────
// 更新源为 GitHub Releases（latest）。下载域名在部分网络环境不可直连，
// 因此只做版本检查并引导用户前往发布页手动下载，不做进程内自动更新。
const UPDATE_RELEASE_API: &str =
    "https://api.github.com/repos/Nexius-Nova/nexious-tunnel/releases/latest";
const RELEASE_PAGE_URL: &str = "https://github.com/Nexius-Nova/nexious-tunnel/releases";
const RELEASE_PAGE_HOST_PREFIX: &str = "https://github.com/Nexius-Nova/nexious-tunnel";

// 语义化版本比较（仅 x.y.z 数字段）：a > b 返回 Greater，相等 Equal，a < b 返回 Less。
// 非数字段按 0 处理，长度不足补 0，保证 "1.0" 与 "1.0.0" 视为相等。
fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    fn parse(value: &str) -> Vec<u64> {
        value
            .trim()
            .trim_start_matches('v')
            .split('.')
            .map(|part| part.trim().parse::<u64>().unwrap_or(0))
            .collect()
    }
    let (left, right) = (parse(a), parse(b));
    let length = left.len().max(right.len());
    for index in 0..length {
        let l = left.get(index).copied().unwrap_or(0);
        let r = right.get(index).copied().unwrap_or(0);
        if l != r {
            return l.cmp(&r);
        }
    }
    std::cmp::Ordering::Equal
}

#[derive(serde::Serialize)]
struct UpdateAsset {
    name: String,
    url: String,
}

#[derive(serde::Serialize)]
struct UpdateInfo {
    current_version: String,
    latest_version: Option<String>,
    update_available: bool,
    notes: Option<String>,
    release_url: String,
    assets: Vec<UpdateAsset>,
}

#[tauri::command]
async fn check_app_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();
    let client = build_api_client();
    let response = client
        .get(UPDATE_RELEASE_API)
        .header("user-agent", "nexious-tunnel")
        .header("accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|_| "无法连接更新服务器，请检查网络后重试".to_string())?
        .error_for_status()
        .map_err(|_| "更新服务器返回异常状态".to_string())?;
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "更新信息解析失败".to_string())?;

    let latest_version = payload["tag_name"]
        .as_str()
        .map(|tag| tag.trim().trim_start_matches('v').to_string())
        .filter(|value| !value.is_empty());
    let update_available = latest_version
        .as_deref()
        .map(|latest| compare_versions(latest, &current_version) == std::cmp::Ordering::Greater)
        .unwrap_or(false);
    // 发布说明为 Markdown 原文，仅截取开头一段用于预览。
    let notes = payload["body"]
        .as_str()
        .map(|text| text.trim().chars().take(600).collect::<String>())
        .filter(|text| !text.is_empty());
    let release_url = payload["html_url"]
        .as_str()
        .filter(|url| url.starts_with(RELEASE_PAGE_HOST_PREFIX))
        .unwrap_or(RELEASE_PAGE_URL)
        .to_string();
    let mut assets: Vec<UpdateAsset> = payload["assets"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = item["name"].as_str()?.to_string();
                    let url = item["browser_download_url"].as_str()?.to_string();
                    if url.starts_with(RELEASE_PAGE_HOST_PREFIX)
                        && (name.ends_with(".exe") || name.ends_with(".msi"))
                    {
                        Some(UpdateAsset { name, url })
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    assets.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(UpdateInfo {
        current_version,
        latest_version,
        update_available,
        notes,
        release_url,
        assets,
    })
}

// 用系统默认浏览器打开发布页。仅放行本仓库域名下的地址，防止被诱导跳转任意 URL。
#[tauri::command]
fn open_release_page(url: String) -> Result<(), String> {
    if !url.starts_with(RELEASE_PAGE_HOST_PREFIX) || url.chars().any(char::is_whitespace) {
        return Err("不支持的链接地址".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&url)
            .spawn()
            .map_err(|error| format!("无法打开浏览器：{error}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = url;
    }
    Ok(())
}

// 本地控制中心运行参数的取值范围；超出时直接拒绝保存。
fn validate_runtime_settings(settings: &DesktopPreferences) -> Result<(), String> {
    if !(1..=1024).contains(&settings.max_body_mb) {
        return Err("隧道请求体上限必须在 1 - 1024 MB 之间".to_string());
    }
    if !(1..=3650).contains(&settings.log_retention_days) {
        return Err("访问日志保留天数必须在 1 - 3650 天之间".to_string());
    }
    if !(1..=3650).contains(&settings.traffic_retention_days) {
        return Err("流量统计保留天数必须在 1 - 3650 天之间".to_string());
    }
    Ok(())
}

#[tauri::command]
fn set_desktop_preferences(
    state: tauri::State<'_, DesktopPreferencesState>,
    local_api: tauri::State<'_, LocalApiState>,
    app: tauri::AppHandle,
    mut preferences: DesktopPreferences,
) -> Result<DesktopPreferences, String> {
    preferences.api_url = preferences.api_url.trim().trim_end_matches('/').to_string();
    if preferences.api_url.is_empty() {
        return Err("请填写主控制中心 API 地址".to_string());
    }
    let api_url = reqwest::Url::parse(&preferences.api_url)
        .map_err(|_| "主控制中心 API 地址必须是有效的 HTTP 或 HTTPS 地址".to_string())?;
    if !matches!(api_url.scheme(), "http" | "https") || api_url.host_str().is_none() {
        return Err("主控制中心 API 地址必须是有效的 HTTP 或 HTTPS 地址".to_string());
    }
    preferences.api_token = preferences.api_token.trim().to_string();
    // 保存即视为用户已显式确认地址，抬高版本标记，防止之后加载时被默认地址迁移改写。
    preferences.schema_version = 3;
    if preferences.api_url == LOCAL_API_URL {
        preferences.api_token = state.local_api_token.clone();
    }
    validate_runtime_settings(&preferences)?;
    sync_auto_start(preferences.auto_start)?;
    if let Some(parent) = state.path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建设置目录: {error}"))?;
    }
    let content = serde_json::to_string_pretty(&preferences)
        .map_err(|error| format!("无法序列化桌面设置: {error}"))?;
    fs::write(&state.path, content).map_err(|error| format!("无法保存桌面设置: {error}"))?;
    let previous = state.value.lock().ok().map(|value| value.clone());
    *state
        .value
        .lock()
        .map_err(|_| "桌面设置不可用".to_string())? = preferences.clone();
    // 运行参数（请求体上限/保留天数）变化时需要重启本地控制中心进程才能生效；
    // 仅切换开机自启/托盘等行为时不重启。
    let runtime_changed = previous.as_ref().is_some_and(|old| {
        old.max_body_mb != preferences.max_body_mb
            || old.log_retention_days != preferences.log_retention_days
            || old.traffic_retention_days != preferences.traffic_retention_days
    });
    let mut child = local_api.0.lock().map_err(|_| "本地控制中心状态不可用".to_string())?;
    if runtime_changed && child.is_some() {
        if let Some(mut process) = child.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
        match start_local_api(&app, &state.local_api_token, &preferences) {
            Ok(new_child) => *child = new_child,
            Err(error) => {
                return Err(format!("设置已保存，但本地控制中心重启失败: {error}"));
            }
        }
    }
    Ok(preferences)
}

#[tauri::command]
async fn api_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopPreferencesState>,
    api_client: tauri::State<'_, ApiClient>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
    // 桌面请求只使用个人账号会话，机器令牌仅用于服务启动与节点同步。
    token: Option<String>,
    session_api_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let preferences = state
        .value
        .lock()
        .map_err(|_| "桌面设置不可用".to_string())?
        .clone();
    let session_token = token.unwrap_or_default();
    let using_session = !session_token.trim().is_empty();
    let public_account_api = ["/api/health", "/api/auth/status", "/api/auth/login", "/api/auth/register", "/api/auth/email-code", "/api/auth/captcha", "/api/auth/captcha/verify"].contains(&path.as_str());
    if !using_session && !public_account_api {
        return Err(serde_json::json!({"status":401,"message":"请先登录个人账号"}).to_string());
    }
    // 兼容旧版本保存的 `https://host/api`，新版接口路径统一显式包含 `/api`。
    let mut base_url = preferences.api_url.trim_end_matches('/').to_string();
    if base_url.ends_with("/api") && path.trim_start_matches('/').starts_with("api/") {
        base_url.truncate(base_url.len() - 4);
    }
    let url = format!("{}/{}", base_url, path.trim_start_matches('/'));
    if using_session && session_api_url.as_deref().and_then(|value| secure_session::normalized_endpoint(value).ok()) != Some(secure_session::normalized_endpoint(&preferences.api_url)?) {
        return Err(serde_json::json!({"status":401,"message":"控制中心已切换，请重新登录"}).to_string());
    }
    let endpoint = url::Url::parse(&preferences.api_url).map_err(|_| "控制中心地址无效".to_string())?;
    let loopback = matches!(endpoint.host_str(), Some("127.0.0.1" | "localhost" | "::1" | "[::1]"));
    if !loopback && endpoint.scheme() != "https" && (using_session || path.starts_with("/api/auth/")) {
        return Err("远程账号登录需要 HTTPS，请为控制中心配置证书".to_string());
    }
    if uses_bundled_local_api(&preferences.api_url) {
        let local_settings = preferences.clone();
        tauri::async_runtime::spawn_blocking(move || ensure_local_api_ready(&app, &local_settings))
            .await.map_err(|_| "检查本机主控状态失败，请重试".to_string())??;
    }
    let method = method
        .parse::<reqwest::Method>()
        .map_err(|_| "无效的请求方法".to_string())?;
    // 测速要跑满上下行两个方向，单个方向最长 60s，必须比常规请求放得更宽，
    // 否则桌面端会在服务端还在采样时就判定超时。
    let is_deployment = path.ends_with("/deploy") || path.ends_with("/reset");
    let is_speed_test = path.ends_with("/speedtest");
    let timeout = if is_deployment {
        Duration::from_secs(600)
    } else if is_speed_test {
        Duration::from_secs(180)
    } else {
        Duration::from_secs(30)
    };
    let client = &api_client.0;
    let credential = session_token.trim();
    let mut request = client.request(method, url).timeout(timeout);
    if !credential.trim().is_empty() { request = request.bearer_auth(credential); }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            if is_deployment {
                "节点部署等待超时，请检查服务器网络和部署日志".to_string()
            } else if is_speed_test {
                "测速超时，请缩小数据量或检查目标服务响应".to_string()
            } else {
                "控制中心响应超时，请检查网络连接".to_string()
            }
        } else if error.is_connect() {
            format!("无法连接主控制中心，请检查 API 地址和服务状态: {error}")
        } else {
            format!("主控制中心请求失败: {error}")
        }
    })?;
    let status = response.status();
    if status == reqwest::StatusCode::NO_CONTENT {
        return Ok(serde_json::Value::Null);
    }
    let value = response
        .json::<serde_json::Value>()
        .await
        .map_err(|_| format!("控制中心返回了无效响应 ({status})"))?;
    if !status.is_success() {
        let message = value
            .get("message")
            .and_then(|value| value.as_str())
            .unwrap_or("请求失败")
            .to_string();
        return Err(serde_json::json!({"status":status.as_u16(),"message":message,"code":value.get("code"),"retryAfter":value.get("retryAfter")}).to_string());
    }
    Ok(value)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // 必须最先注册：重复启动时把已有窗口带到前台，避免多实例争抢本地 API 端口。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(AgentManager::default())
        .manage(secure_session::AccountSessionState::default())
        .setup(|app| {
            let path = app.path().app_config_dir()?.join("preferences.json");
            let local_token = load_or_create_local_api_token(
                &app.path().app_config_dir()?.join("local-api.token"),
            );
            let preferences = with_local_api_token(load_preferences(&path), &local_token);
            let use_bundled_api = uses_bundled_local_api(&preferences.api_url);
            // reg.exe 写注册表是同步 IO，放到后台线程，避免阻塞窗口事件循环启动。
            let auto_start = preferences.auto_start;
            tauri::async_runtime::spawn_blocking(move || {
                let _ = sync_auto_start(auto_start);
            });
            app.manage(ApiClient(build_api_client()));
            let local_api = if use_bundled_api {
                start_local_api(app.handle(), &local_token, &preferences)?
            } else {
                None
            };
            app.manage(LocalApiState(Mutex::new(local_api)));
            app.manage(DesktopPreferencesState {
                value: Mutex::new(preferences),
                path,
                local_api_token: local_token,
            });
            app.manage(secure_session::NodeSecretsState::default());

            let show = MenuItem::with_id(app, "show", "打开 Nexious Tunnel", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .expect("missing application icon"),
                )
                .tooltip("Nexious Tunnel")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let minimize = window
                    .state::<DesktopPreferencesState>()
                    .value
                    .lock()
                    .map(|value| value.minimize_to_tray)
                    .unwrap_or(false);
                if minimize {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        // 窗口以隐藏方式启动，页面加载完成后兜底显示，防止前端脚本异常导致窗口一直不可见。
        .on_page_load(|webview, payload| {
            if matches!(
                payload.event(),
                tauri::webview::PageLoadEvent::Finished
            ) {
                if let Some(window) = webview.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_agent,
            stop_agent,
            stop_all_agents,
            get_desktop_preferences,
            set_desktop_preferences,
            secure_session::get_account_session,
            secure_session::save_account_session,
            secure_session::clear_account_session,
            secure_session::get_node_password,
            secure_session::save_node_password,
            secure_session::clear_node_password,
            api_request,
            check_app_update,
            open_release_page
        ])
        .build(tauri::generate_context!())
        .expect("error while building Nexious Tunnel");
    app.run(|app, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            stop_local_api(app.state::<LocalApiState>().inner());
        }
    });
}
