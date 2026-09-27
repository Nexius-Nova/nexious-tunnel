<script setup lang="ts">
import { computed } from "vue";
import { NButton, NTag } from "naive-ui";
import { CalendarDays, Pencil } from "lucide-vue-next";
import type { ReferralCampaign } from "../types";

const props = defineProps<{ campaign: ReferralCampaign; admin: boolean; now: number }>();
defineEmits<{ edit: [campaign: ReferralCampaign] }>();
const status = computed(() => !props.campaign.enabled ? '已停用' : props.now < Date.parse(props.campaign.startsAt) ? '未开始' : props.now >= Date.parse(props.campaign.endsAt) ? '已结束' : '进行中');
const day = (value: string) => new Date(value).toLocaleDateString('zh-CN');
</script>

<template>
  <article class="campaign-card">
    <div class="campaign-heading">
      <h3>{{ campaign.name }}</h3>
      <n-tag size="small" :bordered="false" :type="status === '进行中' ? 'success' : status === '未开始' ? 'warning' : 'default'">{{ status }}</n-tag>
    </div>
    <div class="campaign-rewards">
      <div><span>邀请人奖励</span><p><strong>+{{ campaign.inviterBonus }}</strong> 条隧道</p></div>
      <div><span>受邀人奖励</span><p><strong>+{{ campaign.inviteeBonus }}</strong> 条隧道</p></div>
    </div>
    <p class="campaign-limit">永久隧道配额 · 每人最多奖励 {{ campaign.maxRewards }} 次</p>
    <div class="campaign-footer">
      <span class="campaign-period" :title="`${campaign.startsAt} — ${campaign.endsAt}`"><CalendarDays :size="14" aria-hidden="true"/>{{ day(campaign.startsAt) }} — {{ day(campaign.endsAt) }}</span>
      <n-button v-if="admin" size="small" :aria-label="`编辑${campaign.name}活动`" @click="$emit('edit', campaign)"><template #icon><Pencil :size="13"/></template>编辑</n-button>
    </div>
  </article>
</template>

<style scoped>
.campaign-card { border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; min-width: 0; }
.campaign-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
h3 { margin: 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.campaign-heading :deep(.n-tag) { flex-shrink: 0; }
.campaign-rewards { display: grid; grid-template-columns: 1fr 1fr; margin-top: 20px; }
.campaign-rewards > div + div { border-left: 1px solid var(--border-subtle); padding-left: 18px; }
.campaign-rewards span, .campaign-limit, .campaign-period { font-size: 12px; color: var(--text-secondary); }
.campaign-rewards p { margin: 6px 0 0; font-size: 12px; }
.campaign-rewards strong { color: var(--accent); font-size: 26px; font-weight: 600; }
.campaign-limit { margin: 14px 0 16px; line-height: 1.7; }
.campaign-footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-top: 1px solid var(--border-subtle); padding-top: 12px; flex-wrap: wrap; }
.campaign-period { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
</style>
