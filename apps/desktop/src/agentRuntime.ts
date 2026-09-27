import { invoke, isTauri } from "@tauri-apps/api/core";
import { api } from "./api/client";
import type { Tunnel } from "./types";

// agent 进程操作与状态回写是两步：agent 一旦启动成功，控制中心的状态回写如果只是
// 临时失败，不应该让调用方以为整个操作失败（否则 UI 会显示"操作失败"而隧道其实已在运行）。
// 因此对状态回写做有限重试，仍失败时抛出明确错误，但不会回滚已经生效的 agent。
async function syncTunnelStatus(
  tunnelId: string,
  status: Tunnel["status"]
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await api.setTunnelStatus(tunnelId, status);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function startTunnelAgent(tunnel: Tunnel) {
  if (!isTauri()) throw new Error("请在桌面客户端中启动本机隧道");
  const credentials = await api.issueToken(tunnel.id);
  await invoke("start_agent", {
    tunnelId: tunnel.id,
    token: credentials.token,
    relay: credentials.relay,
    directRelay: credentials.directRelay ?? null,
    target: `http://${tunnel.local_host}:${tunnel.local_port}`
  });
  await syncTunnelStatus(tunnel.id, "running");
}

export async function stopTunnelAgent(tunnel: Tunnel) {
  if (!isTauri()) throw new Error("请在桌面客户端中停止本机隧道");
  await invoke("stop_agent", { tunnelId: tunnel.id });
  await syncTunnelStatus(tunnel.id, "stopped");
}
