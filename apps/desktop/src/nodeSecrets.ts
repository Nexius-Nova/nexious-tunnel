import { invoke, isTauri } from "@tauri-apps/api/core";

// 桌面端把节点 SSH 密码加密保存在本机（DPAPI 绑定当前用户）；浏览器调试环境
// 没有可用的安全存储，退化为仅当前页面内存缓存。
const memory = new Map<string, string>();
// 保存是“读-改-写”整份凭据文件，串行执行避免多个节点同时保存时互相覆盖。
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
}

export async function loadNodePassword(nodeId: string): Promise<string> {
  if (memory.has(nodeId)) return memory.get(nodeId) || "";
  if (!isTauri()) return "";
  try {
    const value = await invoke<string | null>("get_node_password", { nodeId });
    if (value) memory.set(nodeId, value);
    return value || "";
  } catch {
    // 凭据不可用时仍允许手动输入，不打断部署流程。
    return "";
  }
}

export function rememberNodePassword(nodeId: string, password: string): Promise<void> {
  if (!nodeId || !password) return Promise.resolve();
  memory.set(nodeId, password);
  if (!isTauri()) return Promise.resolve();
  return serialize(async () => {
    try { await invoke("save_node_password", { nodeId, password }); } catch { /* 保存失败不影响本次部署 */ }
  });
}

export function forgetNodePassword(nodeId: string): Promise<void> {
  memory.delete(nodeId);
  if (!isTauri()) return Promise.resolve();
  return serialize(async () => {
    try { await invoke("clear_node_password", { nodeId }); } catch { /* 忽略清理失败 */ }
  });
}
