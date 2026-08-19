<script setup lang="ts">
import { AlertTriangle, Inbox, LoaderCircle } from "lucide-vue-next";
defineProps<{ loading?: boolean; error?: string; empty?: boolean }>();
</script>
<template>
  <div v-if="loading || error || empty" class="state-block">
    <div class="state-icon">
      <LoaderCircle v-if="loading" class="spin" /><AlertTriangle
        v-else-if="error"
      /><Inbox v-else />
    </div>
    <b>{{ loading ? "正在同步数据" : error || "暂无数据" }}</b>
    <p v-if="error">请确认本地 API 服务已启动后重试。</p>
    <slot />
  </div>
</template>

<style scoped>
.state-icon {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: #1a1f22;
  color: #717c77;
  margin-bottom: 16px;
}
.state-icon svg {
  width: 22px;
  height: 22px;
}
</style>
