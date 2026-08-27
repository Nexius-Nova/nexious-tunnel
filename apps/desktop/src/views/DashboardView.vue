<script setup lang="ts">
import { computed, h, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import {
  NButton,
  NDataTable,
  NInput,
  NPagination,
  NSelect,
  NTag,
  NTooltip,
  type DataTableColumns
} from "naive-ui";
import VChart from "vue-echarts";
import { use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Cable,
  Copy,
  MapPin,
  RefreshCw,
  Search,
  X
} from "lucide-vue-next";
import { useRouter } from "vue-router";
import { api } from "../api/client";
import type { AccessLog } from "../types";
import PageHeader from "../components/PageHeader.vue";
import StateBlock from "../components/StateBlock.vue";

use([CanvasRenderer, LineChart, GridComponent, TooltipComponent]);
const router = useRouter(),
  dashboard = useQuery({
    queryKey: ["dashboard"],
    queryFn: api.dashboard,
    refetchInterval: 15000
  });

const bytes = (value: number = 0) =>
  value > 1e9
    ? `${(value / 1e9).toFixed(1)} GB`
    : `${(value / 1e6).toFixed(1)} MB`;
const extractDomain = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0];
  }
};
function copyUrl(text: string) {
  navigator.clipboard.writeText(text).then(
    () => {},
    () => {}
  );
}

/* ── Chart ── */
const option = computed(() => ({
  animationDuration: 600,
  grid: { left: 10, right: 12, top: 18, bottom: 6, containLabel: true },
  tooltip: {
    trigger: "axis",
    backgroundColor: "#1a1f22",
    borderColor: "#343b42",
    borderRadius: 6,
    padding: [8, 12],
    textStyle: { color: "#eef2f0", fontSize: 12 }
  },
  xAxis: {
    type: "category",
    boundaryGap: false,
    data: (dashboard.data.value?.series || []).map(
      (p) => new Date(p.timestamp).getHours() + ":00"
    ),
    axisLine: { lineStyle: { color: "#343b42" } },
    axisLabel: { color: "#7f8a86", interval: 3 }
  },
  yAxis: {
    type: "value",
    axisLabel: {
      color: "#7f8a86",
      formatter: (v: number) => `${(v / 1e6).toFixed(0)}M`
    },
    splitLine: { lineStyle: { color: "#252b2e", type: "dashed" } }
  },
  series: [
    {
      name: "下载",
      type: "line",
      smooth: 0.35,
      symbol: "none",
      data: (dashboard.data.value?.series || []).map((p) => p.inbound),
      lineStyle: { color: "#39d98a", width: 2 },
      areaStyle: {
        color: {
          type: "linear",
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: "rgba(57,217,138,.18)" },
            { offset: 1, color: "rgba(57,217,138,.01)" }
          ]
        }
      }
    },
    {
      name: "上传",
      type: "line",
      smooth: 0.35,
      symbol: "none",
      data: (dashboard.data.value?.series || []).map((p) => p.outbound),
      lineStyle: { color: "#f3b44d", width: 2 },
      areaStyle: {
        color: {
          type: "linear",
          x: 0,
          y: 0,
          x2: 0,
          y2: 1,
          colorStops: [
            { offset: 0, color: "rgba(243,180,77,.12)" },
            { offset: 1, color: "rgba(243,180,77,.01)" }
          ]
        }
      }
    }
  ]
}));

/* ── Logs ── */
const tunnelId = ref("all"),
  logStatus = ref<"all" | "success" | "error">("all"),
  keyword = ref(""),
  search = ref(""),
  page = ref(1),
  pageSize = ref(10);
const tunnels = useQuery({ queryKey: ["tunnels"], queryFn: api.tunnels });
const params = computed(() => ({
  tunnelId: tunnelId.value === "all" ? undefined : tunnelId.value,
  status: logStatus.value,
  search: search.value || undefined,
  page: page.value,
  pageSize: pageSize.value
}));
const logs = useQuery({
  queryKey: computed(() => ["logs", params.value]),
  queryFn: () => api.logs(params.value)
});
const tunnelOptions = computed(() => [
  { label: "全部隧道", value: "all" },
  ...(tunnels.data.value || []).map((t) => ({ label: t.name, value: t.id }))
]);
const statusOptions = [
  { label: "全部状态", value: "all" },
  { label: "成功请求", value: "success" },
  { label: "异常请求", value: "error" }
];
watch([tunnelId, logStatus, pageSize], () => {
  page.value = 1;
});
function applySearch() {
  search.value = keyword.value.trim();
  page.value = 1;
}
function resetLogs() {
  tunnelId.value = "all";
  logStatus.value = "all";
  keyword.value = "";
  search.value = "";
  page.value = 1;
}
const logColumns: DataTableColumns<AccessLog> = [
  {
    title: "时间",
    key: "timestamp",
    width: 160,
    render: (row) => new Date(row.timestamp).toLocaleString("zh-CN")
  },
  {
    title: "访问 IP",
    key: "client_ip",
    width: 140,
    render: (row) => h("code", row.client_ip)
  },
  {
    title: "访问入口",
    key: "path",
    minWidth: 220,
    render: (row) =>
      h("div", { class: "log-request" }, [
        h("b", row.method),
        h("code", row.path)
      ])
  },
  {
    title: "状态码",
    key: "status",
    width: 80,
    render: (row) =>
      h(
        NTag,
        {
          size: "small",
          type: row.status < 400 ? "success" : "error",
          bordered: false
        },
        { default: () => row.status }
      )
  },
  {
    title: "耗时",
    key: "duration",
    width: 80,
    render: (row) => `${row.duration} ms`
  },
  {
    title: "流量",
    key: "bytes",
    width: 85,
    render: (row) => `${(row.bytes / 1024).toFixed(1)} KB`
  }
];
</script>

<template>
  <div class="view">
    <PageHeader
      eyebrow="CONTROL CENTER"
      title="运行总览"
      description="跨网络边界，掌握每一条连接。"
    >
      <n-button
        quaternary
        circle
        title="刷新数据"
        :loading="dashboard.isFetching.value"
        @click="dashboard.refetch()"
        ><RefreshCw :size="18"
      /></n-button>
    </PageHeader>

    <StateBlock
      v-if="dashboard.isLoading.value || dashboard.error.value"
      :loading="dashboard.isLoading.value"
      :error="dashboard.error.value?.message"
    >
      <n-button v-if="dashboard.error.value" @click="dashboard.refetch()"
        >重新连接</n-button
      >
    </StateBlock>

    <template v-else-if="dashboard.data.value">
      <!-- Metrics Row -->
      <section class="metrics">
        <article class="metric-card metric-green">
          <div class="metric-icon"><Cable /></div>
          <div class="metric-body">
            <span>活动隧道</span
            ><strong
              >{{ dashboard.data.value.activeTunnels
              }}<small
                >/ {{ dashboard.data.value.tunnels.length }}</small
              ></strong
            ><em>运行正常</em>
          </div>
        </article>
        <article class="metric-card metric-amber">
          <div class="metric-icon"><ArrowDownToLine /></div>
          <div class="metric-body">
            <span>累计下载</span
            ><strong>{{ bytes(dashboard.data.value.totals.inbound) }}</strong
            ><em>最近 24 小时</em>
          </div>
        </article>
        <article class="metric-card metric-blue">
          <div class="metric-icon"><ArrowUpFromLine /></div>
          <div class="metric-body">
            <span>累计上传</span
            ><strong>{{ bytes(dashboard.data.value.totals.outbound) }}</strong
            ><em>最近 24 小时</em>
          </div>
        </article>
        <article class="metric-card metric-slate">
          <div class="metric-icon"><MapPin /></div>
          <div class="metric-body">
            <span>可用节点</span
            ><strong
              >{{ dashboard.data.value.onlineNodes }}<small> 个</small></strong
            ><em>边缘网络就绪</em>
          </div>
        </article>
      </section>

      <div class="dashboard-grid">
        <!-- Chart Full Width -->
        <section class="chart-section">
          <div class="panel-title">
            <div>
              <span>NETWORK TRAFFIC</span>
              <h2>网络流量</h2>
            </div>
            <div class="legend">
              <i class="download"></i>下载<i class="upload"></i>上传
            </div>
          </div>
          <v-chart class="chart" :option="option" autoresize />
        </section>

        <!-- Connections -->
        <section class="connection-panel">
          <div class="panel">
            <div class="panel-title">
              <div>
                <span>LIVE TUNNELS</span>
                <h2>实时连接</h2>
              </div>
              <button @click="router.push('/tunnels')">查看全部 →</button>
            </div>
            <div class="connection-list">
              <div
                v-for="tunnel in dashboard.data.value.tunnels.slice(0, 5)"
                :key="tunnel.id"
                class="connection"
              >
              <i :class="tunnel.status" />
              <div>
                <b>{{ tunnel.name }}</b
                ><span>{{
                  tunnel.access_url
                    ? extractDomain(tunnel.access_url)
                    : "等待分配"
                }}</span>
              </div>
              <n-tag size="small" :bordered="false">{{
                tunnel.protocol.toUpperCase()
              }}</n-tag>
              <n-tag
                size="small"
                :bordered="false"
                :type="
                  tunnel.status === 'running'
                    ? 'success'
                    : tunnel.auto_start
                      ? 'warning'
                      : 'default'
                "
                >{{
                  tunnel.status === "running"
                    ? "运行中"
                    : tunnel.auto_start
                      ? "连接中"
                      : "已停止"
                }}</n-tag
              >
              <n-button
                v-if="tunnel.access_url"
                quaternary
                circle
                size="tiny"
                class="conn-copy"
                title="复制地址"
                @click="copyUrl(tunnel.access_url!)"
              ><Copy :size="13" /></n-button>
              </div>
            </div>
          </div>
        </section>
      </div>

      <!-- Access Logs -->
      <section class="logs-section">
        <div class="panel-title">
          <div>
            <span>ACCESS OBSERVATORY</span>
            <h2>访问日志</h2>
          </div>
          <n-button
            quaternary
            circle
            title="刷新日志"
            :loading="logs.isFetching.value"
            @click="logs.refetch()"
            ><RefreshCw :size="15"
          /></n-button>
        </div>
        <div class="log-toolbar">
          <n-input
            v-model:value="keyword"
            clearable
            placeholder="搜索访问 IP、入口或方法"
            @keyup.enter="applySearch"
            ><template #prefix><Search :size="14" /></template
          ></n-input>
          <n-select
            v-model:value="tunnelId"
            :options="tunnelOptions"
            style="min-width: 140px"
          />
          <n-select
            v-model:value="logStatus"
            :options="statusOptions"
            style="min-width: 120px"
          />
          <n-button type="primary" size="small" @click="applySearch"
            >查询</n-button
          >
          <n-button quaternary size="small" title="重置筛选" @click="resetLogs"
            ><template #icon><X :size="14" /></template
          ></n-button>
        </div>
        <StateBlock
          v-if="
            logs.isLoading.value ||
            logs.error.value ||
            !logs.data.value?.items.length
          "
          :loading="logs.isLoading.value"
          :error="logs.error.value?.message"
          :empty="
            !logs.isLoading.value &&
            !logs.error.value &&
            !logs.data.value?.items.length
          "
          style="min-height: 120px"
        />
        <template v-else>
          <div class="table-panel-inner">
            <n-data-table
              :data="logs.data.value?.items || []"
              :columns="logColumns"
              :bordered="false"
              :scroll-x="800"
              size="small"
            />
          </div>
          <div class="log-pagination">
            <span>共 {{ logs.data.value?.total || 0 }} 条记录</span
            ><n-pagination
              v-model:page="page"
              v-model:page-size="pageSize"
              :item-count="logs.data.value?.total || 0"
              :page-sizes="[10, 20, 50, 100]"
              show-size-picker
            />
          </div>
        </template>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* ── Metric Cards ── */
.metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 20px;
}
.metric-card {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 20px;
  border: 1px solid var(--border, #292f32);
  background: var(--surface, #15191b);
  border-radius: 8px;
  transition:
    border-color 0.2s,
    box-shadow 0.2s;
}
.metric-card:hover {
  border-color: #353d40;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12);
}
.metric-icon {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  flex: none;
}
.metric-icon svg {
  width: 20px;
  height: 20px;
}
.metric-green .metric-icon {
  background: #12261d;
  color: #39d98a;
}
.metric-amber .metric-icon {
  background: #282115;
  color: #f3b44d;
}
.metric-blue .metric-icon {
  background: #152330;
  color: #6ab8f7;
}
.metric-slate .metric-icon {
  background: #252b2e;
  color: #cdd6d1;
}
.metric-body span {
  display: block;
  font-size: 12px;
  color: var(--text-secondary, #89938f);
}
.metric-body strong {
  display: block;
  font-size: 24px;
  margin: 8px 0 4px;
  white-space: nowrap;
}
.metric-body strong small {
  font-size: 12px;
  color: var(--text-muted, #69736f);
  font-weight: 500;
}
.metric-body em {
  font-style: normal;
  color: #5f6965;
  font-size: 11px;
}

/* ── Dashboard Grid (chart + connections) ── */
.dashboard-grid {
  display: grid;
  grid-template-columns: 1fr 380px;
  gap: 16px;
  margin-bottom: 20px;
  align-items: start;
}
.chart-section {
  height: 318px;
  border: 1px solid var(--border, #292f32);
  background: var(--surface, #15191b);
  border-radius: 8px;
  overflow: hidden;
}
.connection-panel .panel {
  height: 318px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.connection-list {
  min-height: 0;
  overflow-y: auto;
}
.chart {
  height: 260px;
}

/* ── Connection ── */
.conn-copy {
  color: #77817d !important;
}
.conn-copy:hover {
  color: var(--accent) !important;
}

/* ── Notice (compact) ── */
.notice {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  border: 1px solid var(--border, #292f32);
  background: var(--surface, #15191b);
  border-radius: 8px;
}
.notice-icon {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: 1px solid #334039;
  color: var(--accent);
  background: var(--accent-dim, rgba(57, 217, 138, 0.08));
  border-radius: 8px;
}
.notice > div:nth-child(2) {
  flex: 1;
  min-width: 0;
}
.notice b,
.notice span {
  display: block;
}
.notice b {
  font-size: 13px;
}
.notice span {
  font-size: 11px;
  color: #68726e;
  margin-top: 3px;
}

/* ── Logs ── */
.logs-section {
  border: 1px solid var(--border, #292f32);
  background: var(--surface, #15191b);
  border-radius: 8px;
  overflow: hidden;
}
.log-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle, #242a2c);
}
.log-toolbar .n-input {
  flex: 1;
  min-width: 180px;
}
.table-panel-inner {
  overflow: auto;
}
.log-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-top: 1px solid var(--border-subtle, #242a2c);
}
.log-pagination > span {
  font-size: 12px;
  color: #74807a;
}
:deep(.log-request) {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
:deep(.log-request b) {
  flex: none;
  font: 600 10px "IBM Plex Mono";
  color: #39d98a;
}
:deep(.log-request code) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Light Theme ── */
.theme-light .metric-card {
  background: #fff;
  border-color: #d8dedb;
}
.theme-light .metric-card:hover {
  border-color: #cdd6d1;
  box-shadow: 0 2px 8px rgba(20, 32, 26, 0.06);
}
.theme-light .metric-green .metric-icon {
  background: #e6f5ec;
  color: #1d8a56;
}
.theme-light .metric-amber .metric-icon {
  background: #fdf3e2;
  color: #b5842a;
}
.theme-light .metric-blue .metric-icon {
  background: #e6f2fc;
  color: #3a7fc4;
}
.theme-light .metric-slate .metric-icon {
  background: #f0f2f1;
  color: #3d4541;
}
.theme-light .chart-section {
  background: #fff;
  border-color: #d8dedb;
}
.theme-light .conn-copy {
  color: #52605a !important;
}
.theme-light .conn-copy:hover {
  color: #239b61 !important;
}
.theme-light .notice {
  background: #fff;
  border-color: #d8dedb;
}
.theme-light .notice-icon {
  background: #edf7f1;
  border-color: #b9d8c7;
}
.theme-light .logs-section {
  background: #fff;
  border-color: #d8dedb;
}
.theme-light .log-toolbar,
.theme-light .log-pagination {
  border-color: #e1e6e3;
}
.theme-light .log-pagination > span {
  color: #68736e;
}
.theme-light .dashboard-grid .chart-section,
.theme-light .dashboard-grid .connection-panel .panel {
  background: #fff;
  border-color: #d8dedb;
}

/* ── Responsive ── */
@media (max-width: 1050px) {
  .metrics {
    grid-template-columns: repeat(2, 1fr);
  }
  .dashboard-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 720px) {
  .metrics {
    grid-template-columns: 1fr;
  }
  .chart {
    height: 200px;
  }
  .chart-section {
    height: 258px;
  }
  .connection-panel .panel {
    height: auto;
    max-height: 390px;
  }
  .log-toolbar .n-input {
    min-width: 100%;
    order: -1;
  }
}
@media (max-width: 560px) {
  .log-pagination {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
  }
}
</style>
