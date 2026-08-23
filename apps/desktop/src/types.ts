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
export interface ServerConnectionInput { connection:string; password:string; port:number }
export interface NodeInspection { configured:boolean; healthy:boolean; token?:string;port?:number;controllerUrl?:string;message:string }
export interface NodeDeployment { alreadyConfigured:boolean; controllerUrl:string; token:string; version:string }
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
  apiToken: string;
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
