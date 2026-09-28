export interface Tunnel {
  id: string;
  name: string;
  protocol: "http" | "https";
  local_host: string;
  local_port: number;
  remote_port: number;
  node_id: string;
  node_name: string;
  node_host: string;
  status: "running" | "stopped";
  auto_start: 0 | 1;
  domain: string | null;
  access_url: string | null;
  created_at: string;
}
export interface NodeInfo {
  id: string;
  name: string;
  host: string;
  status: "online" | "maintenance";
  server_host: string | null;
  ssh_user: string | null;
  ssh_port: number;
  controller_url: string | null;
  controller_token: string | null;
  deploy_status: "unconfigured" | "deploying" | "ready" | "error";
  last_checked_at: string | null;
  last_error: string | null;
}
export type NodeInput = Pick<NodeInfo, "name" | "host">;
export interface NodeParameters {
  role: "edge" | "controller";
  port: number; bindHost: string; publicHost: string; database: string;
  logRetentionDays: number; trafficRetentionDays: number;
  maxBodyMb: number; maxWebSocketMb: number; trustProxyHeaders: boolean; nodeVersion: string;
}
export interface NodeDetail {
  node: NodeInfo;
  tunnels: Tunnel[];
  // bytes 为 null 表示字节数无法确认（节点版本过旧），界面应显示“—”而不是 0。
  totals: { requests: number; bytes: number | null };
  parameters: NodeParameters | null;
  nodeTunnelIds: string[] | null;
  syncDrift: { missing: string[]; extra: string[] } | null;
  activeJobId: string | null;
}
export interface ServerConnectionInput { connection:string; password:string; port:number }
export interface NodeInspection { configured:boolean; healthy:boolean; token?:string;port?:number;controllerUrl?:string;message:string }
export interface TunnelSyncSummary { total:number; success:number; failed:number; errors:Array<{tunnelId:string;message:string}> }
export interface NodeDeployment { alreadyConfigured:boolean; controllerUrl:string; token:string; version:string; sync?:TunnelSyncSummary; transport?:"http"|"https";relayVerified?:boolean;backupPath?:string }
export interface DeploymentJob { jobId:string;status:"running"|"success"|"error";logs:Array<{time:string;message:string}>;cursor:number;result?:NodeDeployment;error?:string }
export interface TrafficPoint {
  timestamp: string;
  inbound: number;
  outbound: number;
}
export interface Dashboard {
  tunnels: Tunnel[];
  totals: { inbound: number; outbound: number };
  series: TrafficPoint[];
  onlineNodes: number;
  activeTunnels: number;
}
export interface AccessLog {
  id: number;
  tunnel_id: string;
  timestamp: string;
  client_ip: string;
  method: string;
  path: string;
  // 服务端补全的完整访问地址；旧节点/无域名时可能缺失。
  access_url?: string;
  status: number;
  duration: number;
  bytes: number;
}
export interface AccessLogPage {
  items: AccessLog[];
  total: number;
  page: number;
  pageSize: number;
}
export interface Preferences {
  autoStart: boolean;
  minimizeToTray: boolean;
  apiUrl: string;
  maxBodyMb: number;
  logRetentionDays: number;
  trafficRetentionDays: number;
  // 偏好结构版本（桌面端内部使用）：≥3 表示当前版本配置，加载时不再做默认地址迁移。
  schemaVersion?: number;
}
export interface TunnelInput {
  name: string;
  protocol: Tunnel["protocol"];
  localHost: string;
  localPort: number;
  remotePort: number;
  nodeId: string;
  domain: string | null;
}
/** 单次测速的一条方向结果：速率按传输窗口折算，窗口已扣除首字节等待。 */
export interface SpeedSample {
  bytes: number;
  elapsedMs: number;
  mbps: number;
  ttfbMs: number | null;
  status: number;
  truncated: boolean;
}
export interface SpeedTestResult {
  url: string;
  path: string;
  sizeBytes: number;
  download?: SpeedSample;
  upload?: SpeedSample;
}
export interface SpeedTestInput {
  path: string;
  sizeMb: number;
  direction: "both" | "down" | "up";
}

/* ── 账号与权限 ─────────────────────────────────────────────────────── */

export type Role = "admin" | "user";

export interface AuthUser {
  id: string;
  username: string;
  email?: string | null;
  role: Role;
  status?: "active" | "disabled";
  mustChangePassword: boolean;
  quotaTunnels?: number | null;
  createdAt?: string;
  lastLoginAt?: string | null;
  tunnelCount?: number;
  effectiveQuota?: number | null;
}

export interface AuthStatus {
  registrationEnabled: boolean;
  passwordMinLength: number;
  passwordMaxLength: number;
}

export interface ManagedUser extends AuthUser {
  tunnelCount?: number;
}
export interface UserPage {
  items: ManagedUser[];
  total: number;
  page: number;
  pageSize: number;
  summary: {total:number;active:number;admins:number};
}
export interface LoginSession {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
  current: boolean;
}

export interface AuditLog {
  id: number;
  actor_name: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: string | null;
  ip: string | null;
  created_at: string;
}

export interface AuditLogPage {
  items: AuditLog[];
  total: number;
  page: number;
  pageSize: number;
}
export interface MembershipPlan {id:string;name:string;description:string;priceCents:number;durationDays:number;tunnelQuota:number;enabled:boolean}
export interface ReferralCampaign {id:string;name:string;inviterBonus:number;inviteeBonus:number;maxRewards:number;startsAt:string;endsAt:string;enabled:boolean}
export interface MembershipStatus {email:string|null;planName:string|null;membershipUntil:string|null;membershipActive:boolean;effectiveQuota:number|null;bonusTunnels:number;inviteCode:string;invitedCount:number;rewardedCount:number}
// 配额流水：所有使用户有效配额变化的事件（购买/管理员开通/到期/邀请/管理员调整）。
export type BillingRecordType = "plan_purchase"|"plan_grant"|"plan_expired"|"invite_reward"|"admin_adjust";
export interface BillingRecord {id:string;userId:string;username:string|null;type:BillingRecordType;delta:number;quotaAfter:number;description:string;operatorName:string|null;ref:string|null;createdAt:string}
export interface BillingPage {items:BillingRecord[];total:number;page:number;pageSize:number}
// 支付宝套餐订单：id 即商户订单号，qrCode 为当面付二维码内容。
export interface PaymentOrder {id:string;planId:string;amountCents:number;status:"created"|"paid"|"expired";qrCode:string|null;createdAt:string;paidAt:string|null}
