import { onScopeDispose, ref } from "vue";
import { isTauri } from "@tauri-apps/api/core";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { useMessage } from "naive-ui";
import { startTunnelAgent, stopTunnelAgent } from "../agentRuntime";
import { api } from "../api/client";
import type { Tunnel, TunnelInput } from "../types";

const native = isTauri();
const MAX_LAUNCH_ATTEMPTS = 5;
const LAUNCH_COOLDOWN_MS = 10_000;

// 守护状态必须是模块级：router-view 没有 keep-alive，页面切换会重建组件实例，
// 放实例级的话每次进入页面对所有 auto_start 隧道重复签发 token，把正在工作的 agent 踢下线。
// pendingLaunch 记录"最近一次发起启动"的时间戳：从发起命令到 agent 真正连上 relay
// 之间有几秒空窗（status 仍是 stopped），冷却窗口内的轮询不得重复发起。
const pendingLaunch = new Map<string, number>();
const launchAttempts = new Map<string, number>();
// 用户显式停止过的隧道，在再次手动启动前不再被自动启动逻辑覆盖。
const suppressed = new Set<string>();
const launchGiveUpWarned = new Set<string>();
// 退出登录后停止守护：否则登出期间的定时刷新会立刻把刚停掉的 auto_start 隧道重新拉起。
// 重新登录（onSignedIn）后恢复，并把上一次会话的失败计数一并清空。
let guardsActive = true;
export function suspendLifecycleGuards() {
  guardsActive = false;
  pendingLaunch.clear();
  launchAttempts.clear();
  launchGiveUpWarned.clear();
  suppressed.clear();
}
export function resumeLifecycleGuards() {
  guardsActive = true;
  pendingLaunch.clear();
  launchAttempts.clear();
  launchGiveUpWarned.clear();
  suppressed.clear();
}

/**
 * 隧道生命周期：启停（含自动启动守护）、删除、编辑抽屉与保存。
 * 隧道管理页与节点详情页共用同一套逻辑，保证守护行为、冷却窗口与提示一致；
 * onSaved / onRemoved / onToggled 供需要额外刷新自身数据的页面接线（如节点详情重拉快照）。
 */
export function useTunnelLifecycle(options: {
  onSaved?: () => void;
  onRemoved?: (tunnel: Tunnel) => void;
  onToggled?: () => void;
} = {}) {
  const message = useMessage(),
    qc = useQueryClient(),
    runningTunnelId = ref<string | null>(null),
    deletingId = ref<string | null>(null),
    editing = ref<Tunnel | null>(null),
    drawer = ref(false);

  const refreshTimers = new Set<number>();
  const scheduleRefresh = (delay: number) => {
    const timer = window.setTimeout(() => {
      refreshTimers.delete(timer);
      refresh();
    }, delay);
    refreshTimers.add(timer);
  };
  onScopeDispose(() => {
    for (const timer of refreshTimers) window.clearTimeout(timer);
    refreshTimers.clear();
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["tunnels"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };

  // 启停语义只看当前状态：掉线（stopped）但配了自动启动的隧道必须允许手动拉起。
  // 之前把 auto_start 也算进"已启用"，会导致点"启动"实际执行停止，并把服务端的
  // 自动启动配置一并清零。
  const isRunning = (tunnel: Tunnel) => tunnel.status === "running";
  // 列表状态列的真实语义：running 之外区分「连接中」（auto_start 正常重试）、
  // 「已暂停」（连续失败后放弃自动重连）与「已停止」（未启用自动启动或被手动停止）。
  const tunnelState = (
    tunnel: Tunnel
  ): { label: string; type: "success" | "warning" | "error" | "default" } => {
    if (tunnel.status === "running") return { label: "运行中", type: "success" };
    if (tunnel.auto_start && !suppressed.has(tunnel.id)) {
      if ((launchAttempts.get(tunnel.id) || 0) >= MAX_LAUNCH_ATTEMPTS)
        return { label: "已暂停", type: "error" };
      return { label: "连接中", type: "warning" };
    }
    return { label: "已停止", type: "default" };
  };
  // auto_start 隧道是否仍在守护重试中（「连接中」）：禅模式据此区分 pending 与 idle。
  const isGuardPending = (tunnel: Tunnel) =>
    Boolean(tunnel.auto_start) &&
    !suppressed.has(tunnel.id) &&
    (launchAttempts.get(tunnel.id) || 0) < MAX_LAUNCH_ATTEMPTS;

  // 启停是"按钮必须立刻有反馈"的操作：agent 一旦成功，就直接写入查询缓存，
  // 不再只依赖延迟刷新；随后的 refresh 会用服务端真实数据校准。
  function patchTunnelState(id: string, status: Tunnel["status"]) {
    qc.setQueryData<Tunnel[]>(["tunnels"], (rows) =>
      rows
        ? rows.map((row) =>
            row.id === id
              ? { ...row, status, auto_start: status === "running" ? 1 : 0 }
              : row
          )
        : rows
    );
  }
  const run = useMutation({
    mutationFn: async (tunnel: Tunnel) => {
      runningTunnelId.value = tunnel.id;
      if (isRunning(tunnel)) {
        await stopTunnelAgent(tunnel);
        patchTunnelState(tunnel.id, "stopped");
        launchAttempts.delete(tunnel.id);
        launchGiveUpWarned.delete(tunnel.id);
        pendingLaunch.delete(tunnel.id);
        suppressed.add(tunnel.id);
      } else {
        // 与自动启动共用冷却窗口：手动启动的 token 签发期间，轮询不得再并发发起。
        pendingLaunch.set(tunnel.id, Date.now());
        await startTunnelAgent(tunnel);
        patchTunnelState(tunnel.id, "running");
        launchAttempts.delete(tunnel.id);
        launchGiveUpWarned.delete(tunnel.id);
        suppressed.delete(tunnel.id);
      }
    },
    onSuccess: (_, tunnel) => {
      message.success(isRunning(tunnel) ? "隧道已停止" : "隧道正在连接");
      scheduleRefresh(1200);
      options.onToggled?.();
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : "Agent 操作失败");
      // 失败时以服务端状态为准，避免本地乐观值与实际不一致。
      refresh();
    },
    onSettled: () => {
      runningTunnelId.value = null;
    }
  });
  const remove = useMutation({
    mutationFn: async (tunnel: Tunnel) => {
      deletingId.value = tunnel.id;
      await stopTunnelAgent(tunnel).catch(() => undefined);
      return api.deleteTunnel(tunnel.id);
    },
    onSuccess: (_, tunnel) => {
      pendingLaunch.delete(tunnel.id);
      launchAttempts.delete(tunnel.id);
      launchGiveUpWarned.delete(tunnel.id);
      suppressed.delete(tunnel.id);
      message.success("隧道已删除");
      refresh();
      options.onRemoved?.(tunnel);
    },
    onError: (error) => message.error(error.message),
    onSettled: () => {
      deletingId.value = null;
    }
  });
  const save = useMutation({
    mutationFn: (value: TunnelInput) =>
      editing.value
        ? api.updateTunnel(editing.value.id, value)
        : api.createTunnel(value),
    onSuccess: () => {
      message.success(editing.value ? "隧道已更新" : "隧道已创建");
      // 配置刚被修改，旧的失败计数、冷却与放弃提示不再适用：
      // 自动启动逻辑可以立即按新配置重试（auto_start 仍开启时）。
      if (editing.value) {
        launchAttempts.delete(editing.value.id);
        launchGiveUpWarned.delete(editing.value.id);
        pendingLaunch.delete(editing.value.id);
      }
      drawer.value = false;
      refresh();
      options.onSaved?.();
    },
    onError: (error) => message.error(error.message)
  });
  function open(tunnel: Tunnel | null = null) {
    editing.value = tunnel;
    drawer.value = true;
  }

  // 自动启动守护：tunnels 数据每次更新时调用（各视图在自己的 watch 里接线）。
  function guardAutoStart(rows: Tunnel[] | undefined) {
    if (!guardsActive) return;
    for (const tunnel of rows || []) {
      if (!native) continue;
      // status==='running' 说明 agent 已连上：不要再签发新 token，否则正在工作的 agent 会掉线。
      // 其余情况（含 agent 崩溃掉线后服务端置 stopped、auto_start 仍在）都允许重试——
      // 这就是运行中崩溃后的自动守护。
      if (!tunnel.auto_start || tunnel.status === "running") continue;
      if (suppressed.has(tunnel.id)) continue;
      const attempts = launchAttempts.get(tunnel.id) || 0;
      if (attempts >= MAX_LAUNCH_ATTEMPTS) {
        // 放弃自动重连必须有提示，否则用户修好本地服务后只会无限等待。
        if (!launchGiveUpWarned.has(tunnel.id)) {
          launchGiveUpWarned.add(tunnel.id);
          message.warning(
            `"${tunnel.name}"连续 ${attempts} 次自动启动失败，已暂停自动重连；请检查本地服务后手动启动`
          );
        }
        continue;
      }
      // 冷却窗口内（含刚手动发起）不重复发起，避免签发新 token 踢掉正在握手的 agent。
      if (Date.now() - (pendingLaunch.get(tunnel.id) || 0) < LAUNCH_COOLDOWN_MS)
        continue;
      pendingLaunch.set(tunnel.id, Date.now());
      launchAttempts.set(tunnel.id, attempts + 1);
      startTunnelAgent(tunnel)
        .then(() => {
          // 命令成功不代表已连上（agent 还要连 relay），保持冷却直到状态收敛为 running。
          launchAttempts.delete(tunnel.id);
          launchGiveUpWarned.delete(tunnel.id);
          scheduleRefresh(1000);
        })
        .catch((error) => {
          const failed = launchAttempts.get(tunnel.id) || 1;
          message.error(
            `"${tunnel.name}"自动启动失败（第 ${failed} 次）：${error instanceof Error ? error.message : "未知错误"}`
          );
        });
    }
  }

  return {
    native,
    message,
    refresh,
    scheduleRefresh,
    runningTunnelId,
    deletingId,
    editing,
    drawer,
    open,
    save,
    run,
    remove,
    isRunning,
    tunnelState,
    isGuardPending,
    guardAutoStart
  };
}
