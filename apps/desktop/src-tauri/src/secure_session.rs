use crate::DesktopPreferencesState;
use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    token: String,
    user: serde_json::Value,
    api_url: String,
    #[serde(default = "remember_by_default")]
    remember: bool,
}

fn remember_by_default() -> bool { true }

// 保存在应用进程中，页面刷新可恢复；退出应用后临时登录自动消失。
#[derive(Default)]
pub struct AccountSessionState(pub std::sync::Mutex<Option<SavedSession>>);

pub fn normalized_endpoint(value: &str) -> Result<String, String> {
    let mut url = url::Url::parse(value).map_err(|_| "控制中心地址无效".to_string())?;
    if !["http", "https"].contains(&url.scheme()) || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("控制中心地址不能包含凭据、查询参数或片段".to_string());
    }
    let path = url.path().trim_end_matches('/').trim_end_matches("/api").to_string();
    url.set_path(&path);
    Ok(url.as_str().trim_end_matches('/').to_string())
}

#[cfg(windows)]
fn protect(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    }};
    if bytes.len() > 65536 { return Err("账号会话数据过大".to_string()); }
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // DPAPI 绑定当前 Windows 用户；禁用交互提示，不使用机器级加密标记。
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        }
    };
    if ok == 0 { return Err("Windows 无法保护或恢复此账号会话，请重新登录".to_string()); }
    let value = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as *mut std::ffi::c_void); }
    Ok(value)
}
#[cfg(not(windows))]
fn protect(_bytes: &[u8], _decrypt: bool) -> Result<Vec<u8>, String> {
    Err("当前平台不支持安全保存登录状态，请使用临时会话".to_string())
}
fn session_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|_| "无法访问应用数据目录".to_string())?.join("account-session.bin"))
}
fn endpoint(state: &DesktopPreferencesState) -> Result<String, String> {
    normalized_endpoint(&state.value.lock().map_err(|_| "桌面设置不可用".to_string())?.api_url)
}

#[tauri::command]
pub fn get_account_session(app: tauri::AppHandle, state: tauri::State<'_, DesktopPreferencesState>, account: tauri::State<'_, AccountSessionState>) -> Result<Option<SavedSession>, String> {
    let mut current = account.0.lock().map_err(|_| "账号会话不可用".to_string())?;
    let api_url = endpoint(&state)?;
    if let Some(session) = current.as_ref() {
        if session.api_url == api_url { return Ok(Some(session.clone())); }
        *current = None;
    }
    let path = session_path(&app)?;
    if !path.exists() { return Ok(None); }
    let restored = std::fs::read(&path).map_err(|_| "无法读取账号会话".to_string())
        .and_then(|bytes| protect(&bytes, true))
        .and_then(|bytes| serde_json::from_slice::<SavedSession>(&bytes).map_err(|_| "账号会话已损坏".to_string()));
    match restored {
        Ok(session) if session.api_url == api_url => { *current = Some(session.clone()); Ok(Some(session)) },
        _ => { let _ = std::fs::remove_file(path); Ok(None) }
    }
}
#[tauri::command]
pub fn save_account_session(app: tauri::AppHandle, state: tauri::State<'_, DesktopPreferencesState>, account: tauri::State<'_, AccountSessionState>, mut session: SavedSession, remember: Option<bool>) -> Result<(), String> {
    if session.token.len() != 43 || !session.token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') || session.api_url != endpoint(&state)? {
        return Err("会话与当前控制中心不匹配，请重新登录".to_string());
    }
    let mut current = account.0.lock().map_err(|_| "账号会话不可用".to_string())?;
    session.remember = false;
    *current = Some(session.clone());
    let path = session_path(&app)?;
    if !remember.unwrap_or(true) {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("无法清理旧的登录状态".to_string()),
        };
    }
    session.remember = true;
    let bytes = serde_json::to_vec(&session).map_err(|_| "无法编码账号会话".to_string())?;
    let encrypted = protect(&bytes, false)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|_| "无法创建账号会话目录".to_string())?;
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, encrypted).map_err(|error| format!("无法写入账号会话: {error}"))?;
    // 应用数据目录可能启用 Windows 文件加密。该目录下的 rename 在部分系统
    // 会错误返回“不同的磁盘驱动器”，使用同目录 copy 可以保持加密属性并兼容这类环境。
    let result = std::fs::copy(&temporary, &path)
        .map(|_| { let _ = std::fs::remove_file(&temporary); () })
        .map_err(|error| format!("无法保存账号会话: {error}"));
    if result.is_ok() { *current = Some(session); }
    result
}
#[tauri::command]
pub fn clear_account_session(app: tauri::AppHandle, account: tauri::State<'_, AccountSessionState>) -> Result<(), String> {
    *account.0.lock().map_err(|_| "账号会话不可用".to_string())? = None;
    match std::fs::remove_file(session_path(&app)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法清理账号会话文件".to_string()),
    }
}

// 节点 SSH 密码与账号会话分开存放：换主控地址时旧凭据立即失效，不需要额外校验。
#[derive(Default)]
pub struct NodeSecretsState(pub std::sync::Mutex<Option<SavedNodeSecrets>>);
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedNodeSecrets {
    api_url: String,
    #[serde(default)]
    passwords: std::collections::HashMap<String, String>,
}
fn secrets_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|_| "无法访问应用数据目录".to_string())?.join("node-secrets.bin"))
}
fn valid_node_id(value: &str) -> bool {
    (2..=64).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn load_node_secrets(app: &tauri::AppHandle, state: &NodeSecretsState, api_url: &str) -> Result<SavedNodeSecrets, String> {
    let empty = || SavedNodeSecrets { api_url: api_url.to_string(), passwords: Default::default() };
    let mut current = state.0.lock().map_err(|_| "节点凭据不可用".to_string())?;
    if let Some(secrets) = current.as_ref() {
        if secrets.api_url == api_url { return Ok(secrets.clone()); }
        *current = None;
    }
    let path = secrets_path(app)?;
    if !path.exists() { return Ok(empty()); }
    let restored = std::fs::read(&path).map_err(|_| "无法读取节点凭据".to_string())
        .and_then(|bytes| protect(&bytes, true))
        .and_then(|bytes| serde_json::from_slice::<SavedNodeSecrets>(&bytes).map_err(|_| "节点凭据已损坏".to_string()));
    match restored {
        Ok(secrets) if secrets.api_url == api_url => { *current = Some(secrets.clone()); Ok(secrets) }
        _ => { let _ = std::fs::remove_file(path); Ok(empty()) }
    }
}
fn persist_node_secrets(app: &tauri::AppHandle, state: &NodeSecretsState, secrets: SavedNodeSecrets) -> Result<(), String> {
    let path = secrets_path(app)?;
    let encrypted = protect(&serde_json::to_vec(&secrets).map_err(|_| "无法编码节点凭据".to_string())?, false)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|_| "无法创建节点凭据目录".to_string())?;
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, encrypted).map_err(|error| format!("无法写入节点凭据: {error}"))?;
    let result = std::fs::copy(&temporary, &path)
        .map(|_| { let _ = std::fs::remove_file(&temporary); () })
        .map_err(|error| format!("无法保存节点凭据: {error}"));
    if result.is_ok() { *state.0.lock().map_err(|_| "节点凭据不可用".to_string())? = Some(secrets); }
    result
}
#[tauri::command]
pub fn get_node_password(app: tauri::AppHandle, state: tauri::State<'_, DesktopPreferencesState>, secrets: tauri::State<'_, NodeSecretsState>, node_id: String) -> Result<Option<String>, String> {
    if !valid_node_id(&node_id) { return Err("节点标识无效".to_string()); }
    let api_url = endpoint(&state)?;
    Ok(load_node_secrets(&app, &secrets, &api_url)?.passwords.get(&node_id).cloned())
}
#[tauri::command]
pub fn save_node_password(app: tauri::AppHandle, state: tauri::State<'_, DesktopPreferencesState>, secrets: tauri::State<'_, NodeSecretsState>, node_id: String, password: String) -> Result<(), String> {
    if !valid_node_id(&node_id) { return Err("节点标识无效".to_string()); }
    if password.is_empty() || password.len() > 200 { return Err("SSH 密码长度不合法".to_string()); }
    let api_url = endpoint(&state)?;
    let mut value = load_node_secrets(&app, &secrets, &api_url)?;
    value.passwords.insert(node_id, password);
    persist_node_secrets(&app, &secrets, value)
}
#[tauri::command]
pub fn clear_node_password(app: tauri::AppHandle, state: tauri::State<'_, DesktopPreferencesState>, secrets: tauri::State<'_, NodeSecretsState>, node_id: String) -> Result<(), String> {
    if !valid_node_id(&node_id) { return Err("节点标识无效".to_string()); }
    let api_url = endpoint(&state)?;
    let mut value = load_node_secrets(&app, &secrets, &api_url)?;
    value.passwords.remove(&node_id);
    persist_node_secrets(&app, &secrets, value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_is_bound_to_one_controller() {
        assert_eq!(normalized_endpoint("https://example.com/api/").unwrap(), "https://example.com");
        assert!(normalized_endpoint("https://user:pass@example.com").is_err());
        assert_ne!(normalized_endpoint("https://one.example.com").unwrap(), normalized_endpoint("https://two.example.com").unwrap());
    }
    #[cfg(windows)]
    #[test]
    fn saved_session_is_encrypted_and_detects_corruption() {
        let value = b"session-token-that-must-not-appear-in-the-file";
        let mut encrypted = protect(value, false).unwrap();
        assert!(!encrypted.windows(value.len()).any(|part| part == value));
        assert_eq!(protect(&encrypted, true).unwrap(), value);
        let last = encrypted.len() - 1;
        encrypted[last] ^= 1;
        assert!(protect(&encrypted, true).is_err());
    }
}
