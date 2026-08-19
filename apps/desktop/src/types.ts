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
}
export type NodeInput = Pick<NodeInfo, "name" | "host" | "status">;
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
