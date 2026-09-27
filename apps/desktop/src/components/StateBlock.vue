<script setup lang="ts">
import { computed } from "vue";
import { AlertTriangle, Inbox, LoaderCircle } from "lucide-vue-next";
const props = defineProps<{ loading?: boolean; error?: string; empty?: boolean }>();
// 只有连接类错误才提示"启动本地 API"：业务错误（如"账号不可用"）配上
// 这句提示会误导用户去重启服务。
const isConnectionError = computed(() =>
  /fetch|network|econn|refused|timeout|超时|拒绝|网络|连接/i.test(props.error || "")
);
</script>
<template>
  <div v-if="loading || error || empty" class="state-block">
    <div class="state-icon">
      <LoaderCircle v-if="loading" class="spin" /><AlertTriangle
        v-else-if="error"
      /><Inbox v-else />
    </div>
    <b>{{ loading ? "正在同步数据" : error || "暂无数据" }}</b>
    <p v-if="error && isConnectionError">请确认本地 API 服务已启动后重试。</p>
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
  background: var(--surface-raised);
  color: var(--text-muted);
  margin-bottom: 16px;
}
.state-icon svg {
  width: 22px;
  height: 22px;
}
/* scoped 编译后带 data-v 属性选择器（特异性更高），
   用来压过 styles.css 中全局的 .theme-light .state-block 懒注入规则 */
.theme-light .state-icon {
  background: var(--surface-hover);
  color: var(--text-secondary);
}
</style>
