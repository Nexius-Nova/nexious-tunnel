import { invoke } from "@tauri-apps/api/core";
import { api } from "./api/client";
import type { Tunnel } from "./types";

export async function startTunnelAgent(tunnel: Tunnel) {
  const credentials = await api.issueToken(tunnel.id);
  await invoke("start_agent", {
    tunnelId: tunnel.id,
    token: credentials.token,
    relay: credentials.relay,
    target: `http://${tunnel.local_host}:${tunnel.local_port}`
  });
  await api.setTunnelStatus(tunnel.id, "running");
}

export async function stopTunnelAgent(tunnel: Tunnel) {
  await invoke("stop_agent", { tunnelId: tunnel.id });
  await api.setTunnelStatus(tunnel.id, "stopped");
}
