<script setup lang="ts">
import { computed, ref } from "vue";
import { keepPreviousData, useQuery } from "@tanstack/vue-query";
import { NButton, NPagination, NTag } from "naive-ui";
import { Inbox, RefreshCw } from "lucide-vue-next";
import { api } from "../api/client";
import StateBlock from "./StateBlock.vue";
import type { BillingRecord, BillingRecordType } from "../types";

// 配额流水列表：scope=mine 显示本人流水（会员页），scope=all 显示全部用户（管理员账号页）。
// 组件自身不铺底色，外层由 .panel 控制内边距。
const props = defineProps<{ scope: "mine" | "all" }>();
const page = ref(1);
const pageSize = 8;
const query = useQuery({
  queryKey: computed(() => ["billing", props.scope, page.value]),
  queryFn: () => api.billing(page.value, pageSize),
  placeholderData: keepPreviousData
});
const typeMeta: Record<BillingRecordType, { label: string; tone: "accent" | "warn" | "danger" }> = {
  plan_purchase: { label: "购买套餐", tone: "accent" },
  plan_grant: { label: "开通套餐", tone: "accent" },
  invite_reward: { label: "邀请奖励", tone: "accent" },
  admin_adjust: { label: "管理员调整", tone: "warn" },
  plan_expired: { label: "套餐到期", tone: "danger" }
};
const items = computed(() => query.data.value?.items || []);
const total = computed(() => query.data.value?.total || 0);
const date = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
</script>

<template>
  <div class="billing">
    <div class="billing-head">
      <h2>{{ scope === "all" ? "全量配额流水" : "配额流水" }}</h2>
      <span class="billing-hint">隧道配额的每次变化都会记录在案</span>
      <n-button quaternary circle size="small" :aria-label="scope === 'all' ? '刷新全量流水' : '刷新我的流水'" @click="query.refetch()">
        <template #icon><RefreshCw :size="15" :class="{ spinning: query.isFetching.value }" /></template>
      </n-button>
    </div>
    <StateBlock v-if="query.isLoading.value || query.error.value" :loading="query.isLoading.value" :error="query.error.value?.message">
      <n-button v-if="query.error.value" @click="query.refetch()">重试</n-button>
    </StateBlock>
    <template v-else>
      <ul v-if="items.length" class="billing-list">
        <li v-for="row in items" :key="row.id" class="billing-row">
          <n-tag size="small" :bordered="false" :class="`tone-${typeMeta[row.type]?.tone || 'accent'}`">{{ typeMeta[row.type]?.label || row.type }}</n-tag>
          <div class="billing-main">
            <span class="billing-desc">{{ row.description }}</span>
            <span class="billing-meta">{{ scope === 'all' && row.username ? row.username + ' · ' : '' }}{{ date(row.createdAt) }}<template v-if="row.operatorName"> · 操作人 {{ row.operatorName }}</template></span>
          </div>
          <div class="billing-nums">
            <b :class="{ up: row.delta > 0, down: row.delta < 0 }">{{ row.delta > 0 ? "+" : "" }}{{ row.delta }} 条</b>
            <span>变后 {{ row.quotaAfter }} 条</span>
          </div>
        </li>
      </ul>
      <div v-else class="billing-empty"><Inbox :size="22" /><span>暂无配额变动记录</span></div>
      <div v-if="total > pageSize" class="billing-foot">
        <span>共 {{ total }} 条</span>
        <n-pagination v-model:page="page" :item-count="total" :page-size="pageSize" :page-slot="5" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.billing { display: flex; flex-direction: column; min-width: 0; min-height: 288px; }
.billing-head { display: flex; align-items: baseline; gap: 10px; padding-bottom: 14px; border-bottom: 1px solid var(--border-subtle); }
.billing-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
.billing-hint { font-size: 12px; color: var(--text-secondary); }
.billing-head .n-button { margin-left: auto; align-self: center; }
.billing-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; }
.billing-row { display: flex; align-items: center; gap: 12px; padding: 12px 2px; border-bottom: 1px solid var(--border-subtle); min-width: 0; }
.billing-row:last-child { border-bottom: none; }
.billing-row .n-tag { flex-shrink: 0; }
.tone-accent { background: rgba(var(--accent-rgb), .12); color: var(--accent); }
.tone-warn { background: rgba(var(--amber-rgb), .12); color: var(--amber); }
.tone-danger { background: rgba(var(--danger-rgb), .1); color: var(--danger); }
.billing-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.billing-desc { font-size: 13px; overflow-wrap: anywhere; }
.billing-meta { font-size: 11px; color: var(--text-secondary); }
.billing-nums { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-variant-numeric: tabular-nums; }
.billing-nums b { font-weight: 500; font-size: 13px; color: var(--text-primary); }
.billing-nums b.up { color: var(--accent); }
.billing-nums b.down { color: var(--danger); }
.billing-nums span { font-size: 11px; color: var(--text-secondary); }
.billing-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px 0; color: var(--text-muted); font-size: 12px; }
.billing-foot { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding-top: 14px; font-size: 12px; color: var(--text-secondary); }
.spinning { animation: billing-spin 1s linear infinite; }
@keyframes billing-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinning { animation: none; } }
@media (max-width: 560px) {
  .billing-row { flex-wrap: wrap; }
  .billing-main { flex-basis: 100%; order: 3; }
}
</style>
