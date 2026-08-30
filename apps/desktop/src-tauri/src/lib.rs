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
const LOCAL_API_PORT: u16 = 8787;
// 隧道响应体上限：整包 base64+JSON 转发在内存中完成，必须限制大小防止打爆内存。
const TUNNEL_RESPONSE_LIMIT: usize = 64 * 1024 * 1024;

#[derive(Default)]
struct AgentManager(Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>);

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
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            auto_start: false,
            minimize_to_tray: true,
            api_url: "http://127.0.0.1:8787".to_string(),
            api_token: String::new(),
            max_body_mb: 25,
            log_retention_days: 30,
            traffic_retention_days: 90,
        }
    }
}

struct DesktopPreferencesState {
    value: Mutex<DesktopPreferences>,
    path: PathBuf,
    local_api_token: String,
}

struct ApiClient(reqwest::Client);

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
) -> Result<(), String> {
    let mut processes = manager
        .0
        .lock()
        .map_err(|_| "Agent 状态不可用".to_string())?;
    if let Some(existing) = processes.remove(&tunnel_id) {
        existing.abort();
    }
    let key = tunnel_id.clone();
    let task = tauri::async_runtime::spawn(run_agent(relay, tunnel_id, token, target));
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

async fn run_agent(relay: String, tunnel_id: String, token: String, target: String) {
    let client = reqwest::Client::new();
    loop {
        let endpoint = format!(
            "{}?tunnel={}&token={}",
            relay,
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
        let Ok((socket, _)) = tokio_tungstenite::connect_async(connect_request).await else {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            continue;
        };
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
        while let Some(Ok(message)) = reader.next().await {
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
    let Ok(url) = reqwest::Url::parse(&target).and_then(|base| base.join(path)) else {
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
    let Ok(mut url) = reqwest::Url::parse(&target).and_then(|base| base.join(path)) else {
        send_local_websocket_close(&relay_sender, &id, 1011, "invalid local websocket URL");
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
    let Ok((local, _)) = tokio_tungstenite::connect_async(local_request).await else {
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

#[cfg(test)]
mod tests {
    use super::{
        insert_response_header, normalize_loaded_preferences, uses_bundled_local_api,
        with_local_api_token, DesktopPreferences,
    };

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
        let preferences = with_local_api_token(DesktopPreferences::default(), "generated-token-0123456789abcdef");

        assert_eq!(preferences.api_token, "generated-token-0123456789abcdef");
        let remote = with_local_api_token(
            DesktopPreferences {
                api_url: "https://relay.example.com/api".to_string(),
                ..DesktopPreferences::default()
            },
            "generated-token-0123456789abcdef"
        );
        assert_eq!(remote.api_token, "");
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
        // Development mode uses the workspace's concurrently-managed API process.
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
            if authorized {
                append_local_api_log(&data_dir, "8787 端口已有兼容的本地控制中心在运行，直接复用");
                return Ok(None);
            }
            append_local_api_log(
                &data_dir,
                "检测到携带旧 token 的残留控制中心进程，正在结束并重新启动",
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
        .arg(entry)
        .current_dir(&bundled_dir)
        .env("PORT", LOCAL_API_PORT.to_string())
        .env("BIND_HOST", "127.0.0.1")
        .env("NEXIOUS_DB_PATH", data_dir.join("nexious.db"))
        .env("NEXIOUS_ADMIN_TOKEN", admin_token)
        .env("NEXIOUS_SKIP_SEED", "1")
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
    state: tauri::State<'_, DesktopPreferencesState>,
    api_client: tauri::State<'_, ApiClient>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let preferences = state
        .value
        .lock()
        .map_err(|_| "桌面设置不可用".to_string())?
        .clone();
    if preferences.api_token.trim().is_empty() {
        return Err("请先在偏好设置中填写管理 Token".to_string());
    }
    // 兼容旧版本保存的 `https://host/api`，新版接口路径统一显式包含 `/api`。
    let mut base_url = preferences.api_url.trim_end_matches('/').to_string();
    if base_url.ends_with("/api") && path.trim_start_matches('/').starts_with("api/") {
        base_url.truncate(base_url.len() - 4);
    }
    let url = format!("{}/{}", base_url, path.trim_start_matches('/'));
    let method = method
        .parse::<reqwest::Method>()
        .map_err(|_| "无效的请求方法".to_string())?;
    let is_deployment = path.ends_with("/deploy");
    let timeout = if is_deployment {
        Duration::from_secs(600)
    } else {
        Duration::from_secs(30)
    };
    let client = &api_client.0;
    let mut request = client
        .request(method, url)
        .timeout(timeout)
        .bearer_auth(preferences.api_token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            if is_deployment {
                "节点部署等待超时，请检查服务器网络和部署日志".to_string()
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
        if status == reqwest::StatusCode::UNAUTHORIZED && preferences.api_url == LOCAL_API_URL {
            return Err(format!(
                "{message}：本地控制中心 Token 不匹配，请完全退出并重新启动应用"
            ));
        }
        return Err(message);
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
            app.manage(ApiClient(reqwest::Client::new()));
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
            get_desktop_preferences,
            set_desktop_preferences,
            api_request
        ])
        .build(tauri::generate_context!())
        .expect("error while building Nexious Tunnel");
    app.run(|app, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            stop_local_api(app.state::<LocalApiState>().inner());
        }
    });
}
