<script lang="ts">
import type { SpeedTestResult } from "../types";

/**
 * 行内测速状态：由父组件持有并传入。
 * testing 期间 elapsed 由父组件的计时器驱动更新，无需组件自身维护时钟。
 */
export interface SpeedTestState {
  status: "testing" | "done" | "error";
  startedAt: number;
  elapsed: number;
  result?: SpeedTestResult;
  error?: string;
}
</script>

<script setup lang="ts">
import { computed } from "vue";
import { NTooltip } from "naive-ui";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine
} from "lucide-vue-next";
import type { SpeedSample } from "../types";

/**
 * 行内测速结果：仿大模型测速——点击后原地显示「测速中」，
 * 完成后行内展示 ↓/↑ 速率，详情与异常原因收进悬停提示。
 */
const props = defineProps<{ state?: SpeedTestState | null }>();

// 响应体小于该阈值时速率不代表带宽（例如只有几百字节的首页），需要警示。
const MEANINGFUL_BYTES = 256 * 1024;

// 速率保留三位有效数字即可：测速本身有抖动，多余的小数只会造成精度错觉。
const formatMbps = (mbps: number) =>
  mbps >= 100 ? mbps.toFixed(0) : mbps >= 10 ? mbps.toFixed(1) : mbps.toFixed(2);
const formatBytes = (bytes: number) =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(2)} MB`
    : bytes >= 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${bytes} B`;
const formatElapsed = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
const statusText = (status: number) => (status ? `HTTP ${status}` : "无响应");
// 服务端在超时前既没拿到响应也没发出去数据：没有速率可言，显示「—」而不是 0.00，
// 否则看起来像链路完全不通之外的其他含义。
const noResponse = (sample: SpeedSample) => sample.status === 0 && sample.bytes === 0;
// 错误页 / 无响应 / 极小响应都会让速率失去「带宽」含义，结果旁要点出警示。
const sampleWarn = (sample: SpeedSample) =>
  sample.status >= 400 || sample.status === 0 || sample.bytes < MEANINGFUL_BYTES;

const download = computed(() => props.state?.result?.download);
const upload = computed(() => props.state?.result?.upload);
const rows = computed(() => {
  const value = props.state?.result;
  if (!value) return [];
  const list: Array<{ key: string; label: string; sample: SpeedSample }> = [];
  if (value.download) list.push({ key: "down", label: "下行", sample: value.download });
  if (value.upload) list.push({ key: "up", label: "上行", sample: value.upload });
  return list;
});
const warned = computed(() => rows.value.some((row) => sampleWarn(row.sample)));
// 悬停提示里的说明：紧跟速率，点明为什么这次的数字不能按带宽解读。
const hint = computed(() => {
  const sample = props.state?.result?.download;
  if (!sample) return null;
  if (sample.status >= 400)
    return `目标返回 HTTP ${sample.status}，测到的是错误响应而不是隧道吞吐，请确认本地服务已启动。`;
  if (sample.status === 0)
    return "目标在等待时间内没有返回任何数据，隧道链路可能已中断。";
  if (sample.bytes < MEANINGFUL_BYTES)
    return "本次下行响应体过小，速率只反映当前目标内容，不代表隧道带宽。";
  return null;
});
const elapsedSeconds = computed(() =>
  Math.max(1, Math.round((props.state?.elapsed ?? 0) / 1000))
);
</script>

<template>
  <div v-if="state" class="speed-inline" :class="`is-${state.status}`">
    <!-- 进行中：旋转指示 + 已用时（测速最长可达 120s，必须让用户知道在动） -->
    <span v-if="state.status === 'testing'" class="speed-testing">
      <i class="speed-spinner" aria-hidden="true" />测速中 {{ elapsedSeconds }}s
    </span>
    <!-- 请求本身失败：短文案行内展示，全文放 title -->
    <span v-else-if="state.status === 'error'" class="speed-failed" :title="state.error">
      测速失败
    </span>
    <!-- 出结果：速率行内直读，详细采样数据与异常原因收进悬停提示 -->
    <NTooltip v-else placement="top" :style="{ maxWidth: '340px' }">
      <template #trigger>
        <span class="speed-nums">
          <span v-if="download" class="speed-num">
            <ArrowDownToLine :size="12" aria-hidden="true" />
            {{ noResponse(download) ? "—" : formatMbps(download.mbps) }}
          </span>
          <span v-if="upload" class="speed-num">
            <ArrowUpFromLine :size="12" aria-hidden="true" />
            {{ noResponse(upload) ? "—" : formatMbps(upload.mbps) }}
          </span>
          <span class="speed-unit">Mbps</span>
          <AlertTriangle v-if="warned" :size="12" class="speed-warn" aria-hidden="true" />
        </span>
      </template>
      <div class="speed-detail">
        <p v-for="row in rows" :key="row.key" class="speed-detail-row">
          <b>{{ row.label }}</b>
          <span>{{ statusText(row.sample.status) }} · {{ formatBytes(row.sample.bytes) }} · 用时 {{ formatElapsed(row.sample.elapsedMs) }}</span>
          <span v-if="row.sample.ttfbMs !== null">首字节 {{ row.sample.ttfbMs }} ms</span>
          <span v-if="row.sample.truncated">已截断</span>
        </p>
        <p v-if="hint" class="speed-detail-hint">{{ hint }}</p>
      </div>
    </NTooltip>
  </div>
</template>

<style scoped>
.speed-inline {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  font-size: 12px;
  line-height: 1.4;
}
.speed-testing {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
}
.speed-spinner {
  width: 11px;
  height: 11px;
  flex: none;
  border: 1.5px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: speedSpin 0.8s linear infinite;
}
@keyframes speedSpin {
  to {
    transform: rotate(1turn);
  }
}
.speed-failed {
  color: #e5695f;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.speed-nums {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-variant-numeric: tabular-nums;
  cursor: default;
}
.speed-num {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-weight: 500;
  color: var(--text-primary);
}
.speed-num svg {
  color: var(--accent);
}
.speed-unit {
  color: var(--text-muted);
}
.speed-warn {
  color: var(--amber);
  flex: none;
}
@media (prefers-reduced-motion: reduce) {
  .speed-spinner {
    animation: none;
  }
}
</style>

<style>
/* tooltip 弹层挂在 body 下，不能用 scoped */
.speed-detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.speed-detail-row {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  font-size: 12px;
}
.speed-detail-row b {
  font-weight: 500;
}
.speed-detail-hint {
  margin: 0;
  font-size: 12px;
  opacity: 0.85;
}
</style>
