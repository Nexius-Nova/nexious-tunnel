import type {
  AccessLogPage,
  Dashboard,
  NodeInfo,
  NodeInput,
  Tunnel,
  TunnelInput
} from "../types";
import { invoke } from "@tauri-apps/api/core";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  try {
    const body =
      typeof options.body === "string" ? JSON.parse(options.body) : undefined;
    return await invoke<T>("api_request", {
      method: options.method || "GET",
      path,
      body
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : "请求失败",
      0
    );
  }
}
export const api = {
  dashboard: () => request<Dashboard>("/dashboard"),
  tunnels: () => request<Tunnel[]>("/tunnels"),
  nodes: () => request<NodeInfo[]>("/nodes"),
  createNode: (value: NodeInput) =>
    request<NodeInfo>("/nodes", {
      method: "POST",
      body: JSON.stringify(value)
    }),
  updateNode: (id: string, value: NodeInput) =>
    request<NodeInfo>(`/nodes/${id}`, {
      method: "PUT",
      body: JSON.stringify(value)
    }),
  deleteNode: (id: string) =>
    request<void>(`/nodes/${id}`, { method: "DELETE" }),
  createTunnel: (value: TunnelInput) =>
    request<Tunnel>("/tunnels", {
      method: "POST",
      body: JSON.stringify(value)
    }),
  updateTunnel: (id: string, value: TunnelInput) =>
    request<Tunnel>(`/tunnels/${id}`, {
      method: "PUT",
      body: JSON.stringify(value)
    }),
  setTunnelStatus: (id: string, status: Tunnel["status"]) =>
    request(`/tunnels/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    }),
  deleteTunnel: (id: string) =>
    request<void>(`/tunnels/${id}`, { method: "DELETE" }),
  issueToken: (id: string) =>
    request<{ token: string; tunnelId: string; relay: string }>(
      `/tunnels/${id}/token`,
      { method: "POST" }
    ),
  logs: (params: {
    tunnelId?: string;
    search?: string;
    status?: "all" | "success" | "error";
    page: number;
    pageSize: number;
  }) => {
    const query = new URLSearchParams(
      Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== "")
        .map(([key, value]) => [key, String(value)])
    );
    return request<AccessLogPage>(`/logs?${query}`);
  }
};
