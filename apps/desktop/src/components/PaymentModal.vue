<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { NButton, NModal } from "naive-ui";
import { CircleCheck, RefreshCw, Wallet } from "lucide-vue-next";
import QRCode from "qrcode";
import { api } from "../api/client";
import type { PaymentOrder } from "../types";

// 支付宝当面付扫码弹窗：展示服务端返回的二维码内容并轮询订单状态，
// 服务端每次轮询都会向支付宝主动查单对账，前端不自行判断支付结果。
const props = defineProps<{ show: boolean; order: PaymentOrder | null }>();
const emit = defineEmits<{ close: []; paid: [order: PaymentOrder] }>();
const latest = ref<PaymentOrder | null>(props.order);
const qr = ref("");
const checking = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;
let generation = 0;

function stopPolling() {
  if (timer) { clearInterval(timer); timer = undefined; }
  checking.value = false;
}

watch(() => [props.show, props.order?.id] as const, async ([show]) => {
  generation += 1;
  stopPolling();
  latest.value = props.order;
  if (!show || !props.order) return;
  try {
    qr.value = props.order.qrCode ? await QRCode.toDataURL(props.order.qrCode, { margin: 1, width: 220, errorCorrectionLevel: "M" }) : "";
  } catch { qr.value = ""; }
  if (props.order.status === "created") startPolling();
}, { immediate: true });

watch(() => props.show, show => { if (!show) stopPolling(); });
onBeforeUnmount(stopPolling);

function startPolling() {
  const current = generation;
  checking.value = true;
  timer = setInterval(async () => {
    if (!latest.value?.id) return stopPolling();
    try {
      const order = await api.billingOrder(latest.value.id);
      if (current !== generation) return;
      latest.value = order;
      if (order.status === "paid") { stopPolling(); emit("paid", order); }
      else if (order.status === "expired") stopPolling();
    } catch { /* 网络抖动继续下一轮轮询 */ }
  }, 3000);
}

const price = () => ((latest.value?.amountCents || 0) / 100).toFixed(2);
</script>

<template>
  <n-modal :show="show" preset="card" title="支付宝扫码支付" style="width:min(380px,calc(100vw - 32px))" :mask-closable="latest?.status !== 'paid'" :closable="true" @update:show="value => !value && emit('close')">
    <div v-if="latest" class="pay-body">
      <template v-if="latest.status === 'paid'">
        <CircleCheck :size="44" class="pay-success" />
        <p class="pay-amount">¥{{ price() }}</p>
        <p class="pay-note">支付成功，套餐已开通</p>
      </template>
      <template v-else-if="latest.status === 'expired'">
        <Wallet :size="40" class="pay-expired" />
        <p class="pay-amount">¥{{ price() }}</p>
        <p class="pay-note">二维码已过期，请关闭后重新下单</p>
        <n-button @click="emit('close')">关闭</n-button>
      </template>
      <template v-else>
        <p class="pay-amount">¥{{ price() }}</p>
        <div class="pay-qr">
          <img v-if="qr" :src="qr" alt="支付宝收款二维码" width="220" height="220" />
          <div v-else class="pay-qr-fallback">二维码加载失败，请关闭后重试</div>
        </div>
        <p class="pay-note">请使用支付宝 App 扫一扫完成付款</p>
        <p class="pay-checking"><RefreshCw :size="13" :class="{ spinning: checking }" />{{ checking ? "正在确认支付结果…" : "等待扫码支付" }}</p>
      </template>
    </div>
  </n-modal>
</template>

<style scoped>
.pay-body { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 0 4px; }
.pay-success { color: var(--success, var(--accent)); margin-bottom: 4px; }
.pay-expired { color: var(--amber); margin-bottom: 4px; }
.pay-amount { margin: 0; font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
.pay-qr { padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); background: #fff; margin: 10px 0; }
.pay-qr img { display: block; }
.pay-qr-fallback { width: 220px; height: 220px; display: flex; align-items: center; justify-content: center; text-align: center; padding: 16px; font-size: 12px; color: var(--text-secondary); }
.pay-note { margin: 2px 0 0; font-size: 12px; color: var(--text-secondary); }
.pay-checking { margin: 8px 0 0; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); }
.spinning { animation: pay-spin 1s linear infinite; }
@keyframes pay-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinning { animation: none; } }
</style>
