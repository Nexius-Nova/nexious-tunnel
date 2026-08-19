<script setup lang="ts">
import { computed, h, ref, watch } from "vue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";
import {
  NButton,
  NDataTable,
  NInput,
  NPopconfirm,
  NSelect,
  NTag,
  NTooltip,
  useMessage,
  type DataTableColumns
} from "naive-ui";
import {
  Copy,
  List,
  Focus,
  Pencil,
  Play,
  Plus,
  Power,
  Search,
  Trash2
} from "lucide-vue-next";
import { api } from "../api/client";
import { startTunnelAgent, stopTunnelAgent } from "../agentRuntime";
import type { Tunnel, TunnelInput } from "../types";
import PageHeader from "../components/PageHeader.vue";
import StateBlock from "../components/StateBlock.vue";
import TunnelDrawer from "../components/TunnelDrawer.vue";

const message = useMessage(),
  qc = useQueryClient(),
  search = ref(""),
  drawer = ref(false),
  editing = ref<Tunnel | null>(null),
  runningTunnelId = ref<string | null>(null);
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
const launched = new Set<string>();
const refresh = () => {
  qc.invalidateQueries({ queryKey: ["tunnels"] });
  qc.invalidateQueries({ queryKey: ["dashboard"] });
};
const save = useMutation({
  mutationFn: (value: TunnelInput) =>
    editing.value
      ? api.updateTunnel(editing.value.id, value)
      : api.createTunnel(value),
  onSuccess: () => {
    message.success(editing.value ? "隧道已更新" : "隧道已创建");
    drawer.value = false;
    refresh();
  },
  onError: (error) => message.error(error.message)
});
const isEnabled = (tunnel: Tunnel) =>
  tunnel.status === "running" || Boolean(tunnel.auto_start);
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
const run = useMutation({
  mutationFn: async (tunnel: Tunnel) => {
    runningTunnelId.value = tunnel.id;
    if (isEnabled(tunnel)) {
      await stopTunnelAgent(tunnel);
      launched.delete(tunnel.id);
    } else {
      await startTunnelAgent(tunnel);
      launched.add(tunnel.id);
    }
  },
  onSuccess: (_, tunnel) => {
    message.success(isEnabled(tunnel) ? "隧道已停止" : "隧道正在自动连接");
    window.setTimeout(refresh, 1200);
  },
  onError: (error) =>
    message.error(error instanceof Error ? error.message : "Agent 操作失败"),
  onSettled: () => {
    runningTunnelId.value = null;
  }
});
const remove = useMutation({
  mutationFn: async (tunnel: Tunnel) => {
    await stopTunnelAgent(tunnel).catch(() => undefined);
    return api.deleteTunnel(tunnel.id);
  },
  onSuccess: () => {
    message.success("隧道已删除");
    refresh();
  },
  onError: (error) => message.error(error.message)
});

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
    for (const tunnel of rows || []) {
      if (tunnel.auto_start && !launched.has(tunnel.id)) {
        launched.add(tunnel.id);
        startTunnelAgent(tunnel)
          .then(() => window.setTimeout(refresh, 1000))
          .catch((error) => {
            launched.delete(tunnel.id);
            message.error(
              `"${tunnel.name}"自动启动失败：${error instanceof Error ? error.message : "未知错误"}`
            );
          });
      }
    }
  },
  { immediate: true }
);
watch(
  selectedTunnelId,
  (value) => value && localStorage.setItem("nexious-zen-tunnel", value)
);

function open(tunnel: Tunnel | null = null) {
  editing.value = tunnel;
  drawer.value = true;
}
const filtered = () =>
  tunnels.data.value?.filter((tunnel) =>
    `${tunnel.name}${tunnel.local_host}${tunnel.domain}`
      .toLowerCase()
      .includes(search.value.toLowerCase())
  ) || [];

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
      ]);
    }
  },
  {
    title: "状态",
    key: "status",
    width: 100,
    render: (tunnel) =>
      h(
        NTag,
        {
          size: "small",
          bordered: false,
          type:
            tunnel.status === "running"
              ? "success"
              : tunnel.auto_start
                ? "warning"
                : "default"
        },
        {
          default: () =>
            tunnel.status === "running"
              ? "运行中"
              : tunnel.auto_start
                ? "连接中"
                : "已停止"
        }
      )
  },
  {
    title: "",
    key: "actions",
    width: 110,
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
                  class: isEnabled(tunnel) ? "btn-stop" : "btn-start",
                  loading: runningTunnelId.value === tunnel.id,
                  disabled: run.isPending.value,
                  onClick: () => run.mutate(tunnel)
                },
                {
                  icon: () => h(isEnabled(tunnel) ? Power : Play, { size: 16 })
                }
              ),
            default: () => (isEnabled(tunnel) ? "停止" : "启动")
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
                        class: "btn-delete"
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
    <PageHeader
      :eyebrow="mode === 'zen' ? 'FOCUS CONNECTION' : 'TUNNEL REGISTRY'"
      :title="mode === 'zen' ? '禅模式' : '隧道管理'"
      :description="
        mode === 'zen'
          ? '一次只关注一条连接。'
          : '配置、发布并监控你的本地服务。'
      "
    >
      <n-button
        :type="mode === 'list' ? 'primary' : 'default'"
        :secondary="mode !== 'list'"
        @click="setMode('list')"
        ><template #icon><List /></template>列表</n-button
      ><n-button
        :type="mode === 'zen' ? 'primary' : 'default'"
        :secondary="mode !== 'zen'"
        @click="setMode('zen')"
        ><template #icon><Focus /></template>禅</n-button
      >
      <n-button
        v-if="mode === 'list'"
        type="primary"
        @click="open()"
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
      <section class="zen-console">
        <div class="zen-header">
          <n-select
            v-model:value="selectedTunnelId"
            :options="tunnelOptions"
            style="width: 200px"
          />
          <n-button type="primary" @click="open()"
            ><template #icon><Plus /></template>新建</n-button
          >
        </div>
        <div class="zen-stage">
          <div
            class="zen-rings"
            :class="{
              active: selectedTunnel.status === 'running',
              pending:
                selectedTunnel.auto_start && selectedTunnel.status !== 'running'
            }"
          >
            <button
              class="zen-power"
              :class="{ active: isEnabled(selectedTunnel) }"
              :disabled="run.isPending.value"
              :aria-label="isEnabled(selectedTunnel) ? '停止隧道' : '启动隧道'"
              @click="run.mutate(selectedTunnel)"
            >
              <Power /><span
                v-if="runningTunnelId === selectedTunnel.id"
                class="zen-spinner"
              ></span>
            </button>
          </div>
          <div class="zen-state">
            <i :class="selectedTunnel.status"></i
            ><b>{{
              selectedTunnel.status === "running"
                ? "隧道已连接"
                : selectedTunnel.auto_start
                  ? "正在连接"
                  : "隧道已停止"
            }}</b
            ><span>{{ selectedTunnel.name }}</span>
          </div>
          <div class="zen-details">
            <div>
              <span>本地端口</span><code>{{ selectedTunnel.local_port }}</code>
            </div>
            <div>
              <span>域名</span
              ><code>{{
                selectedTunnel.access_url
                  ? extractDomain(selectedTunnel.access_url)
                  : "—"
              }}</code>
            </div>
            <div>
              <span>边缘节点</span><b>{{ selectedTunnel.node_name }}</b>
            </div>
          </div>
          <div class="zen-actions">
            <n-button
              quaternary
              circle
              @click="open(selectedTunnel)" 
              ><Pencil :size="16"
            /></n-button>
            <n-popconfirm @positive-click="remove.mutate(selectedTunnel)"
              ><template #trigger
                ><n-button
                  quaternary
                  circle
                  :disabled="remove.isPending.value"
                  ><Trash2 :size="16"
                /></n-button></template
              >确认删除隧道"{{ selectedTunnel.name }}"？</n-popconfirm>
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
        ><span>{{ filtered().length }} 条隧道</span>
      </div>
      <StateBlock v-if="!filtered().length" empty />
      <div v-else class="table-panel">
        <n-data-table
          :columns="columns"
          :data="filtered()"
          :scroll-x="700"
          :bordered="false"
        />
      </div>
    </template>
    <TunnelDrawer
      :show="drawer"
      :tunnel="editing"
      :nodes="nodes.data.value || []"
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
  color: #2ebd78;
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
.row-actions .btn-delete {
  color: #e57373;
}
.row-actions .btn-delete:hover {
  color: #ef5350;
}
.domain-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.domain-cell code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.domain-cell .text-muted {
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
.zen-console {
  min-height: 560px;
  border: 1px solid var(--border, #292f32);
  background: linear-gradient(170deg, #131719 0%, #111518 50%, #131a17 100%);
  position: relative;
  overflow: hidden;
  border-radius: 8px;
}
.zen-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border, #292f32);
  background: rgba(19, 23, 25, 0.6);
  backdrop-filter: blur(8px);
}
.zen-stage {
  min-height: 480px;
  display: flex;
  align-items: center;
  flex-direction: column;
  justify-content: center;
  padding: 32px;
}
.zen-rings {
  width: 200px;
  height: 200px;
  border: 1px solid #303938;
  border-radius: 50%;
  display: grid;
  place-items: center;
  position: relative;
  transition:
    border-color 0.5s ease,
    box-shadow 0.5s ease;
}
.zen-rings:before,
.zen-rings:after {
  content: "";
  position: absolute;
  border: 1px solid #29312f;
  border-radius: 50%;
  pointer-events: none;
  transition: border-color 0.5s ease;
}
.zen-rings:before {
  inset: 16px;
}
.zen-rings:after {
  inset: 34px;
}
.zen-rings.active {
  border-color: rgba(57, 217, 138, 0.45);
}
.zen-rings.active:before {
  border-color: rgba(57, 217, 138, 0.25);
}
.zen-rings.active:after {
  border-color: rgba(57, 217, 138, 0.12);
}
.zen-rings.pending {
  border-color: rgba(243, 180, 77, 0.35);
}
.zen-rings.pending:before {
  border-color: rgba(243, 180, 77, 0.18);
}
.zen-rings.active {
  animation: ringPulse 3s ease-in-out infinite;
}
@keyframes ringPulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(57, 217, 138, 0);
  }
  50% {
    box-shadow: 0 0 0 10px rgba(57, 217, 138, 0.08);
  }
}
.zen-rings.pending {
  animation: ringPending 2s ease-in-out infinite;
}
@keyframes ringPending {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(243, 180, 77, 0);
  }
  50% {
    box-shadow: 0 0 0 8px rgba(243, 180, 77, 0.08);
  }
}
.zen-power {
  width: 120px;
  height: 120px;
  z-index: 1;
  border: 1.5px solid #38413e;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: radial-gradient(circle at 40% 35%, #1f2628, #1b2122);
  color: #87928d;
  cursor: pointer;
  position: relative;
  transition:
    background 0.35s ease,
    border-color 0.35s ease,
    color 0.35s ease,
    transform 0.25s ease,
    box-shadow 0.35s ease;
}
.zen-power:hover:not(:disabled) {
  transform: scale(1.06);
  border-color: #39d98a;
  color: #39d98a;
  box-shadow: 0 0 20px rgba(57, 217, 138, 0.15);
}
.zen-power.active {
  background: radial-gradient(circle at 40% 35%, #1e4a34, #173426);
  border-color: #39d98a;
  color: #eafff2;
  box-shadow:
    0 0 28px rgba(57, 217, 138, 0.18),
    inset 0 0 20px rgba(57, 217, 138, 0.06);
}
.zen-power:disabled {
  cursor: wait;
}
.zen-power svg {
  width: 38px;
  height: 38px;
  transition: transform 0.3s ease;
}
.zen-power:hover:not(:disabled) svg {
  transform: scale(1.08);
}
.zen-spinner {
  position: absolute;
  inset: 6px;
  border: 2.5px solid transparent;
  border-top-color: #39d98a;
  border-radius: 50%;
  animation: spin 0.8s cubic-bezier(0.4, 0.15, 0.6, 0.85) infinite;
}
.zen-state {
  display: flex;
  align-items: center;
  flex-direction: column;
  margin-top: 22px;
}
.zen-state i {
  width: 10px;
  height: 10px;
  margin-bottom: 10px;
  border-radius: 50%;
  background: #64706b;
  transition:
    background 0.4s,
    box-shadow 0.4s;
}
.zen-state i.running {
  background: #39d98a;
  box-shadow:
    0 0 0 5px rgba(57, 217, 138, 0.15),
    0 0 12px rgba(57, 217, 138, 0.3);
  animation: dotBreath 2s ease-in-out infinite;
}
@keyframes dotBreath {
  0%,
  100% {
    box-shadow:
      0 0 0 4px rgba(57, 217, 138, 0.12),
      0 0 8px rgba(57, 217, 138, 0.2);
  }
  50% {
    box-shadow:
      0 0 0 8px rgba(57, 217, 138, 0.08),
      0 0 16px rgba(57, 217, 138, 0.35);
  }
}
.zen-state b {
  font-size: 15px;
}
.zen-state span {
  margin-top: 5px;
  color: #74807a;
  font-size: 12px;
}
.zen-details {
  width: min(720px, 100%);
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  margin-top: 24px;
  border: 1px solid var(--border, #292f32);
  border-radius: 8px;
  overflow: hidden;
  background: rgba(21, 25, 27, 0.5);
  backdrop-filter: blur(4px);
}
.zen-details > div {
  min-width: 0;
  padding: 14px 16px;
  border-right: 1px solid var(--border, #292f32);
}
.zen-details > div:last-child {
  border: 0;
}
.zen-details span,
.zen-details code,
.zen-details b {
  display: block;
}
.zen-details span {
  color: #6f7a75;
  font-size: 10px;
}
.zen-details code,
.zen-details b {
  margin-top: 5px;
  overflow-wrap: anywhere;
  font: 500 11px "IBM Plex Mono";
}
.zen-actions {
  display: flex;
  gap: 8px;
  margin-top: 20px;
}
.zen-actions .n-button {
  color: #77817d;
  transition:
    color 0.2s,
    transform 0.2s;
}
.zen-actions .n-button:hover {
  color: #39d98a;
  transform: scale(1.1);
}
.theme-light .zen-console {
  background: linear-gradient(170deg, #fff 0%, #f8faf9 50%, #f5f8f6 100%);
  border-color: #d8dedb;
}
.theme-light .zen-header {
  border-color: #e1e6e3;
  background: rgba(255, 255, 255, 0.7);
}
.theme-light .zen-rings,
.theme-light .zen-rings:before,
.theme-light .zen-rings:after,
.theme-light .zen-details,
.theme-light .zen-details > div {
  border-color: #d8dedb;
}
.theme-light .zen-power {
  background: radial-gradient(circle at 40% 35%, #f5f8f6, #f3f6f4);
  color: #52605a;
  border-color: #cdd6d1;
}
.theme-light .zen-power:hover:not(:disabled) {
  box-shadow: 0 0 16px rgba(35, 155, 97, 0.12);
}
.theme-light .zen-power.active {
  background: radial-gradient(circle at 40% 35%, #d4f0e0, #e5f5ec);
  color: #147848;
  border-color: #239b61;
  box-shadow:
    0 0 20px rgba(35, 155, 97, 0.15),
    inset 0 0 12px rgba(35, 155, 97, 0.06);
}
.theme-light .zen-details {
  background: rgba(255, 255, 255, 0.6);
}
.theme-light .row-actions .btn-start {
  color: #1d8a56;
}
.theme-light .row-actions .btn-stop {
  color: #b5842a;
}
.theme-light .row-actions .btn-edit {
  color: #3a7fc4;
}
.theme-light .row-actions .btn-delete {
  color: #c62828;
}
.theme-light .copy-btn {
  color: #52605a !important;
}
.theme-light .copy-btn:hover {
  color: #239b61 !important;
}
.theme-light .domain-cell .text-muted {
  color: #9ca8a3;
}
.theme-light .zen-actions .n-button {
  color: #52605a;
}
.theme-light .zen-actions .n-button:hover {
  color: #239b61;
}
@media (max-width: 720px) {
  .zen-console {
    min-height: calc(100dvh - 220px);
  }
  .zen-stage {
    min-height: 440px;
    padding: 18px 16px 24px;
  }
  .zen-rings {
    width: 180px;
    height: 180px;
  }
  .zen-power {
    width: 100px;
    height: 100px;
  }
  .zen-details {
    grid-template-columns: 1fr;
  }
  .zen-details > div {
    border-right: 0;
    border-bottom: 1px solid var(--border, #292f32);
  }
}
</style>
