<script setup lang="ts">
import { computed } from "vue";
import { NButton, NTag } from "naive-ui";
import { Cable, CalendarDays, Pencil, ShoppingCart } from "lucide-vue-next";
import type { MembershipPlan } from "../types";

const props = defineProps<{ plan: MembershipPlan; admin: boolean; membershipActive?: boolean }>();
const emit = defineEmits<{ edit: [plan: MembershipPlan]; buy: [plan: MembershipPlan] }>();
const price = computed(() => (props.plan.priceCents / 100).toFixed(2).split("."));
// 免费套餐在已有生效套餐时不可领取（服务端同样校验），付费套餐随时可购买续费。
const freeLocked = computed(() => props.plan.priceCents <= 0 && props.membershipActive === true);
</script>

<template>
  <article class="panel plan-card" :class="{ 'plan-card--disabled': !plan.enabled }">
    <div class="plan-heading">
      <h3>{{ plan.name }}</h3>
      <n-tag v-if="!plan.enabled" size="small" :bordered="false">已停用</n-tag>
    </div>
    <p class="plan-description" :title="plan.description">{{ plan.description || '按需选择隧道配额' }}</p>
    <div class="plan-price" :class="{ 'plan-price--long': price[0]!.length > 5 }" :aria-label="`${price.join('.')} 元，${plan.durationDays} 天`">
      <span class="currency">¥</span><strong>{{ price[0] }}</strong><span class="decimal">.{{ price[1] }}</span>
    </div>
    <dl class="plan-benefits">
      <div><dt><Cable :size="15" aria-hidden="true"/>隧道配额</dt><dd><strong>{{ plan.tunnelQuota }}</strong> 条</dd></div>
      <div><dt><CalendarDays :size="15" aria-hidden="true"/>有效期</dt><dd><strong>{{ plan.durationDays }}</strong> 天</dd></div>
    </dl>
    <div class="plan-action">
      <n-button v-if="admin" block :aria-label="`编辑${plan.name}套餐`" @click="emit('edit', plan)">
        <template #icon><Pencil :size="14"/></template>编辑套餐
      </n-button>
      <n-button v-else-if="plan.enabled" type="primary" block :disabled="freeLocked" :title="freeLocked ? '已有生效中的套餐，免费套餐需在到期后才能再次开通' : undefined" :aria-label="`开通${plan.name}套餐`" @click="emit('buy', plan)">
        <template #icon><ShoppingCart :size="14"/></template>{{ freeLocked ? '套餐生效中' : plan.priceCents > 0 ? '支付宝购买' : '免费开通' }}
      </n-button>
      <span v-else>暂不可开通</span>
    </div>
  </article>
</template>

<style scoped>
.plan-card { min-width: 0; min-height: 0; padding: 20px; display: flex; flex-direction: column; transition: border-color .18s ease; }
.plan-card:hover { border-color: var(--text-muted); }
.plan-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.plan-heading h3 { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.plan-heading :deep(.n-tag) { flex-shrink: 0; }
.plan-description { margin: 6px 0 0; height: 36px; color: var(--text-secondary); font-size: 12px; line-height: 18px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.plan-price { display: flex; align-items: baseline; gap: 0; margin: 12px 0 16px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.currency { margin-right: 4px; font-size: 18px; color: var(--text-secondary); }
.plan-price strong { font-size: 36px; line-height: 1; font-weight: 600; letter-spacing: -1px; }
.decimal { font-size: 22px; font-weight: 500; }
.plan-price--long strong { font-size: 26px; }
.plan-price--long .decimal { font-size: 16px; }
.plan-benefits { margin: auto 0 0; padding-top: 12px; border-top: 1px solid var(--border-subtle); display: grid; gap: 10px; }
.plan-benefits > div { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.plan-benefits dt { display: flex; align-items: center; gap: 7px; color: var(--text-secondary); font-size: 12px; }
.plan-benefits dt svg { color: var(--accent); }
.plan-benefits dd { margin: 0; font-size: 12px; white-space: nowrap; }
.plan-benefits dd strong { font-size: 14px; font-weight: 500; }
.plan-action { margin-top: 16px; }
.plan-action > span { display: block; text-align: center; padding: 8px 0; font-size: 12px; color: var(--text-secondary); }
.plan-card--disabled .plan-benefits dt svg { color: var(--text-muted); }
@media (prefers-reduced-motion: reduce) { .plan-card { transition: none; } }
</style>
