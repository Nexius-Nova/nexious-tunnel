import { computed, ref } from "vue";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { api, ApiError } from "./api/client";
import { suspendLifecycleGuards } from "./composables/useTunnelLifecycle";
import { sessionToken, sessionEndpoint } from "./authToken";
import type { AuthUser, Preferences, Role } from "./types";

const STORAGE_KEY = "nexious-session";
interface StoredSession { token: string; user: AuthUser; apiUrl: string; remember?: boolean }
export { sessionToken };
export const currentUser = ref<AuthUser | null>(null);
export const storageWarning = ref("");
const remembered = ref(false);
export const isAuthenticated = computed(() => Boolean(sessionToken.value));
export const role = computed<Role>(() => currentUser.value?.role === "admin" ? "admin" : "user");
export const isAdmin = computed(() => role.value === "admin");
export const mustChangePassword = computed(() => Boolean(currentUser.value?.mustChangePassword));
export const displayName = computed(() => currentUser.value?.username || "");

function normalizedEndpoint(value: string) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "");
  return url.href.replace(/\/+$/, "");
}
export async function getApiEndpoint(): Promise<string> {
  if (!isTauri()) return window.location.origin;
  const preferences = await invoke<Preferences>("get_desktop_preferences");
  return normalizedEndpoint(preferences.apiUrl);
}
function clearBrowserStorage() {
  try { localStorage.removeItem(STORAGE_KEY); sessionStorage.removeItem(STORAGE_KEY); } catch { /* 存储不可用 */ }
}
export async function clearSession() {
  sessionToken.value = ""; sessionEndpoint.value = ""; currentUser.value = null; remembered.value = false;
  clearBrowserStorage();
  if (isTauri()) await invoke("clear_account_session");
}
async function persist(token: string, user: AuthUser, apiUrl: string, remember = false) {
  sessionToken.value = token; sessionEndpoint.value = apiUrl; currentUser.value = user;
  remembered.value = remember && isTauri(); storageWarning.value = "";
  const session: StoredSession = { token, user, apiUrl };
  try {
    localStorage.removeItem(STORAGE_KEY);
    if (isTauri()) {
      await invoke("save_account_session", { session, remember: remembered.value });
    } else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // 未勾选“在此设备保持登录”时不需要持久化，清理失败也不应打断本次登录。
    if (remembered.value) storageWarning.value = "当前设备无法安全保存登录状态，本次登录仍可使用，关闭后请重新登录。";
  }
}
export async function login(username: string, password: string, captchaTicket: string, remember = false) {
  const endpoint = await getApiEndpoint(), result = await api.login(username, password, captchaTicket, remember && isTauri());
  await persist(result.token, result.user, endpoint, remember); return result.user;
}
export async function register(value: {username:string;password:string;email:string;verificationId:string;code:string;inviteCode?:string}, remember = false) {
  const endpoint = await getApiEndpoint(), result = await api.register(value, remember && isTauri());
  await persist(result.token, result.user, endpoint, remember); return result.user;
}
export async function logout() {
  // 退出登录必须先停本机 agent：它持有隧道 token，与用户会话无关，不停会继续转发流量。
  // 服务端检测到 agent 掉线会自动把状态收敛为 stopped；同时挂起自动启动守护，
  // 防止登出期间的定时刷新把 auto_start 隧道重新拉起（重新登录时在 onSignedIn 恢复）。
  if (isTauri()) await invoke("stop_all_agents").catch(() => undefined);
  suspendLifecycleGuards();
  try { if (sessionToken.value) await api.logout(); }
  finally { await clearSession(); }
}
export async function changePassword(currentPassword: string, newPassword: string) {
  const token = sessionToken.value, user = currentUser.value, endpoint = sessionEndpoint.value;
  const result = await api.changePassword(currentPassword, newPassword, remembered.value);
  if (user && token === sessionToken.value && user.id === currentUser.value?.id) await persist(result.token, { ...user, mustChangePassword: false }, endpoint, remembered.value);
}
export async function refreshIdentity(): Promise<"ok" | "anonymous" | "unavailable"> {
  try {
    if (!sessionToken.value) {
      let saved: StoredSession | null = null;
      if (isTauri()) { saved = await invoke<StoredSession | null>("get_account_session"); remembered.value = Boolean(saved && (saved.remember ?? true)); }
      else {
        try { saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null"); } catch { /* 损坏的缓存 */ }
      }
      // 旧版本的明文持久化凭据不再沿用。
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* 存储不可用 */ }
      if (saved && /^[a-zA-Z0-9_-]{43}$/.test(saved.token) && saved.user?.id && saved.apiUrl === await getApiEndpoint()) {
        sessionToken.value = saved.token; sessionEndpoint.value = saved.apiUrl; currentUser.value = saved.user;
      } else return "anonymous";
    }
    if (sessionEndpoint.value !== await getApiEndpoint()) { await clearSession(); return "anonymous"; }
    const me = await api.me();
    currentUser.value = me;
    await persist(sessionToken.value, me, sessionEndpoint.value, remembered.value);
    return "ok";
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) { await clearSession(); return "anonymous"; }
    return sessionToken.value ? "unavailable" : "anonymous";
  }
}
window.addEventListener("nexious-auth-expired", () => { void clearSession().catch(() => {}); });
window.addEventListener("nexious-password-required", () => { if (currentUser.value) currentUser.value = { ...currentUser.value, mustChangePassword: true }; });
