import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: true,
  saved: null as { token: string; user: { id: string; username: string; role: string }; apiUrl: string; remember: boolean } | null,
  invoke: vi.fn(), login: vi.fn(), me: vi.fn(), logout: vi.fn()
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => mocks.native, invoke: mocks.invoke }));
vi.mock("./api/client", () => ({
  ApiError: class extends Error { constructor(message: string, public status: number) { super(message); } },
  api: { login: mocks.login, me: mocks.me, logout: mocks.logout }
}));

const user = { id: "test-account", username: "session-test", role: "admin" };
const token = "s".repeat(43);
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.native = true; mocks.saved = null;
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { origin: "http://localhost:1420" } }));
  vi.stubGlobal("localStorage", storage()); vi.stubGlobal("sessionStorage", storage());
  mocks.login.mockResolvedValue({ user, token }); mocks.me.mockResolvedValue(user); mocks.logout.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (command: string, args?: { session: { token: string; user: typeof user; apiUrl: string }; remember: boolean }) => {
    if (command === "get_desktop_preferences") return { apiUrl: "http://127.0.0.1:8787" };
    if (command === "save_account_session") { mocks.saved = { ...args!.session, remember: args!.remember }; return; }
    if (command === "get_account_session") return mocks.saved;
    if (command === "clear_account_session") mocks.saved = null;
  });
});

it("桌面临时登录刷新后仍能恢复，且不升级为保持登录", async () => {
  const first = await import("./session");
  await first.login("session-test", "test-password", "test-ticket", false);
  expect(mocks.saved?.remember).toBe(false);
  expect(sessionStorage.getItem("nexious-session")).toBeNull();
  vi.resetModules();
  const refreshed = await import("./session");
  expect(await refreshed.refreshIdentity()).toBe("ok");
  expect(refreshed.currentUser.value?.id).toBe(user.id);
  expect(mocks.saved?.remember).toBe(false);
});

it("保持登录的会话刷新后继续保持，退出后不可恢复", async () => {
  await (await import("./session")).login("session-test", "test-password", "test-ticket", true);
  vi.resetModules();
  const refreshed = await import("./session");
  expect(await refreshed.refreshIdentity()).toBe("ok"); expect(mocks.saved?.remember).toBe(true);
  await refreshed.logout(); vi.resetModules();
  expect(await (await import("./session")).refreshIdentity()).toBe("anonymous");
});

it("浏览器登录刷新后从当前标签页恢复，不调用桌面接口", async () => {
  mocks.native = false;
  await (await import("./session")).login("session-test", "test-password", "test-ticket");
  vi.resetModules();
  const refreshed = await import("./session");
  expect(await refreshed.refreshIdentity()).toBe("ok");
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("服务端撤销会话后刷新清除本机登录", async () => {
  await (await import("./session")).login("session-test", "test-password", "test-ticket");
  const { ApiError } = await import("./api/client");
  mocks.me.mockRejectedValueOnce(new ApiError("请先登录", 401));
  const session = await import("./session");
  expect(await session.refreshIdentity()).toBe("anonymous");
  expect(session.isAuthenticated.value).toBe(false); expect(mocks.saved).toBeNull();
});
