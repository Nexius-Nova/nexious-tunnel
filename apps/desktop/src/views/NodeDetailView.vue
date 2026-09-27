<script setup lang="ts">
import { computed, h, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useQuery } from "@tanstack/vue-query";
import {
  NButton, NDataTable, NPagination, NPopconfirm, NTag, NTooltip,
  type DataTableColumns
} from "naive-ui";
import {
  Activity, AlertTriangle, ArrowLeft, ArrowUpFromLine, Cable, Cpu,
  Pencil, Play, Power, RefreshCw, ServerCog, Trash2, Waypoints
} from "lucide-vue-next";
import { api } from "../api/client";
import { useTunnelLifecycle } from "../composables/useTunnelLifecycle";
import type { AccessLog, NodeDetail, Tunnel } from "../types";
import PageHeader from "../components/PageHeader.vue";
import StateBlock from "../components/StateBlock.vue";
import TunnelDrawer from "../components/TunnelDrawer.vue";

const route = useRoute(), router = useRouter();
const nodeId = computed(() => String(route.params.id || ""));
const loading = ref(true), error = ref(""), detail = ref<NodeDetail | null>(null);
const logs = ref<AccessLog[]>([]), logsTotal = ref(0), logsError = ref("");
const logsPage = ref(1), logsLoading = ref(false);
let generation = 0;

// 隧道生命周期与隧道管理页共用同一套逻辑（启停守护/删除/编辑抽屉）；
// 节点详情的数据是进入时的快照，启停/保存/删除后整体重拉，保证列表与汇总一致。
const {
  native, runningTunnelId, deletingId, editing, drawer, open, save,
  run, remove, isRunning
} = useTunnelLifecycle({
  onSaved: () => void load(),
  onRemoved: () => void load(),
  onToggled: () => void load()
});
// 编辑抽屉需要节点列表（切换隧道所属节点用）
const nodesQuery = useQuery({ queryKey: ["nodes"], queryFn: api.nodes });

// 日志是独立分页接口：详情加载完成后单独拉取，失败时单独提示，
// 不能让"加载失败"冒充"确实没有记录"。
async function loadLogs(session: number) {
  logsLoading.value = true;
  logsError.value = "";
  try {
    const page = await api.logs({
      nodeId: nodeId.value,
      page: logsPage.value,
      pageSize: 20
    });
    if (session !== generation) return;
    logs.value = page.items;
    logsTotal.value = page.total;
  } catch (reason) {
    if (session === generation)
      logsError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    if (session === generation) logsLoading.value = false;
  }
}

async function load() {
  if (!nodeId.value) return;
  const session = ++generation;
  loading.value = true;
  error.value = "";
  detail.value = null;
  logs.value = [];
  logsTotal.value = 0;
  logsError.value = "";
  logsPage.value = 1;
  try {
    detail.value = await api.nodeDetail(nodeId.value);
  } catch (value) {
    if (session === generation)
      error.value = value instanceof Error ? value.message : String(value);
    return;
  } finally {
    if (session === generation) loading.value = false;
  }
  if (session === generation) await loadLogs(session);
}
watch(nodeId, () => void load(), { immediate: true });

function onLogsPage(page: number) {
  logsPage.value = page;
  void loadLogs(generation);
}

// 表格单元格由 NDataTable 渲染，本组件的 scoped 样式无法命中，这里直接内联样式。
const cellStyle = { display: "flex", alignItems: "center", gap: "9px", minWidth: "0" } as const;
// 运行状态点是全站统一的语义固定色（与节点列表一致）：绿=运行、灰=停止，不随主题风格变化
const dotStyle = (running: boolean) => ({
  width: "7px", height: "7px", borderRadius: "50%", flex: "none",
  background: running ? "#28c780" : "#5b6360"
});
const textStyle = { minWidth: "0", overflow: "hidden" } as const;
const nameStyle = { display: "block", fontSize: "12.5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;
const subStyle = { display: "block", fontSize: "11px", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;
const tunnelColumns: DataTableColumns<Tunnel> = [
  {
    title: "隧道", key: "name", ellipsis: { tooltip: true },
    render: (row) => h("div", { style: cellStyle }, [
      h("i", { style: dotStyle(row.status === "running") }),
      h("div", { style: textStyle }, [
        h("b", { style: nameStyle }, row.name),
        h("span", { style: subStyle }, row.access_url || "等待分配访问地址")
      ])
    ])
  },
  { title: "本地服务", key: "local_port", width: 168, render: (row) => `${row.local_host}:${row.local_port}` },
  {
    title: "状态", key: "status", width: 90,
    render: (row) => h(NTag, { type: row.status === "running" ? "success" : "default", bordered: false, size: "small" },
      { default: () => (row.status === "running" ? "运行中" : "已停止") })
  },
  // 操作列与隧道管理页一致：启停/编辑/删除，共用同一套生命周期逻辑
  {
    title: "", key: "actions", width: 140, align: "right",
    render: (row) =>
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
                  class: isRunning(row) ? "btn-stop" : "btn-start",
                  loading: runningTunnelId.value === row.id,
                  disabled: !native || runningTunnelId.value === row.id,
                  "aria-label": (isRunning(row) ? "停止" : "启动") + row.name,
                  onClick: () => run.mutate(row)
                },
                { icon: () => h(isRunning(row) ? Power : Play, { size: 16 }) }
              ),
            default: () =>
              !native
                ? "请在桌面客户端中运行本机隧道"
                : isRunning(row)
                  ? "停止"
                  : "启动"
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
                  onClick: () => open(row)
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
                { onPositiveClick: () => remove.mutate(row) },
                {
                  trigger: () =>
                    h(
                      NButton,
                      {
                        quaternary: true,
                        circle: true,
                        size: "small",
                        class: "btn-delete",
                        loading: deletingId.value === row.id,
                        disabled: deletingId.value === row.id
                      },
                      { icon: () => h(Trash2, { size: 15 }) }
                    ),
                  default: () => `确认删除隧道"${row.name}"？`
                }
              ),
            default: () => "删除"
          }
        )
      ])
  }
];
const logColumns: DataTableColumns<AccessLog> = [
  { title: "时间", key: "timestamp", width: 172, render: (row) => new Date(row.timestamp).toLocaleString("zh-CN", { hour12: false }) },
  { title: "方法", key: "method", width: 68 },
  // 与运行总览一致：展示用户实际访问的完整地址，而不是构建产物路径。
  { title: "访问地址", key: "path", ellipsis: { tooltip: true }, render: (row) => row.access_url || row.path },
  {
    title: "状态", key: "status", width: 72,
    render: (row) => h(NTag, { type: row.status < 400 ? "success" : "error", bordered: false, size: "small" },
      { default: () => String(row.status) })
  },
  { title: "来源", key: "client_ip", width: 138, ellipsis: { tooltip: true } }
];

const state = computed(() => {
  const status = detail.value?.node.deploy_status;
  return status === "ready" ? { label: "已连接", tone: "green" }
    : status === "deploying" ? { label: "部署中", tone: "amber" }
    : status === "error" ? { label: "配置异常", tone: "red" } : { label: "未配置", tone: "slate" };
});
const drift = computed(() => detail.value?.syncDrift ?? null);
const runningCount = computed(() => detail.value?.tunnels.filter((item) => item.status === "running").length ?? 0);
function formatBytes(value: unknown) {
  // null 表示节点未提供字节数，用“—”区别于真实为 0 的流量。
  if (value === null || value === undefined) return "—";
  const size = Number(value) || 0;
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1048576) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1073741824) return `${(size / 1048576).toFixed(1)} MB`;
  return `${(size / 1073741824).toFixed(2)} GB`;
}
const formatCount = (value: unknown) => (Number(value) || 0).toLocaleString("zh-CN");
const time = (value?: string | null) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未检查";
function back() { void router.push("/nodes"); }
</script>

<template>
  <div class="view node-detail-view">
    <PageHeader
      :title="detail ? detail.node.name : '节点详情'"
      :description="detail ? `节点域名 ${detail.node.host}` : '查看节点运行状态、隧道与访问日志。'"
    >
      <n-button @click="back"><template #icon><ArrowLeft :size="16" /></template>返回节点列表</n-button>
      <n-button :loading="loading" @click="load"><template #icon><RefreshCw :size="16" /></template>刷新</n-button>
    </PageHeader>

    <StateBlock v-if="loading || error" :loading="loading" :error="error">
      <n-button v-if="error" @click="load">重试</n-button>
    </StateBlock>

    <template v-else-if="detail">
      <!-- 指标条：先把关键数字摊平，避免把状态读成一张表 -->
      <section class="metrics">
        <article class="metric-card" :class="`metric-${state.tone}`">
          <div class="metric-icon"><Waypoints /></div>
          <div class="metric-body">
            <span>连接状态</span><strong>{{ state.label }}</strong>
            <em>{{ detail.node.controller_url ? "控制中心已就绪" : "尚未部署控制中心" }}</em>
          </div>
        </article>
        <article class="metric-card metric-blue">
          <div class="metric-icon"><Cable /></div>
          <div class="metric-body">
            <span>隧道</span><strong>{{ runningCount }}<small> / {{ detail.tunnels.length }}</small></strong>
            <em>运行中 / 总数</em>
          </div>
        </article>
        <article class="metric-card metric-amber">
          <div class="metric-icon"><Activity /></div>
          <div class="metric-body">
            <span>累计请求</span><strong>{{ formatCount(detail.totals.requests) }}</strong>
            <em>该节点全部隧道</em>
          </div>
        </article>
        <article class="metric-card metric-slate">
          <div class="metric-icon"><ArrowUpFromLine /></div>
          <div class="metric-body">
            <span>累计流量</span><strong>{{ formatBytes(detail.totals.bytes) }}</strong>
            <em>请求与响应合计</em>
          </div>
        </article>
      </section>

      <div class="detail-layout">
        <!-- 主区：数据表 -->
        <div class="detail-main">
          <section class="panel-block">
            <header class="block-head">
              <div><h2>隧道列表</h2></div>
              <n-tag size="small" :bordered="false">{{ detail.tunnels.length }} 条</n-tag>
            </header>
            <p v-if="drift && drift.extra.length" class="block-alert"><AlertTriangle :size="14" />节点上有 {{ drift.extra.length }} 条主控不存在的残留隧道，会在下一次自动对账时清理。</p>
            <p v-if="drift && drift.missing.length" class="block-alert"><AlertTriangle :size="14" />有 {{ drift.missing.length }} 条隧道尚未下发到节点，会在下一次自动同步时补齐。</p>
            <n-data-table v-if="detail.tunnels.length" :columns="tunnelColumns" :data="detail.tunnels" :bordered="false" :max-height="280" :scroll-x="640" />
            <p v-else class="block-empty">该节点还没有隧道，到“隧道管理”页新建后会自动下发到这里。</p>
          </section>

          <section class="panel-block">
            <header class="block-head">
              <div><h2>访问日志</h2></div>
              <n-tag v-if="logsTotal" size="small" :bordered="false">最近 {{ logs.length }} / 共 {{ formatCount(logsTotal) }}</n-tag>
            </header>
            <n-data-table v-if="logs.length" :columns="logColumns" :data="logs" :bordered="false" :max-height="420" :loading="logsLoading" />
            <p v-else-if="logsLoading" class="block-empty">日志加载中…</p>
            <p v-else-if="logsError" class="block-empty">日志加载失败：{{ logsError }}<br /><n-button text size="small" @click="onLogsPage(logsPage)">重新加载</n-button></p>
            <p v-else class="block-empty">暂无访问记录，隧道产生请求后会显示在这里。</p>
            <footer v-if="logsTotal > 20" class="log-pagination">
              <n-pagination
                :page="logsPage"
                :item-count="logsTotal"
                :page-size="20"
                @update:page="onLogsPage"
              />
            </footer>
          </section>
        </div>

        <!-- 侧栏：节点配置（基础信息 + 运行参数同列堆叠，避免右侧大片留白） -->
        <aside class="detail-side">
          <section class="panel-block">
            <header class="block-head"><div><h2>基础信息</h2></div></header>
            <dl class="info-list">
              <div><dt>节点域名</dt><dd>{{ detail.node.host }}</dd></div>
              <div><dt>SSH 连接</dt><dd>{{ detail.node.ssh_user && detail.node.server_host ? `${detail.node.ssh_user}@${detail.node.server_host}:${detail.node.ssh_port}` : "尚未关联" }}</dd></div>
              <div><dt>控制中心 API</dt><dd>{{ detail.node.controller_url || "未配置" }}</dd></div>
              <div><dt>最近检查</dt><dd>{{ time(detail.node.last_checked_at) }}</dd></div>
            </dl>
            <p v-if="detail.node.last_error" class="block-error">{{ detail.node.last_error }}</p>
          </section>

          <section class="panel-block">
            <header class="block-head">
              <div><h2>运行参数</h2></div>
              <ServerCog :size="16" class="block-icon" />
            </header>
            <p v-if="!detail.parameters" class="block-empty">{{ detail.nodeTunnelIds === null ? "节点不可达，暂时无法读取运行参数。" : "该节点为旧版本，重新部署后即可显示运行参数。" }}</p>
            <dl v-else class="info-list">
              <div><dt>角色</dt><dd>{{ detail.parameters.role === "edge" ? "边缘节点" : "控制中心" }}</dd></div>
              <div><dt>监听地址</dt><dd>{{ detail.parameters.bindHost }}:{{ detail.parameters.port }}</dd></div>
              <div><dt>公网域名</dt><dd>{{ detail.parameters.publicHost || "未设置" }}</dd></div>
              <div><dt>数据库</dt><dd>{{ detail.parameters.database }}</dd></div>
              <div><dt>日志保留</dt><dd>{{ detail.parameters.logRetentionDays }} 天</dd></div>
              <div><dt>流量保留</dt><dd>{{ detail.parameters.trafficRetentionDays }} 天</dd></div>
              <div><dt>请求体上限</dt><dd>{{ detail.parameters.maxBodyMb }} MB</dd></div>
              <div><dt>中继帧上限</dt><dd>{{ detail.parameters.maxWebSocketMb }} MB</dd></div>
              <div><dt>信任代理头</dt><dd>{{ detail.parameters.trustProxyHeaders ? "已开启" : "未开启" }}</dd></div>
              <div><dt>Node 版本</dt><dd>{{ detail.parameters.nodeVersion }}</dd></div>
            </dl>
          </section>
        </aside>
      </div>
    </template>

    <!-- 编辑抽屉：与隧道管理页共用同一组件与保存逻辑 -->
    <TunnelDrawer
      :show="drawer"
      :tunnel="editing"
      :nodes="nodesQuery.data.value || []"
      :tunnels="detail?.tunnels || []"
      :loading="save.isPending.value"
      @close="drawer = false"
      @submit="save.mutate"
    />
  </div>
</template>

<style scoped>
/* ── 指标条：沿用与运行总览一致的视觉语言 ── */
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:20px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);overflow:hidden}
.metric-card{display:flex;align-items:flex-start;gap:14px;padding:18px 20px;border-right:1px solid var(--border)}
.metric-card:last-child{border-right:0}
.metric-icon{width:42px;height:42px;display:grid;place-items:center;border-radius:10px;flex:none}
.metric-icon svg{width:20px;height:20px}
.metric-green .metric-icon{background:var(--accent-soft-bg);color:var(--accent)}
.metric-amber .metric-icon{background:#282115;color:#f3b44d}
.metric-blue .metric-icon{background:#152330;color:#6ab8f7}
.metric-red .metric-icon{background:#2c1719;color:#e35d6a}
.metric-slate .metric-icon{background:var(--border-subtle);color:#cdd6d1}
.metric-body{min-width:0}
.metric-body span{display:block;font-size:12px;color:var(--text-secondary)}
.metric-body strong{display:block;margin:4px 0 2px;font-size:22px;font-weight:600;line-height:1.15;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.metric-body strong small{font-size:13px;font-weight:500;color:var(--text-secondary)}
.metric-body em{font-style:normal;font-size:11px;color:var(--text-muted)}

/* ── 主体两栏：数据表占主区，配置信息收进侧栏 ── */
.detail-layout{display:grid;grid-template-columns:minmax(0,1fr) 328px;gap:16px;align-items:start}
.detail-main,.detail-side{display:flex;flex-direction:column;gap:16px;min-width:0}
.detail-side{position:sticky;top:0}
.panel-block{border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);overflow:hidden}
.block-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--border)}
.block-head h2{margin:0;font-size:14px}
.block-icon{color:var(--text-muted)}
.block-alert{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--amber);margin:0;padding:10px 18px;border-bottom:1px solid var(--border);background:rgba(243,180,77,.06)}
.block-empty{margin:0;padding:22px 18px;font-size:12px;color:var(--text-secondary);text-align:center}
.block-error{margin:0;padding:12px 18px;font-size:12px;color:#e35d6a;background:rgba(227,93,106,.08);overflow-wrap:anywhere;border-top:1px solid var(--border)}

/* ── 隧道操作列：与隧道管理页同一套配色 ── */
.row-actions{display:flex;align-items:center;justify-content:flex-end;gap:2px}
.row-actions .btn-start{color:var(--accent)}
.row-actions .btn-start:hover{color:var(--accent-hover)}
.row-actions .btn-stop{color:var(--amber)}
.row-actions .btn-stop:hover{color:#e5a23d}
.row-actions .btn-edit{color:var(--blue)}
.row-actions .btn-edit:hover{color:#4fa8f0}
.row-actions .btn-delete{color:#e57373}
.row-actions .btn-delete:hover{color:#ef5350}
.theme-light .row-actions .btn-stop{color:#b5842a}
.theme-light .row-actions .btn-edit{color:#3a7fc4}
.theme-light .row-actions .btn-delete{color:#c62828}

/* ── 日志分页：表格下方右对齐 ── */
.log-pagination{display:flex;justify-content:flex-end;padding:12px 18px;border-top:1px solid var(--border-subtle)}

/* ── 侧栏信息列表：标签在上、值在下，窄列下不会出现断行错位 ──
   基础信息与运行参数共用同一样式，两块面板同列堆叠 */
.info-list{margin:0;padding:6px 18px 14px}
.info-list div{display:flex;flex-direction:column;gap:3px;padding:9px 0;border-bottom:1px solid var(--border-subtle)}
.info-list div:last-child{border-bottom:0}
.info-list dt{font-size:11px;color:var(--text-secondary)}
.info-list dd{margin:0;font:500 12px ui-monospace,Consolas,monospace;overflow-wrap:anywhere}

@media (max-width:1180px){
  .metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
  .metric-card:nth-child(2){border-right:0}
  .metric-card:nth-child(-n+2){border-bottom:1px solid var(--border)}
  .detail-layout{grid-template-columns:minmax(0,1fr)}
  .detail-side{position:static}
}
@media (max-width:620px){
  .metrics{grid-template-columns:minmax(0,1fr)}
  .metric-card{border-right:0;border-bottom:1px solid var(--border)}
  .metric-card:last-child{border-bottom:0}
}

/* ── 浅色主题：指标图标与提示条改用浅底深字 ── */
.theme-light .metric-green .metric-icon{background:var(--accent-soft-bg);color:var(--accent)}
.theme-light .metric-amber .metric-icon{background:#fdf3e2;color:#b5842a}
.theme-light .metric-blue .metric-icon{background:#e6f2fc;color:#3a7fc4}
.theme-light .metric-red .metric-icon{background:#fdecec;color:#b83243}
.theme-light .metric-slate .metric-icon{background:var(--surface-hover);color:#3d4541}
.theme-light .block-alert{color:#b5842a;background:#fdf7ea}
.theme-light .block-error{color:#b83243;background:#fff1f2}
</style>
