use std::{collections::HashMap, fs, path::PathBuf, process::{Command, Stdio}, sync::Mutex, time::Duration};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{menu::{Menu, MenuItem}, tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}, Manager};

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
}

impl Default for DesktopPreferences {
  fn default() -> Self { Self { auto_start: false, minimize_to_tray: true, api_url: "http://127.0.0.1:8787".to_string(), api_token: String::new() } }
}

struct DesktopPreferencesState {
  value: Mutex<DesktopPreferences>,
  path: PathBuf,
}

#[tauri::command]
fn start_agent(manager: tauri::State<'_, AgentManager>, tunnel_id: String, token: String, relay: String, target: String) -> Result<(), String> {
  let mut processes = manager.0.lock().map_err(|_| "Agent 状态不可用".to_string())?;
  if let Some(existing) = processes.remove(&tunnel_id) { existing.abort(); }
  let key = tunnel_id.clone();
  let task = tauri::async_runtime::spawn(run_agent(relay, tunnel_id, token, target));
  processes.insert(key, task);
  Ok(())
}

#[tauri::command]
fn stop_agent(manager: tauri::State<'_, AgentManager>, tunnel_id: String) -> Result<(), String> {
  let mut processes = manager.0.lock().map_err(|_| "Agent 状态不可用".to_string())?;
  if let Some(process) = processes.remove(&tunnel_id) { process.abort(); }
  Ok(())
}

async fn run_agent(relay: String, tunnel_id: String, token: String, target: String) {
  let client = reqwest::Client::new();
  loop {
    let endpoint = format!("{}?tunnel={}&token={}", relay, url::form_urlencoded::byte_serialize(tunnel_id.as_bytes()).collect::<String>(), url::form_urlencoded::byte_serialize(token.as_bytes()).collect::<String>());
    if let Ok((socket, _)) = tokio_tungstenite::connect_async(&endpoint).await {
      let (mut writer, mut reader) = socket.split();
      while let Some(Ok(message)) = reader.next().await {
        if !message.is_text() { continue; }
        let Ok(request) = serde_json::from_str::<serde_json::Value>(message.to_text().unwrap_or("")) else { continue; };
        let id = request.get("id").and_then(|value| value.as_str()).unwrap_or_default().to_string();
        let path = request.get("path").and_then(|value| value.as_str()).unwrap_or("/");
        let method = request.get("method").and_then(|value| value.as_str()).unwrap_or("GET").parse().unwrap_or(reqwest::Method::GET);
        let Ok(url) = reqwest::Url::parse(&target).and_then(|base| base.join(path)) else { continue; };
        let body = request.get("body").and_then(|value| value.as_str()).and_then(|value| BASE64.decode(value).ok()).unwrap_or_default();
        let response = client.request(method, url).body(body).send().await;
        let payload = match response {
          Ok(response) => {
            let status = response.status().as_u16();
            let headers = response.headers().iter().filter_map(|(key,value)| value.to_str().ok().map(|value|(key.to_string(),value.to_string()))).collect::<HashMap<_,_>>();
            let body = response.bytes().await.unwrap_or_default();
            serde_json::json!({"id":id,"status":status,"headers":headers,"body":BASE64.encode(body)})
          },
          Err(_) => serde_json::json!({"id":id,"status":502,"headers":{"content-type":"text/plain; charset=utf-8"},"body":BASE64.encode("local service unavailable")})
        };
        if writer.send(tokio_tungstenite::tungstenite::Message::Text(payload.to_string().into())).await.is_err() { break; }
      }
    }
    tokio::time::sleep(Duration::from_millis(1500)).await;
  }
}

fn load_preferences(path: &PathBuf) -> DesktopPreferences {
  let mut preferences: DesktopPreferences = fs::read_to_string(path).ok().and_then(|value| serde_json::from_str(&value).ok()).unwrap_or_default();
  if preferences.api_url.contains("8.134.156.74") || preferences.api_url.contains("relay.nexious-ppt.xyz") {
    preferences.api_url = "http://127.0.0.1:8787".to_string();
    if let Ok(content) = serde_json::to_string_pretty(&preferences) { let _ = fs::write(path, content); }
  }
  preferences
}

fn sync_auto_start(enabled: bool) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    let status = if enabled {
      let executable = std::env::current_exe().map_err(|error| format!("无法定位应用程序: {error}"))?;
      let value = format!("\"{}\"", executable.display());
      Command::new("reg.exe").args(["add", key, "/v", "NexiousTunnel", "/t", "REG_SZ", "/d", &value, "/f"]).stdout(Stdio::null()).stderr(Stdio::null()).status()
    } else {
      Command::new("reg.exe").args(["delete", key, "/v", "NexiousTunnel", "/f"]).stdout(Stdio::null()).stderr(Stdio::null()).status()
    }.map_err(|error| format!("无法更新开机启动设置: {error}"))?;
    if enabled && !status.success() { return Err("开机启动设置写入失败".to_string()); }
    return Ok(())
  }
  #[cfg(not(target_os = "windows"))]
  {
    if enabled { return Err("当前系统暂不支持开机启动".to_string()); }
    Ok(())
  }
}

#[tauri::command]
fn get_desktop_preferences(state: tauri::State<'_, DesktopPreferencesState>) -> Result<DesktopPreferences, String> {
  state.value.lock().map(|value| value.clone()).map_err(|_| "桌面设置不可用".to_string())
}

#[tauri::command]
fn set_desktop_preferences(state: tauri::State<'_, DesktopPreferencesState>, preferences: DesktopPreferences) -> Result<DesktopPreferences, String> {
  sync_auto_start(preferences.auto_start)?;
  if let Some(parent) = state.path.parent() { fs::create_dir_all(parent).map_err(|error| format!("无法创建设置目录: {error}"))?; }
  let content = serde_json::to_string_pretty(&preferences).map_err(|error| format!("无法序列化桌面设置: {error}"))?;
  fs::write(&state.path, content).map_err(|error| format!("无法保存桌面设置: {error}"))?;
  *state.value.lock().map_err(|_| "桌面设置不可用".to_string())? = preferences.clone();
  Ok(preferences)
}

#[tauri::command]
async fn api_request(state: tauri::State<'_, DesktopPreferencesState>, method: String, path: String, body: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
  let preferences = state.value.lock().map_err(|_| "桌面设置不可用".to_string())?.clone();
  if preferences.api_token.trim().is_empty() { return Err("请先在偏好设置中填写管理 Token".to_string()); }
  // 兼容旧版本保存的 `https://host/api`，新版接口路径统一显式包含 `/api`。
  let mut base_url = preferences.api_url.trim_end_matches('/').to_string();
  if base_url.ends_with("/api") && path.trim_start_matches('/').starts_with("api/") {
    base_url.truncate(base_url.len() - 4);
  }
  let url = format!("{}/{}", base_url, path.trim_start_matches('/'));
  let method = method.parse::<reqwest::Method>().map_err(|_| "无效的请求方法".to_string())?;
  let is_deployment = path.ends_with("/deploy");
  let timeout = if is_deployment { Duration::from_secs(600) } else { Duration::from_secs(30) };
  let client = reqwest::Client::builder().timeout(timeout).build().map_err(|error| error.to_string())?;
  let mut request = client.request(method, url).bearer_auth(preferences.api_token);
  if let Some(body) = body { request = request.json(&body); }
  let response = request.send().await.map_err(|error| {
    if error.is_timeout() {
      if is_deployment { "节点部署等待超时，请检查服务器网络和部署日志".to_string() }
      else { "控制中心响应超时，请检查网络连接".to_string() }
    } else if error.is_connect() {
      format!("无法连接主控制中心，请检查 API 地址和服务状态: {error}")
    } else {
      format!("主控制中心请求失败: {error}")
    }
  })?;
  let status = response.status();
  if status == reqwest::StatusCode::NO_CONTENT { return Ok(serde_json::Value::Null); }
  let value = response.json::<serde_json::Value>().await.map_err(|_| format!("控制中心返回了无效响应 ({status})"))?;
  if !status.is_success() { return Err(value.get("message").and_then(|value| value.as_str()).unwrap_or("请求失败").to_string()); }
  Ok(value)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(AgentManager::default())
    .setup(|app| {
      let path = app.path().app_config_dir()?.join("preferences.json");
      let preferences = load_preferences(&path);
      let _ = sync_auto_start(preferences.auto_start);
      app.manage(DesktopPreferencesState { value: Mutex::new(preferences), path });

      let show = MenuItem::with_id(app, "show", "打开 Nexious Tunnel", true, None::<&str>)?;
      let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
      let menu = Menu::with_items(app, &[&show, &quit])?;
      TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().expect("missing application icon"))
        .tooltip("Nexious Tunnel")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
          "show" => if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); },
          "quit" => app.exit(0),
          _ => {}
        })
        .on_tray_icon_event(|tray, event| {
          if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            if let Some(window) = tray.app_handle().get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
          }
        })
        .build(app)?;
      Ok(())
    })
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let minimize = window.state::<DesktopPreferencesState>().value.lock().map(|value| value.minimize_to_tray).unwrap_or(false);
        if minimize { api.prevent_close(); let _ = window.hide(); }
      }
    })
    .invoke_handler(tauri::generate_handler![start_agent, stop_agent, get_desktop_preferences, set_desktop_preferences, api_request])
    .run(tauri::generate_context!())
    .expect("error while running Nexious Tunnel");
}
