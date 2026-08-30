import type {
  AccessLogPage,
  Dashboard,
  NodeInfo,
  NodeInput,
  NodeInspection,
  NodeDeployment,
  DeploymentJob,
  ServerConnectionInput,
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
  health: () => request<{ ok: boolean }>("/api/health"),
  dashboard: () => request<Dashboard>("/api/dashboard"),
  tunnels: () => request<Tunnel[]>("/api/tunnels"),
  nodes: () => request<NodeInfo[]>("/api/nodes"),
  createNode: (value: NodeInput) =>
    request<NodeInfo>("/api/nodes", {
      method: "POST",
      body: JSON.stringify(value)
    }),
  updateNode: (id: string, value: NodeInput) =>
    request<NodeInfo>(`/api/nodes/${id}`, {
      method: "PUT",
      body: JSON.stringify(value)
    }),
  deleteNode: (id: string) =>
    request<void>(`/api/nodes/${id}`, { method: "DELETE" }),
  inspectNode: (id:string, value:ServerConnectionInput) => request<NodeInspection>(`/api/nodes/${id}/inspect`, {
    method:"POST", body:JSON.stringify(value)
  }),
  deployNode: (id:string, value:ServerConnectionInput & {force?:boolean}) => request<{jobId:string}>(`/api/nodes/${id}/deploy`, {
    method:"POST", body:JSON.stringify(value)
  }),
  deployment: (jobId:string,cursor:number) => request<DeploymentJob>(`/api/deployments/${jobId}?cursor=${cursor}`),
  createTunnel: (value: TunnelInput) =>
    request<Tunnel>("/api/tunnels", {
      method: "POST",
      body: JSON.stringify(value)
    }),
  updateTunnel: (id: string, value: TunnelInput) =>
    request<Tunnel>(`/api/tunnels/${id}`, {
      method: "PUT",
      body: JSON.stringify(value)
    }),
  setTunnelStatus: (id: string, status: Tunnel["status"]) =>
    request(`/api/tunnels/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status })
    }),
  deleteTunnel: (id: string) =>
    request<void>(`/api/tunnels/${id}`, { method: "DELETE" }),
  issueToken: (id: string) =>
    request<{ token: string; tunnelId: string; relay: string }>(
      `/api/tunnels/${id}/token`,
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
    return request<AccessLogPage>(`/api/logs?${query}`);
  }
};
