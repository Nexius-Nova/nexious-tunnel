<script setup lang="ts">
import { computed, h, onBeforeUnmount, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import {
  NButton,
  NDataTable,
  NInput,
  NPopconfirm,
  NSelect,
  NTag,
  NTooltip,
  type DataTableColumns
} from "naive-ui";
import {
  ArrowLeftRight,
  Copy,
  Focus,
  Gauge,
  Pencil,
  Play,
  Plus,
  Power,
  Search,
  Trash2
} from "lucide-vue-next";
import { api } from "../api/client";
import { useTunnelLifecycle } from "../composables/useTunnelLifecycle";
import type { Tunnel } from "../types";
import PageHeader from "../components/PageHeader.vue";
import StateBlock from "../components/StateBlock.vue";
import TunnelDrawer from "../components/TunnelDrawer.vue";
import TunnelSpeedResult, { type SpeedTestState } from "../components/TunnelSpeedResult.vue";
import FlowCanvas from "../components/FlowCanvas.vue";

// 隧道生命周期（启停/删除/编辑抽屉/自动启动守护）抽为共享逻辑，与节点详情页复用
const {
  native, message, runningTunnelId, deletingId, editing, drawer,
  open, save, run, remove, isRunning, tunnelState, isGuardPending, guardAutoStart
} = useTunnelLifecycle({
  // 删除隧道后其行内测速结果一并清理
  onRemoved: (tunnel) => {
    delete speedStates.value[tunnel.id];
  }
});
const search = ref(""),
  // 行内测速状态（按隧道 id 索引）：点击图标直接测速，不再弹窗
  speedStates = ref<Record<string, SpeedTestState>>({});
const mode = ref<"list" | "zen">(
    localStorage.getItem("nexious-tunnel-mode") === "list" ? "list" : "zen"
  ),
  selectedTunnelId = ref(localStorage.getItem("nexious-zen-tunnel") || "");
const tunnels = useQuery({
    queryKey: ["tunnels"],
    queryFn: api.tunnels,
    refetchInterval: 5000
  }),
  nodes = useQuery({ queryKey: ["nodes"], queryFn: api.nodes });
// 连接建立时播放一次扩散波，让「刚连上」有明确的一次性视觉反馈。
const zenBurst = ref(false);
let burstTimer: number | undefined;
let burstFrame: number | undefined;
onBeforeUnmount(() => {
  if (burstTimer) window.clearTimeout(burstTimer);
  if (burstFrame) window.cancelAnimationFrame(burstFrame);
  if (stageFrame) window.cancelAnimationFrame(stageFrame);
  if (speedTimer) window.clearInterval(speedTimer);
});
// 测速要经公网域名打到 agent 背后的本地服务，因此「无域名」与「未运行」都必须先拦掉，
// 否则测得的是中继的错误页而不是隧道吞吐。
const canSpeedTest = (tunnel: Tunnel) =>
  tunnel.status === "running" && Boolean(tunnel.access_url);
const tunnelOptions = computed(
  () =>
    tunnels.data.value?.map((tunnel) => ({
      label: tunnel.name,
      value: tunnel.id
    })) || []
);
const selectedTunnel = computed(
  () =>
    tunnels.data.value?.find(
      (tunnel) => tunnel.id === selectedTunnelId.value
    ) ||
    tunnels.data.value?.[0] ||
    null
);
function setMode(value: "list" | "zen") {
  mode.value = value;
  localStorage.setItem("nexious-tunnel-mode", value);
}
// 禅模式下三种视觉状态：运行中、连接中、已停止。
const zenStatus = computed<"running" | "pending" | "idle">(() => {
  const tunnel = selectedTunnel.value;
  if (!tunnel) return "idle";
  if (tunnel.status === "running") return "running";
  // 手动停止过（suppressed）或自动重连已达上限的隧道不会再真正发起连接，
  // 一并归入 idle，避免星空与圆环呈现"正在连接"的假象。
  return isGuardPending(tunnel) ? "pending" : "idle";
});
// 禅模式的鼠标交互：核心随指针做轻微 3D 倾斜，舞台光晕跟随指针。
// 用 CSS 变量驱动，避免逐帧触发 Vue 更新。
const zenStage = ref<HTMLElement | null>(null);
// 禅模式的行内测速状态（与表格共用同一份 speedStates）
const zenSpeedState = computed(() =>
  selectedTunnel.value ? speedStates.value[selectedTunnel.value.id] : undefined
);
const zenSpeedTesting = computed(() => zenSpeedState.value?.status === "testing");
let stageFrame = 0;
let stageTarget = { x: 0, y: 0 };
const stageCurrent = { x: 0, y: 0 };

function applyStagePointer() {
  const el = zenStage.value;
  if (!el) return;
  // 平滑插值，让倾斜有惯性而不是硬跟随
  stageCurrent.x += (stageTarget.x - stageCurrent.x) * 0.14;
  stageCurrent.y += (stageTarget.y - stageCurrent.y) * 0.14;
  el.style.setProperty("--zen-px", stageCurrent.x.toFixed(4));
  el.style.setProperty("--zen-py", stageCurrent.y.toFixed(4));
  const settled =
    Math.abs(stageTarget.x - stageCurrent.x) < 0.0015 &&
    Math.abs(stageTarget.y - stageCurrent.y) < 0.0015;
  if (settled) {
    stageFrame = 0;
    return;
  }
  stageFrame = window.requestAnimationFrame(applyStagePointer);
}

function onZenPointerMove(event: PointerEvent) {
  const el = zenStage.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  // 归一化到 -1..1（相对舞台中心）
  stageTarget = {
    x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
    y: ((event.clientY - rect.top) / rect.height) * 2 - 1
  };
  if (!stageFrame) stageFrame = window.requestAnimationFrame(applyStagePointer);
}

function onZenPointerLeave() {
  stageTarget = { x: 0, y: 0 };
  if (!stageFrame) stageFrame = window.requestAnimationFrame(applyStagePointer);
}

watch(
  () => selectedTunnel.value?.status,
  (status, previous) => {
    if (status !== "running" || !previous || previous === "running") return;
    // 先复位再于下一帧打开，确保同一个元素能重新触发一次性动画。
    zenBurst.value = false;
    if (burstFrame) window.cancelAnimationFrame(burstFrame);
    burstFrame = window.requestAnimationFrame(() => {
      zenBurst.value = true;
      if (burstTimer) window.clearTimeout(burstTimer);
      burstTimer = window.setTimeout(() => {
        zenBurst.value = false;
      }, 1500);
    });
  }
);
function copyUrl(text: string) {
  navigator.clipboard.writeText(text).then(
    () => message.success("已复制到剪贴板"),
    () => message.error("复制失败")
  );
}

watch(
  () => tunnels.data.value,
  (rows) => {
    if (
      rows?.length &&
      !rows.some((tunnel) => tunnel.id === selectedTunnelId.value)
    ) {
      selectedTunnelId.value = rows[0].id;
    }
    // 自动启动守护（冷却窗口、失败计数与放弃提示）由共享生命周期逻辑处理
    guardAutoStart(rows);
  },
  { immediate: true }
);
watch(
  selectedTunnelId,
  (value) => value && localStorage.setItem("nexious-zen-tunnel", value)
);

// 点击即测（仿大模型测速）：固定首页路径 + 8MB 双向，结果行内展示。
// 同一条隧道测速期间不重复发起；最长可达 120s，用计时器让「测速中」显示已用时。
let speedTimer: number | undefined;
const speedClock = () => {
  if (speedTimer !== undefined) return;
  speedTimer = window.setInterval(() => {
    let testing = false;
    for (const state of Object.values(speedStates.value)) {
      if (state.status === "testing") {
        state.elapsed = Date.now() - state.startedAt;
        testing = true;
      }
    }
    // 没有进行中的测速就停表，避免空转
    if (!testing && speedTimer !== undefined) {
      window.clearInterval(speedTimer);
      speedTimer = undefined;
    }
  }, 500);
};
async function runSpeedTest(tunnel: Tunnel) {
  if (!canSpeedTest(tunnel)) return;
  if (speedStates.value[tunnel.id]?.status === "testing") return;
  const startedAt = Date.now();
  speedStates.value[tunnel.id] = { status: "testing", startedAt, elapsed: 0 };
  speedClock();
  try {
    const result = await api.speedTest(tunnel.id, {
      path: "/",
      sizeMb: 8,
      direction: "both"
    });
    speedStates.value[tunnel.id] = {
      status: "done",
      startedAt,
      elapsed: Date.now() - startedAt,
      result
    };
  } catch (value) {
    speedStates.value[tunnel.id] = {
      status: "error",
      startedAt,
      elapsed: Date.now() - startedAt,
      error: value instanceof Error ? value.message : String(value)
    };
  }
}
const filtered = computed(
  () =>
    tunnels.data.value?.filter((tunnel) =>
      `${tunnel.name}${tunnel.local_host}${tunnel.domain}`
        .toLowerCase()
        .includes(search.value.toLowerCase())
    ) || []
);

const extractDomain = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0];
  }
};

const columns: DataTableColumns<Tunnel> = [
  {
    title: "隧道",
    key: "name",
    render: (tunnel) =>
      h("div", { class: "tunnel-name" }, [
        h("div", [
          h("b", tunnel.name),
          h(
            "span",
            tunnel.access_url ? extractDomain(tunnel.access_url) : "等待分配"
          )
        ])
      ])
  },
  {
    title: "协议",
    key: "protocol",
    width: 80,
    render: (tunnel) =>
      h(
        NTag,
        { size: "small", bordered: false },
        { default: () => tunnel.protocol.toUpperCase() }
      )
  },
  {
    title: "本地端口",
    key: "local",
    width: 90,
    render: (tunnel) => h("code", String(tunnel.local_port))
  },
  {
    title: "域名",
    key: "domain",
    render: (tunnel) => {
      const domain = tunnel.access_url ? extractDomain(tunnel.access_url) : "";
      return h("div", { class: "domain-cell" }, [
        h("div", { class: "domain-line" }, [
          domain ? h("code", domain) : h("span", { class: "text-muted" }, "—"),
          domain
            ? h(
                NTooltip,
                {},
                {
                  trigger: () =>
                    h(
                      NButton,
                      {
                        quaternary: true,
                        circle: true,
                        size: "tiny",
                        class: "copy-btn",
                        onClick: () => copyUrl(tunnel.access_url!)
                      },
                      { icon: () => h(Copy, { size: 13 }) }
                    ),
                  default: () => "复制地址"
                }
              )
            : null
        ]),
        // 点击即测的行内结果：进行中/速率/失败都展示在域名下方
        h(TunnelSpeedResult, { state: speedStates.value[tunnel.id] })
      ]);
    }
  },
  {
    title: "状态",
    key: "status",
    width: 100,
    render: (tunnel) => {
      const state = tunnelState(tunnel);
      return h(
        NTag,
        { size: "small", bordered: false, type: state.type },
        { default: () => state.label }
      );
    }
  },
  {
    title: "",
    key: "actions",
    width: 140,
    align: "right",
    render: (tunnel) =>
      h("div", { class: "row-actions" }, [
        h(
          NTooltip,
          {},
          {
            trigger: () =>
              h(
                NButton,
                {
                  quaternary: true,
                  circle: true,
                  size: "small",
                  class: isRunning(tunnel) ? "btn-stop" : "btn-start",
                  loading: runningTunnelId.value === tunnel.id,
                  // 只锁定正在操作的这一行，其余隧道的启停不受影响
                  disabled: !native || runningTunnelId.value === tunnel.id,
                  "aria-label": (isRunning(tunnel) ? "停止" : "启动") + tunnel.name,
                  onClick: () => run.mutate(tunnel)
                },
                {
                  icon: () => h(isRunning(tunnel) ? Power : Play, { size: 16 })
                }
              ),
            default: () => !native ? "请在桌面客户端中运行本机隧道" : (isRunning(tunnel) ? "停止" : "启动")
          }
        ),
        h(
          NTooltip,
          {},
          {
            trigger: () =>
              h(
                NButton,
                {
                  quaternary: true,
                  circle: true,
                  size: "small",
                  class: "btn-speed",
                  // 测速期间锁定本行按钮并显示旋转态
                  loading: speedStates.value[tunnel.id]?.status === "testing",
                  disabled:
                    !canSpeedTest(tunnel) ||
                    speedStates.value[tunnel.id]?.status === "testing",
                  "aria-label": `测速${tunnel.name}`,
                  onClick: () => runSpeedTest(tunnel)
                },
                { icon: () => h(Gauge, { size: 15 }) }
              ),
            default: () =>
              canSpeedTest(tunnel) ? "点击直接测速" : "隧道未运行或未分配域名，无法测速"
          }
        ),
        h(
          NTooltip,
          {},
          {
            trigger: () =>
              h(
                NButton,
                {
                  quaternary: true,
                  circle: true,
                  size: "small",
                  class: "btn-edit",
                  onClick: () => open(tunnel)
                },
                { icon: () => h(Pencil, { size: 15 }) }
              ),
            default: () => "编辑"
          }
        ),
        h(
          NTooltip,
          {},
          {
            trigger: () =>
              h(
                NPopconfirm,
                { onPositiveClick: () => remove.mutate(tunnel) },
                {
                  trigger: () =>
                    h(
                      NButton,
                      {
                        quaternary: true,
                        circle: true,
                        size: "small",
                        class: "btn-delete",
                        loading: deletingId.value === tunnel.id,
                        disabled: deletingId.value === tunnel.id
                      },
                      { icon: () => h(Trash2, { size: 15 }) }
                    ),
                  default: () => `确认删除隧道"${tunnel.name}"？`
                }
              ),
            default: () => "删除"
          }
        )
      ])
  }
];
</script>

<template>
  <div class="view tunnel-view" :class="{ 'zen-view': mode === 'zen' }">
    <!-- 极光云雾铺满整个禅模式页面（含标题区），作为沉浸式背景 -->
    <FlowCanvas
      v-if="mode === 'zen' && selectedTunnel"
      class="zen-flow"
      :state="zenStatus"
    />
    <!-- 禅模式头部：左上角是视图切换角标（仅图标）；隧道选择器在右侧 -->
    <header v-if="mode === 'zen'" class="page-header zen-head">
      <div class="zen-head-left">
        <n-tooltip>
          <template #trigger>
            <button
              type="button"
              class="zen-switch"
              aria-label="切换到列表视图"
              @click="setMode('list')"
            >
              <ArrowLeftRight :size="15" />
            </button>
          </template>
          切换到列表视图
        </n-tooltip>
        <div>
          <h1>禅模式</h1>
          <p>一次只关注一条连接。</p>
        </div>
      </div>
      <div v-if="tunnelOptions.length" class="header-actions">
        <n-select
          v-model:value="selectedTunnelId"
          :options="tunnelOptions"
          size="small"
          class="zen-select"
        />
      </div>
    </header>
    <PageHeader
      v-else
      title="隧道管理"
      description="配置、发布并监控你的本地服务。"
    >
      <n-button @click="setMode('zen')"
        ><template #icon><Focus /></template>禅</n-button
      >
      <n-button type="primary" @click="open()"
        ><template #icon><Plus /></template>新建</n-button
      >
    </PageHeader>
    <StateBlock
      v-if="
        tunnels.isLoading.value ||
        tunnels.error.value ||
        !tunnels.data.value?.length
      "
      :loading="tunnels.isLoading.value"
      :error="tunnels.error.value?.message"
      :empty="
        !tunnels.isLoading.value &&
        !tunnels.error.value &&
        !tunnels.data.value?.length
      "
    />
    <template v-else-if="mode === 'zen' && selectedTunnel">
      <section class="zen-console" :class="zenStatus">
        <div
          ref="zenStage"
          class="zen-stage"
          :class="zenStatus"
          @pointermove="onZenPointerMove"
          @pointerleave="onZenPointerLeave"
        >
          <div class="zen-core">
            <div
              class="zen-rings"
              :class="[zenStatus, { burst: zenBurst }]"
            >
              <span class="zen-ripple" aria-hidden="true"></span>
              <span class="zen-ripple zen-ripple-b" aria-hidden="true"></span>
              <span class="zen-ripple-c" aria-hidden="true"></span>
              <span class="zen-burst" aria-hidden="true"></span>
              <button
                class="zen-power"
                :class="{ active: isRunning(selectedTunnel) }"
                :disabled="!native || runningTunnelId === selectedTunnel.id"
                :title="!native ? '请在桌面客户端中运行本机隧道' : undefined"
                :aria-label="isRunning(selectedTunnel) ? '停止隧道' : '启动隧道'"
                @click="run.mutate(selectedTunnel)"
              >
                <!-- 启动后从按钮向外扩散的波纹 -->
                <span class="zen-pulse" aria-hidden="true"></span>
                <span class="zen-pulse zen-pulse-b" aria-hidden="true"></span>
                <span class="zen-pulse zen-pulse-c" aria-hidden="true"></span>
                <Power /><span
                  v-if="runningTunnelId === selectedTunnel.id"
                  class="zen-spinner"
                ></span>
              </button>
            </div>
            <!-- 按钮下方只保留公网域名链接 -->
            <div class="zen-target" :key="selectedTunnel.id">
              <button
                v-if="selectedTunnel.access_url"
                type="button"
                class="zen-domain"
                :title="`点击复制 ${selectedTunnel.access_url}`"
                @click="copyUrl(selectedTunnel.access_url)"
              >
                <span>{{ extractDomain(selectedTunnel.access_url) }}</span>
                <Copy :size="13" />
              </button>
              <span v-else class="zen-domain zen-domain-empty">等待分配域名</span>
              <button
                type="button"
                class="zen-speed"
                :class="{ testing: zenSpeedTesting }"
                :disabled="!canSpeedTest(selectedTunnel) || zenSpeedTesting"
                :title="canSpeedTest(selectedTunnel) ? '点击直接测速' : '隧道未运行或未分配域名，无法测速'"
                @click="runSpeedTest(selectedTunnel)"
              >
                <Gauge :size="14" />{{ zenSpeedTesting ? "测速中" : "测速" }}
              </button>
              <!-- 点击即测的行内结果 -->
              <TunnelSpeedResult v-if="zenSpeedState" :state="zenSpeedState" />
            </div>
          </div>
        </div>
      </section>
    </template>
    <template v-else>
      <div class="toolbar">
        <n-input
          v-model:value="search"
          clearable
          placeholder="搜索名称或域名"
          ><template #prefix><Search :size="15" /></template></n-input
        ><span>{{ filtered.length }} 条隧道</span>
      </div>
      <StateBlock v-if="!filtered.length" empty>
        <template v-if="search">
          <p>没有匹配 "{{ search }}" 的隧道</p>
          <n-button size="small" @click="search = ''">清空搜索</n-button>
        </template>
      </StateBlock>
      <div v-else class="table-panel table-inset">
        <n-data-table
          :columns="columns"
          :data="filtered"
          :scroll-x="700"
          :bordered="false"
        />
      </div>
    </template>
    <TunnelDrawer
      :show="drawer"
      :tunnel="editing"
      :nodes="nodes.data.value || []"
      :tunnels="tunnels.data.value || []"
      :loading="save.isPending.value"
      @close="drawer = false"
      @submit="save.mutate"
    />
  </div>
</template>
<style scoped>
.row-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.row-actions .btn-start {
  color: var(--accent);
}
.row-actions .btn-start:hover {
  color: var(--accent-hover);
}
.row-actions .btn-stop {
  color: var(--amber);
}
.row-actions .btn-stop:hover {
  color: #e5a23d;
}
.row-actions .btn-edit {
  color: var(--blue);
}
.row-actions .btn-edit:hover {
  color: #4fa8f0;
}
/* 测速用青绿色，与启动（绿）、停止（琥珀）、编辑（蓝）区分开 */
.row-actions .btn-speed {
  color: #3fd0c9;
}
.row-actions .btn-speed:hover:not(:disabled) {
  color: #56e0d8;
}
.row-actions .btn-delete {
  color: #e57373;
}
.row-actions .btn-delete:hover {
  color: #ef5350;
}
.domain-cell {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-width: 0;
}
.domain-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
}
.domain-line code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.domain-line .text-muted {
  color: #5f6965;
  font-size: 12px;
}
.copy-btn {
  color: #77817d !important;
  flex: none;
}
.copy-btn:hover {
  color: var(--accent) !important;
}
/* ══ 禅模式：整页星空 + 环绕式布局 ══ */
/* 根节点建立定位上下文，让星空铺满整个页面（含标题区与内边距）。
   flex 纵向布局让主控台自动撑满标题区以下的剩余空间，不再依赖
   "视口高度 - 头部实测高度"的魔法数。
   高度不能用 .view 的 min-height:100%——n-layout 内层高度不是确定值，
   100% 会退化为内容高度，底部露出一条星空盖不到的空白，因此直接
   用视口高度减去固定的 36px 标题栏。 */
.tunnel-view.zen-view {
  position: relative;
  max-width: none;
  padding: 0;
  overflow: hidden;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  min-height: calc(100dvh - 36px);
}
.zen-flow {
  z-index: 0;
}
/* 标题区与主控台浮在极光之上 */
.zen-view .page-header {
  position: relative;
  z-index: 1;
  padding: 36px 40px 0;
  max-width: 1500px;
}
/* 淡化页面文字：极光是主角，文字退居为低对比度的注解层 */
.zen-view .page-header h1 {
  color: rgba(230, 233, 236, 0.72);
  font-weight: 600;
  letter-spacing: 0.01em;
}
.zen-view .page-header p {
  color: rgba(200, 206, 210, 0.45);
  font-size: 12px;
}
.zen-console {
  position: relative;
  z-index: 1;
  /* 撑满标题区以下的剩余高度（.zen-stage 内部再 flex:1 贴底） */
  flex: 1;
  /* 与标题区一样居中并保留 40px 侧边距 */
  width: min(1500px, calc(100% - 80px));
  margin: 0 auto 40px;
  display: flex;
  flex-direction: column;
  background: transparent;
  border: 0;
  animation: zenConsoleIn 0.7s cubic-bezier(0.2, 0.8, 0.3, 1) both;
}
@keyframes zenConsoleIn {
  from {
    opacity: 0;
    transform: translateY(16px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
/* 禅模式头部：左侧是视图切换按钮 + 标题，右侧是隧道选择器 */
.zen-head-left {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}
.zen-head-left > div {
  min-width: 0;
}
/* 视图切换角标：纯图标圆形按钮，低对比度，悬停时点亮 */
.zen-switch {
  flex: none;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.03);
  color: rgba(200, 206, 210, 0.6);
  cursor: pointer;
  transition:
    color 0.25s ease,
    border-color 0.25s ease,
    background 0.25s ease,
    transform 0.25s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.zen-switch:hover {
  color: rgba(230, 233, 236, 0.95);
  border-color: rgba(var(--accent-rgb), 0.35);
  background: rgba(var(--accent-rgb), 0.08);
  transform: translateY(-1px);
}
.zen-switch:active {
  transform: translateY(0) scale(0.95);
}
.zen-switch:focus-visible {
  outline: 2px solid rgba(var(--accent-rgb), 0.55);
  outline-offset: 2px;
}
.zen-select {
  width: 208px;
}
.zen-select :deep(.n-base-selection) {
  --n-border: 1px solid rgba(255, 255, 255, 0.06);
  --n-border-hover: 1px solid rgba(var(--accent-rgb), 0.3);
  --n-border-active: 1px solid rgba(var(--accent-rgb), 0.45);
  --n-border-focus: 1px solid rgba(var(--accent-rgb), 0.3);
  --n-color: rgba(255, 255, 255, 0.025);
  --n-color-active: rgba(255, 255, 255, 0.05);
  --n-text-color: rgba(226, 229, 232, 0.75);
  --n-arrow-color: rgba(200, 206, 210, 0.5);
  --n-box-shadow-focus: 0 0 0 2px rgba(var(--accent-rgb), 0.12);
}
/* 舞台：状态核心居中，左右各一项关键信息 */
/* 舞台：核心整体贴向底部（标题已占据顶部空间，靠下更稳、也留出星空）
   底部内边距决定「接近底部」的程度，用 vh 以便随窗口高度自适应。
   指针在舞台上移动时，核心做轻微 3D 倾斜（--zen-px/py 由脚本平滑写入）。
   注意：这里不要用 perspective 建立 3D 渲染上下文 —— 它覆盖在星空画布之上，
   会让合成器在重绘时快照出矩形色块。透视改为内联在 .zen-core 的 transform 里。 */
.zen-stage {
  flex: 1;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  padding: 40px 24px 6vh;
  min-height: 420px;
  --zen-px: 0;
  --zen-py: 0;
}
/* 指针交互由流带画布内部绘制（见 FlowCanvas 的邻近增亮逻辑），
   这里不再叠一层 DOM 渐变：那种"位置由 CSS 变量驱动、每帧重新光栅化"
   的大面积渐变在 WebView2 上会退化成矩形色块。 */
.zen-core {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 透视内联在 transform 里（等价于父级 perspective: 1200px），避免为父级创建
     3D 渲染上下文而在星空画布之上留下矩形重绘块。
     同时不使用 transform-style: preserve-3d / will-change：前者会与子元素
     .zen-power 的合成层冲突，后者会强制提升图层并在鼠标移动时快照出矩形。 */
  transform: perspective(1200px)
    rotateY(calc(var(--zen-px) * 5deg)) rotateX(calc(var(--zen-py) * -5deg));
  transition: transform 0.25s cubic-bezier(0.22, 0.61, 0.36, 1);
  justify-self: center;
}
.zen-rings {
  width: 210px;
  height: 210px;
  border: 1px solid rgba(255, 255, 255, 0.055);
  border-radius: 50%;
  display: grid;
  place-items: center;
  position: relative;
  transition:
    border-color 0.7s ease,
    box-shadow 0.7s ease;
}
.zen-rings:before,
.zen-rings:after {
  content: "";
  position: absolute;
  border: 1px solid rgba(255, 255, 255, 0.035);
  border-radius: 50%;
  pointer-events: none;
  transition: border-color 0.7s ease;
}
.zen-rings:before {
  inset: 20px;
}
.zen-rings:after {
  inset: 40px;
}
/* 扩散环：在线时持续向外扩散；三层错开相位形成连续波纹 */
.zen-ripple {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid rgba(var(--accent-rgb), 0.5);
  opacity: 0;
  pointer-events: none;
}
.zen-ripple-c {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid rgba(var(--accent-rgb), 0.4);
  opacity: 0;
  pointer-events: none;
}
.zen-rings.active .zen-ripple {
  animation: zenRipple 3.6s cubic-bezier(0.22, 0.61, 0.36, 1) infinite;
}
.zen-rings.active .zen-ripple-b {
  animation-delay: 1.2s;
}
.zen-rings.active .zen-ripple-c {
  animation: zenRipple 3.6s cubic-bezier(0.22, 0.61, 0.36, 1) 2.4s infinite;
}
@keyframes zenRipple {
  0% {
    transform: scale(0.82);
    opacity: 0.55;
  }
  70% {
    opacity: 0.1;
  }
  100% {
    transform: scale(1.75);
    opacity: 0;
  }
}
.zen-burst {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid rgba(var(--accent-rgb), 0.75);
  opacity: 0;
  pointer-events: none;
}
.zen-rings.burst .zen-burst {
  animation: zenBurst 1.4s cubic-bezier(0.16, 0.84, 0.44, 1) 1 both;
}
@keyframes zenBurst {
  0% {
    transform: scale(0.6);
    opacity: 0.95;
    border-width: 3px;
  }
  100% {
    transform: scale(2.4);
    opacity: 0;
    border-width: 1px;
  }
}
/* 运行中：三层转动刻度环，为静态圆环加入明显的"运转"感 */
.zen-rings.active:before {
  border-color: transparent;
  border-top-color: rgba(var(--accent-rgb), 0.5);
  border-right-color: rgba(var(--accent-rgb), 0.16);
  animation: zenSpin 6s linear infinite;
}
.zen-rings.active:after {
  border-color: transparent;
  border-bottom-color: rgba(var(--accent-rgb), 0.4);
  border-left-color: rgba(var(--accent-rgb), 0.12);
  animation: zenSpin 9s linear reverse infinite;
}
@keyframes zenSpin {
  to {
    transform: rotate(1turn);
  }
}
.zen-rings.active {
  border-color: rgba(var(--accent-rgb), 0.34);
  animation: zenRingBreathe 3.4s ease-in-out infinite;
}
@keyframes zenRingBreathe {
  0%,
  100% {
    box-shadow:
      0 0 0 0 rgba(var(--accent-rgb), 0),
      0 0 22px rgba(var(--accent-rgb), 0.05);
  }
  50% {
    box-shadow:
      0 0 0 14px rgba(var(--accent-rgb), 0.06),
      0 0 34px rgba(var(--accent-rgb), 0.12);
  }
}
.zen-rings.pending {
  border-color: rgba(243, 180, 77, 0.26);
  animation: zenRingPending 2.6s ease-in-out infinite;
}
.zen-rings.pending:before {
  border-color: rgba(243, 180, 77, 0.11);
}
@keyframes zenRingPending {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(243, 180, 77, 0);
  }
  50% {
    box-shadow: 0 0 0 8px rgba(243, 180, 77, 0.05);
  }
}
.zen-power {
  width: 126px;
  height: 126px;
  z-index: 1;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 50%;
  display: grid;
  place-items: center;
  /* 半透明玻璃质感：透出背后的星空，但不用 backdrop-filter（见 .zen-core 注释） */
  background: radial-gradient(
    circle at 42% 34%,
    rgba(50, 54, 58, 0.8),
    rgba(16, 18, 20, 0.88)
  );
  color: rgba(200, 206, 210, 0.7);
  cursor: pointer;
  position: relative;
  transition:
    background 0.45s ease,
    border-color 0.45s ease,
    color 0.45s ease,
    transform 0.3s cubic-bezier(0.34, 1.4, 0.64, 1),
    box-shadow 0.45s ease;
}
.zen-power:before {
  content: "";
  position: absolute;
  inset: 9px;
  border-radius: 50%;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.6s ease;
  background: radial-gradient(
    circle at 50% 44%,
    rgba(var(--accent-rgb), 0.22),
    transparent 70%
  );
}
.zen-power:hover:not(:disabled) {
  transform: scale(1.06);
  border-color: rgba(var(--accent-rgb), 0.6);
  color: #eafff2;
  box-shadow:
    0 0 30px rgba(var(--accent-rgb), 0.2),
    0 0 60px rgba(var(--accent-rgb), 0.08);
}
.zen-power:active:not(:disabled) {
  transform: scale(0.97);
}
/* 悬停时按钮外圈出现一层旋转光弧，强化"可点击"的暗示 */
.zen-power:after {
  content: "";
  position: absolute;
  inset: -5px;
  border-radius: 50%;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.35s ease;
  background: conic-gradient(
    from 0turn,
    transparent 0turn,
    transparent 0.6turn,
    rgba(var(--accent-rgb), 0.55) 0.85turn,
    rgba(var(--accent-rgb), 0) 1turn
  );
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1.5px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1.5px));
}
.zen-power:hover:not(:disabled):after {
  opacity: 1;
  animation: zenSpin 2.4s linear infinite;
}
.zen-power.active {
  background: radial-gradient(
    circle at 42% 34%,
    rgba(var(--accent-rgb), 0.24),
    rgba(var(--accent-rgb), 0.08)
  );
  border-color: rgba(var(--accent-rgb), 0.62);
  color: #f2f4f5;
  box-shadow:
    0 0 34px rgba(var(--accent-rgb), 0.2),
    inset 0 0 22px rgba(var(--accent-rgb), 0.07);
  animation: zenPowerPulse 3.6s ease-in-out infinite;
}
@keyframes zenPowerPulse {
  0%,
  100% {
    box-shadow:
      0 0 30px rgba(var(--accent-rgb), 0.18),
      inset 0 0 20px rgba(var(--accent-rgb), 0.06);
  }
  50% {
    box-shadow:
      0 0 48px rgba(var(--accent-rgb), 0.3),
      inset 0 0 28px rgba(var(--accent-rgb), 0.12);
  }
}
.zen-power.active:before {
  opacity: 1;
  animation: zenCore 3.6s ease-in-out infinite;
}
@keyframes zenCore {
  0%,
  100% {
    transform: scale(0.92);
    opacity: 0.6;
  }
  50% {
    transform: scale(1.1);
    opacity: 1;
  }
}
.zen-power:disabled {
  cursor: wait;
}
/* 启动后从按钮本体向外扩散的声呐式波纹：比圆环上的扩散环更靠近按钮。
   不设 z-index，按 DOM 顺序绘制在按钮背景之上、图标之下。 */
.zen-pulse {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1.5px solid rgba(var(--accent-rgb), 0.6);
  opacity: 0;
  pointer-events: none;
}
.zen-power.active .zen-pulse {
  animation: zenPowerRipple 3s cubic-bezier(0.22, 0.61, 0.36, 1) infinite;
}
.zen-power.active .zen-pulse-b {
  animation-delay: 1s;
}
.zen-power.active .zen-pulse-c {
  animation-delay: 2s;
}
@keyframes zenPowerRipple {
  0% {
    transform: scale(1);
    opacity: 0.7;
    border-width: 2px;
  }
  65% {
    opacity: 0.16;
  }
  100% {
    transform: scale(1.85);
    opacity: 0;
    border-width: 1px;
  }
}
.zen-power svg {
  width: 40px;
  height: 40px;
  position: relative;
  transition:
    transform 0.35s cubic-bezier(0.34, 1.4, 0.64, 1),
    filter 0.35s ease;
}
.zen-power:hover:not(:disabled) svg {
  transform: scale(1.12);
  filter: drop-shadow(0 0 8px rgba(var(--accent-rgb), 0.7));
}
.zen-power.active svg {
  filter: drop-shadow(0 0 10px rgba(var(--accent-rgb), 0.55));
}
.zen-spinner {
  position: absolute;
  inset: 7px;
  border: 2.5px solid transparent;
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s cubic-bezier(0.4, 0.15, 0.6, 0.85) infinite;
}
/* 按钮下方：隧道名（小标签）+ 公网域名（可点击复制） */
.zen-target {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  margin-top: 24px;
  min-width: 0;
  max-width: 100%;
  animation: zenDrift 0.8s cubic-bezier(0.2, 0.8, 0.3, 1) both;
}
/* 域名链接：低对比度的链接态，悬停时点亮并出现下划线 */
.zen-domain {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: min(560px, 78vw);
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: rgba(226, 229, 232, 0.72);
  font: 500 12.5px ui-monospace, Consolas, monospace;
  cursor: pointer;
  transition:
    color 0.28s ease,
    border-color 0.28s ease,
    background 0.28s ease,
    transform 0.28s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.zen-domain > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-underline-offset: 3px;
  text-decoration: 1px underline transparent;
  transition: text-decoration-color 0.28s ease;
}
.zen-domain svg {
  flex: none;
  opacity: 0;
  transform: translateY(2px);
  transition:
    opacity 0.28s ease,
    transform 0.28s ease;
}
.zen-domain:hover {
  color: rgba(242, 244, 246, 0.98);
  border-color: rgba(var(--accent-rgb), 0.28);
  background: rgba(var(--accent-rgb), 0.07);
  transform: translateY(-1px);
}
.zen-domain:hover > span {
  text-decoration-color: rgba(var(--accent-rgb), 0.75);
}
.zen-domain:hover svg {
  opacity: 0.85;
  transform: translateY(0);
}
.zen-domain:active {
  transform: translateY(0) scale(0.985);
}
.zen-domain:focus-visible {
  outline: 2px solid rgba(var(--accent-rgb), 0.55);
  outline-offset: 2px;
}
.zen-domain-empty {
  color: rgba(180, 186, 192, 0.34);
  cursor: default;
}
.zen-domain-empty:hover {
  color: rgba(180, 186, 192, 0.34);
  border-color: transparent;
  background: transparent;
  transform: none;
}
/* 测速入口：域名下方的胶囊按钮，未运行时明确置灰 */
.zen-speed {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px;
  border: 1px solid rgba(var(--accent-rgb), 0.22);
  border-radius: 999px;
  background: rgba(var(--accent-rgb), 0.07);
  color: rgba(var(--accent-rgb), 0.8);
  font-size: 12px;
  cursor: pointer;
  transition:
    color 0.28s ease,
    border-color 0.28s ease,
    background 0.28s ease,
    transform 0.28s cubic-bezier(0.34, 1.4, 0.64, 1);
}
.zen-speed:hover:not(:disabled) {
  color: var(--accent-hover);
  border-color: rgba(var(--accent-rgb), 0.5);
  background: rgba(var(--accent-rgb), 0.14);
  transform: translateY(-1px);
}
.zen-speed:active:not(:disabled) {
  transform: translateY(0) scale(0.97);
}
.zen-speed:focus-visible {
  outline: 2px solid rgba(var(--accent-rgb), 0.55);
  outline-offset: 2px;
}
.zen-speed:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
@keyframes zenDrift {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
/* 列表模式的按钮配色（保留原有行为） */
.theme-light .row-actions .btn-start {
  color: var(--accent);
}
.theme-light .row-actions .btn-stop {
  color: #b5842a;
}
.theme-light .row-actions .btn-edit {
  color: #3a7fc4;
}
.theme-light .row-actions .btn-speed {
  color: #0f8f88;
}
.theme-light .row-actions .btn-delete {
  color: #c62828;
}
.theme-light .copy-btn {
  color: var(--text-secondary) !important;
}
.theme-light .copy-btn:hover {
  color: var(--accent) !important;
}
.theme-light .domain-line .text-muted {
  color: var(--text-muted);
}
/* ══ 浅色主题下的禅模式 ══ */
/* 星空在浅色下改用深色星点，文字用深色低对比度 */
.theme-light .zen-view .page-header h1 {
  color: rgba(42, 45, 49, 0.78);
}
.theme-light .zen-view .page-header p {
  color: rgba(110, 116, 122, 0.6);
}
.theme-light .zen-switch {
  border-color: rgba(0, 0, 0, 0.1);
  background: rgba(255, 255, 255, 0.6);
  color: rgba(92, 97, 103, 0.72);
}
.theme-light .zen-switch:hover {
  color: rgba(42, 45, 49, 0.95);
  border-color: rgba(var(--accent-rgb), 0.42);
  background: rgba(var(--accent-rgb), 0.1);
}
.theme-light .zen-select :deep(.n-base-selection) {
  --n-border: 1px solid rgba(0, 0, 0, 0.09);
  --n-border-hover: 1px solid rgba(var(--accent-rgb), 0.4);
  --n-border-active: 1px solid rgba(var(--accent-rgb), 0.55);
  --n-border-focus: 1px solid rgba(var(--accent-rgb), 0.4);
  --n-color: rgba(255, 255, 255, 0.55);
  --n-color-active: rgba(255, 255, 255, 0.85);
  --n-text-color: rgba(44, 47, 52, 0.82);
  --n-arrow-color: rgba(110, 116, 122, 0.6);
  --n-box-shadow-focus: 0 0 0 2px rgba(var(--accent-rgb), 0.14);
}
.theme-light .zen-rings {
  border-color: rgba(0, 0, 0, 0.08);
}
.theme-light .zen-rings:before,
.theme-light .zen-rings:after {
  border-color: rgba(0, 0, 0, 0.05);
}
.theme-light .zen-rings.active {
  border-color: rgba(var(--accent-rgb), 0.36);
}
/* 浅色下同样保留"透明底 + 单侧亮边"的转动刻度，不能用统一 border-color，
   否则旋转在视觉上会消失。 */
.theme-light .zen-rings.active:before {
  border-color: transparent;
  border-top-color: rgba(var(--accent-rgb), 0.55);
  border-right-color: rgba(var(--accent-rgb), 0.18);
}
.theme-light .zen-rings.active:after {
  border-color: transparent;
  border-bottom-color: rgba(var(--accent-rgb), 0.45);
  border-left-color: rgba(var(--accent-rgb), 0.14);
}
.theme-light .zen-ripple,
.theme-light .zen-ripple-c {
  border-color: rgba(var(--accent-rgb), 0.45);
}
.theme-light .zen-burst {
  border-color: rgba(var(--accent-rgb), 0.6);
}
.theme-light .zen-power {
  border-color: rgba(0, 0, 0, 0.1);
  background: radial-gradient(
    circle at 42% 34%,
    rgba(255, 255, 255, 0.82),
    rgba(244, 245, 247, 0.72)
  );
  color: rgba(84, 89, 95, 0.78);
}
.theme-light .zen-power:before {
  background: radial-gradient(
    circle at 50% 44%,
    rgba(var(--accent-rgb), 0.18),
    transparent 70%
  );
}
.theme-light .zen-power:after {
  background: conic-gradient(
    from 0turn,
    transparent 0turn,
    transparent 0.6turn,
    rgba(var(--accent-rgb), 0.6) 0.85turn,
    rgba(var(--accent-rgb), 0) 1turn
  );
}
.theme-light .zen-power:hover:not(:disabled) {
  border-color: rgba(var(--accent-rgb), 0.65);
  color: var(--accent);
  box-shadow:
    0 0 26px rgba(var(--accent-rgb), 0.18),
    0 0 52px rgba(var(--accent-rgb), 0.07);
}
.theme-light .zen-power:hover:not(:disabled) svg {
  filter: drop-shadow(0 0 7px rgba(var(--accent-rgb), 0.55));
}
.theme-light .zen-power.active {
  background: radial-gradient(
    circle at 42% 34%,
    rgba(255, 255, 255, 0.92),
    rgba(246, 247, 248, 0.86)
  );
  border-color: rgba(var(--accent-rgb), 0.6);
  color: var(--accent);
  animation: zenPowerPulseLight 3.6s ease-in-out infinite;
}
@keyframes zenPowerPulseLight {
  0%,
  100% {
    box-shadow:
      0 0 24px rgba(var(--accent-rgb), 0.14),
      inset 0 0 14px rgba(var(--accent-rgb), 0.05);
  }
  50% {
    box-shadow:
      0 0 40px rgba(var(--accent-rgb), 0.24),
      inset 0 0 20px rgba(var(--accent-rgb), 0.1);
  }
}
.theme-light .zen-power.active svg {
  filter: drop-shadow(0 0 9px rgba(var(--accent-rgb), 0.5));
}
/* 浅色下波纹用更饱和的强调色，否则在白底上几乎看不见 */
.theme-light .zen-pulse {
  border-color: rgba(var(--accent-rgb), 0.7);
}
.theme-light .zen-domain {
  color: rgba(44, 47, 52, 0.78);
}
.theme-light .zen-domain:hover {
  color: rgba(22, 24, 27, 0.98);
  border-color: rgba(var(--accent-rgb), 0.3);
  background: rgba(var(--accent-rgb), 0.08);
}
.theme-light .zen-domain:hover > span {
  text-decoration-color: rgba(var(--accent-rgb), 0.8);
}
.theme-light .zen-domain-empty {
  color: rgba(110, 116, 122, 0.45);
}
.theme-light .zen-speed {
  border-color: rgba(var(--accent-rgb), 0.28);
  background: rgba(var(--accent-rgb), 0.07);
  color: rgba(var(--accent-rgb), 0.85);
}
.theme-light .zen-speed:hover:not(:disabled) {
  border-color: rgba(var(--accent-rgb), 0.5);
  background: rgba(var(--accent-rgb), 0.13);
  color: var(--accent);
}
/* 窄屏：核心贴底，域名链接自动换行 */
@media (max-width: 860px) {
  .zen-view .page-header {
    padding: 24px 20px 0;
  }
  /* 窄屏下头部改为纵向排布，切换按钮与标题一行，选择器另起一行 */
  .zen-head {
    flex-direction: column;
    align-items: stretch;
    gap: 14px;
  }
  .zen-head .header-actions {
    justify-content: flex-end;
  }
  .zen-select {
    width: 100%;
  }
  /* 高度由 flex 布局自动分配，窄屏只收窄横向宽度 */
  .zen-console {
    width: calc(100% - 40px);
    margin: 0 auto 24px;
  }
  /* 窄屏：核心贴底，底部留白相应减小 */
  .zen-stage {
    padding: 24px 14px 4vh;
    min-height: 380px;
  }
  .zen-rings {
    width: 170px;
    height: 170px;
  }
  .zen-power {
    width: 104px;
    height: 104px;
  }
  .zen-power svg {
    width: 32px;
    height: 32px;
  }
  .zen-domain {
    max-width: calc(100vw - 80px);
    font-size: 11.5px;
  }
}
/* 尊重系统的「减少动态效果」设置：星海保留为静态画面，其余动画关闭。 */
@media (prefers-reduced-motion: reduce) {
  .zen-console,
  .zen-ripple,
  .zen-ripple-c,
  .zen-burst,
  .zen-rings,
  .zen-rings:before,
  .zen-rings:after,
  .zen-target,
  .zen-power,
  .zen-power:before,
  .zen-power:after,
  .zen-pulse,
  .zen-spinner {
    animation: none !important;
  }
  .zen-rings.active .zen-ripple {
    opacity: 0.3;
  }
  /* 关闭扩散波纹，只保留按钮本身的激活光效，避免持续位移刺激 */
  .zen-pulse {
    display: none;
  }
  .zen-domain,
  .zen-speed,
  .zen-power,
  .zen-core {
    transition: none;
  }
  /* 关闭 3D 倾斜，避免动效敏感用户看到跟随位移 */
  .zen-core {
    transform: none !important;
  }
}
</style>
