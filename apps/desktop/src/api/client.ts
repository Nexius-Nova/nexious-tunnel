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
  TunnelInput,
  AuthUser,
  AuthStatus,
  ManagedUser,
  AuditLogPage,
  UserPage,
  LoginSession,
  NodeDetail,
  SpeedTestInput,
  SpeedTestResult
} from "../types";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { sessionToken, sessionEndpoint } from "../authToken";
import { requestReauthentication } from "../reauthentication";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public retryAfter?: number
  ) {
    super(message);
  }
}
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const fallback = typeof error === "string" ? error : error instanceof Error ? error.message : "请求失败";
  let value: unknown = error instanceof Error || typeof error === "string" ? fallback : error;
  // 桌面桥接可能把错误包装成 Error，或对 JSON 字符串再次编码。
  for (let index = 0; index < 3 && typeof value === "string"; index++) {
    try { value = JSON.parse(value); } catch { break; }
  }
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
    const details = value as { message: string; status?: unknown; code?: unknown; retryAfter?: unknown };
    return new ApiError(details.message, typeof details.status === "number" ? details.status : 0,
      typeof details.code === "string" ? details.code : undefined,
      typeof details.retryAfter === "number" ? details.retryAfter : undefined);
  }
  return new ApiError(typeof value === "string" ? value : fallback, 0);
}
async function request<T>(path: string, options: RequestInit = {}, verified = false): Promise<T> {
  const requestToken = sessionToken.value;
  const requestEndpoint = sessionEndpoint.value;
  try {
    const body =
      typeof options.body === "string" ? JSON.parse(options.body) : undefined;
    if (!isTauri()) {
      const response = await fetch(path, { ...options,
        headers: { "content-type": "application/json", ...(requestToken ? { authorization: `Bearer ${requestToken}` } : {}), ...options.headers },
        signal: options.signal || AbortSignal.timeout(30000), credentials: "omit", redirect: "error" });
      if (response.status === 204) return undefined as T;
      const value = await response.json().catch(() => null);
      if (!response.ok) throw new ApiError(value?.message || `请求失败 (${response.status})`, response.status, value?.code, value?.retryAfter);
      if (value === null) throw new ApiError("控制中心返回了无效响应", response.status);
      return value as T;
    }
    return await invoke<T>("api_request", {
      method: options.method || "GET",
      path,
      body,
      // 本机与远程请求均使用个人账号会话。
      token: requestToken || null,
      sessionApiUrl: requestEndpoint || null
    });
  } catch (error) {
    const apiError = toApiError(error);
    if (!verified && requestToken && requestToken===sessionToken.value && apiError.code==="REAUTHENTICATION_REQUIRED") {
      await requestReauthentication();
      if(requestToken!==sessionToken.value)throw new ApiError("登录状态已变化，请重新执行操作",401);
      // 只重试被服务端明确拒绝、尚未产生副作用的请求；网络失败不重放写入。
      return request<T>(path,options,true);
    }
    if (requestToken && requestToken === sessionToken.value && apiError.status === 401 && !["/api/auth/login", "/api/auth/register"].includes(path)) window.dispatchEvent(new CustomEvent("nexious-auth-expired"));
    if (requestToken === sessionToken.value && apiError.code === "PASSWORD_CHANGE_REQUIRED") window.dispatchEvent(new CustomEvent("nexious-password-required"));
    throw apiError;
  }
}
export const api = {
  // 账号
  authStatus: () => request<AuthStatus>("/api/auth/status"),
  emailCode: (email:string) => request<{verificationId:string;retryAfter:number}>("/api/auth/email-code",{method:"POST",body:JSON.stringify({email})}),
  bindEmailCode: (email:string) => request<{verificationId:string;retryAfter:number}>("/api/auth/email/code",{method:"POST",body:JSON.stringify({email})}),
  bindEmail: (value:{email:string;verificationId:string;code:string}) => request<{email:string}>("/api/auth/email",{method:"POST",body:JSON.stringify(value)}),
  captcha: (purpose:"login"|"node-reset",nodeId?:string) => request<{id:string;instruction:string;image:string;width?:number;height?:number;points?:number}>("/api/auth/captcha",{method:"POST",body:JSON.stringify({purpose,nodeId})}),
  verifyCaptcha: (value:{id:string;purpose:"login"|"node-reset";nodeId?:string;points:Array<{x:number;y:number}>}) => request<{ticket:string}>("/api/auth/captcha/verify",{method:"POST",body:JSON.stringify(value)}),
  register: (value:{username:string;password:string;email:string;verificationId:string;code:string;inviteCode?:string}, remember = false) =>
    request<{ token: string; user: AuthUser }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ ...value, remember })
    }),
  login: (username: string, password: string, captchaTicket:string, remember = false) =>
    request<{ token: string; user: AuthUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password, captchaTicket, remember })
    }),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  verifyPassword: (password:string) => request<{ok:boolean}>("/api/auth/verify-password",{method:"POST",body:JSON.stringify({password})}),
  me: () => request<AuthUser & { kind?: string }>("/api/auth/me"),
  changePassword: (currentPassword: string, newPassword: string, remember = false) =>
    request<{ token: string }>("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword, remember })
    }),
  // 账号管理（仅管理员）
  sessions: () => request<LoginSession[]>("/api/auth/sessions"),
  revokeSession: (id: string) => request<void>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  revokeOtherSessions: () => request<void>("/api/auth/sessions/others", { method: "DELETE" }),
  revokeUserSessions: (id: string) => request<void>(`/api/users/${encodeURIComponent(id)}/sessions`, { method: "DELETE" }),
  users: (params: {page?:number;pageSize?:number;search?:string;role?:string;status?:string} = {}) => request<UserPage>(`/api/users?${new URLSearchParams(Object.entries(params).map(([key,value])=>[key,String(value)]))}`),
  createUser: (value: { username: string; password: string; role: "admin" | "user"; quotaTunnels?: number | null }) =>
    request<ManagedUser>("/api/users", { method: "POST", body: JSON.stringify(value) }),
  updateUser: (
    id: string,
    value: { role?: "admin" | "user"; status?: "active" | "disabled"; quotaTunnels?: number | null }
  ) => request<ManagedUser>(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(value) }),
  resetUserPassword: (id: string, newPassword: string) =>
    request<void>(`/api/users/${id}/password`, {
      method: "POST",
      body: JSON.stringify({ newPassword })
    }),
  deleteUser: (id: string) => request<void>(`/api/users/${id}`, { method: "DELETE" }),
  // 配额流水：普通用户固定返回本人，管理员/服务身份不传 userId 返回全量。
  billing: (page = 1, pageSize = 10, userId = "") =>
    request<import("../types").BillingPage>(`/api/billing?${new URLSearchParams({ page: String(page), pageSize: String(pageSize), ...(userId ? { userId } : {}) })}`),
  // 下单：0 元套餐直接开通（status=paid）；付费套餐返回当面付二维码。
  createBillingOrder: (planId: string, requestId: string) =>
    request<import("../types").PaymentOrder & { planName?: string | null; membershipUntil?: string }>("/api/billing/orders", { method: "POST", body: JSON.stringify({ planId, requestId }) }),
  billingOrder: (id: string) => request<import("../types").PaymentOrder>(`/api/billing/orders/${encodeURIComponent(id)}`),
  audit: (page = 1, pageSize = 20, search = "", action = "") =>
    request<AuditLogPage>(`/api/audit?${new URLSearchParams({page:String(page),pageSize:String(pageSize),search,action})}`),
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
  nodeDeployment: (nodeId:string) => request<{jobId:string|null}>(`/api/nodes/${nodeId}/deployment`),
  nodeDetail: (nodeId:string) => request<NodeDetail>(`/api/nodes/${encodeURIComponent(nodeId)}/detail`),
  resetNode: (id:string,password:string,captchaTicket:string) => request<{backupPath:string}>(`/api/nodes/${encodeURIComponent(id)}/reset`,{method:"POST",body:JSON.stringify({password,captchaTicket}),signal:AbortSignal.timeout(180000)}),
  plans: () => request<import("../types").MembershipPlan[]>("/api/membership/plans"),
  savePlan: (value:Omit<import("../types").MembershipPlan,"id">,id?:string) => request<import("../types").MembershipPlan>(`/api/membership/plans${id?`/${id}`:""}`,{method:id?"PUT":"POST",body:JSON.stringify(value)}),
  campaigns: () => request<import("../types").ReferralCampaign[]>("/api/membership/campaigns"),
  saveCampaign: (value:Omit<import("../types").ReferralCampaign,"id">,id?:string) => request<import("../types").ReferralCampaign>(`/api/membership/campaigns${id?`/${id}`:""}`,{method:id?"PUT":"POST",body:JSON.stringify(value)}),
  membership: () => request<import("../types").MembershipStatus>("/api/membership/me"),
  grantMembership: (id:string,planId:string,requestId:string) => request<{expiresAt:string}>(`/api/users/${encodeURIComponent(id)}/membership`,{method:"POST",body:JSON.stringify({planId,requestId})}),
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
    request<{ token: string; tunnelId: string; relay: string; directRelay?: { url: string; address: string } | null }>(
      `/api/tunnels/${id}/token`,
      { method: "POST" }
    ),
  // 测速由控制中心发起：上下行串行采样，最长可达 120s，默认 30s 会在服务端仍在采样时先中断。
  speedTest: (id: string, value: SpeedTestInput) =>
    request<SpeedTestResult>(`/api/tunnels/${id}/speedtest`, {
      method: "POST",
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(150000)
    }),
  logs: (params: {
    tunnelId?: string;
    nodeId?: string;
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
