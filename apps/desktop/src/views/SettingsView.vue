<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/vue-query";
import { NAlert, NButton, NInputNumber, NSwitch, useMessage } from "naive-ui";
import { MonitorUp, Moon, PanelTopClose, Save } from "lucide-vue-next";
import type { Preferences } from "../types";
import PageHeader from "../components/PageHeader.vue";
import StateBlock from "../components/StateBlock.vue";
import ThemeStylePicker from "../components/ThemeStylePicker.vue";
import { setThemeMode, themeLight } from "../theme";

const message = useMessage();
const queryClient = useQueryClient();
const native = isTauri();
const loadError = ref("");
const loading = ref(true),
  saving = ref(false);
const form = reactive<Preferences>({
  autoStart: false,
  minimizeToTray: true,
  apiUrl: "https://8.134.156.74:8443",
  maxBodyMb: 25,
  logRetentionDays: 30,
  trafficRetentionDays: 90
});
const saved = ref<Preferences>({ ...form });
// 逐字段比较：JSON.stringify 对键序敏感，且会把用户无法编辑的
// apiUrl/maxBodyMb 一并纳入，服务端返回的键序差异就会造成"未修改却提示已修改"。
const changed = computed(
  () =>
    form.logRetentionDays !== saved.value.logRetentionDays ||
    form.trafficRetentionDays !== saved.value.trafficRetentionDays
);
const items = [
  {
    key: "autoStart" as const,
    title: "开机自动启动",
    desc: "登录 Windows 后自动运行 Nexious Tunnel",
    icon: MonitorUp
  },
  {
    key: "minimizeToTray" as const,
    title: "关闭时驻留托盘",
    desc: "关闭主窗口时保持隧道在后台运行，可从系统托盘重新打开",
    icon: PanelTopClose
  }
];

async function loadPreferences() {
  if (!native) { loading.value = false; return; }
  loading.value = true; loadError.value = "";
  try {
    const value = await invoke<Preferences>("get_desktop_preferences");
    Object.assign(form, value);
    saved.value = { ...value };
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}
onMounted(loadPreferences);

async function save() {
  if (!native || saving.value || loadError.value) return;
  saving.value = true;
  try {
    const value = await invoke<Preferences>("set_desktop_preferences", {
      preferences: { ...form }
    });
    Object.assign(form, value);
    saved.value = { ...value };
    queryClient.clear();
    message.success("桌面设置已生效");
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    saving.value = false;
  }
}
async function updateDesktopPreference(
  key: "autoStart" | "minimizeToTray",
  value: boolean
) {
  if (!native || saving.value || loadError.value) return;
  const previous = form[key];
  form[key] = value;
  saving.value = true;
  try {
    const persisted = await invoke<Preferences>("set_desktop_preferences", {
      preferences: { ...form }
    });
    Object.assign(form, persisted);
    saved.value = { ...persisted };
    message.success("设置已保存");
  } catch (error) {
    form[key] = previous;
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    saving.value = false;
  }
}
function setTheme(value:boolean) {
  setThemeMode(!value);
}
</script>

<template>
  <div class="view settings-view">
    <PageHeader
      title="偏好设置"
      :description="native ? '控制客户端的启动方式与后台运行行为。' : '设置当前浏览器的界面偏好。'"
    />
    <StateBlock v-if="loading" loading />
    <StateBlock v-else-if="loadError" :error="loadError"><n-button @click="loadPreferences">重试</n-button></StateBlock>
    <template v-else>
      <n-alert v-if="!native" type="info" :bordered="false" class="browser-preferences">启动与后台运行设置请在桌面客户端中修改。</n-alert>
      <section class="settings-panel">
        <h2>主题风格</h2>
        <ThemeStylePicker />
      </section>
      <section class="settings-panel">
        <h2>{{ native ? '桌面偏好' : '界面偏好' }}</h2>
        <div class="setting-row">
          <i><Moon /></i>
          <div><b>深色主题</b><span>切换当前设备上的深浅色界面模式</span></div>
          <n-switch :value="themeLight" aria-label="深色主题" @update:value="setTheme" />
        </div>
        <div v-for="item in native ? items : []" :key="item.key" class="setting-row">
          <i><component :is="item.icon" /></i>
          <div>
            <b>{{ item.title }}</b
            ><span>{{ item.desc }}</span>
          </div>
          <n-switch
            :value="form[item.key]"
            :disabled="saving"
            :aria-label="item.title"
            @update:value="updateDesktopPreference(item.key, $event)"
          />
        </div>
      </section>
      <section v-if="native" class="settings-panel">
        <h2>本地服务</h2>
        <p class="section-description">作用于本机内置的控制中心服务，保存后自动重启生效。</p>
        <div class="setting-row">
          <div><b>访问日志保留天数</b><span>后台自动清理过期日志</span></div>
          <n-input-number
            v-model:value="form.logRetentionDays"
            class="number-input"
            :min="1"
            :max="3650"
            :disabled="saving"
            aria-label="访问日志保留天数"
          ><template #suffix>天</template></n-input-number>
        </div>
        <div class="setting-row">
          <div><b>流量统计保留天数</b><span>后台自动清理过期流量记录</span></div>
          <n-input-number
            v-model:value="form.trafficRetentionDays"
            class="number-input"
            :min="1"
            :max="3650"
            :disabled="saving"
            aria-label="流量统计保留天数"
          ><template #suffix>天</template></n-input-number>
        </div>
      </section>
      <section v-if="native" class="settings-panel server-settings">
        <h2>控制中心</h2>
        <p class="section-description">客户端固定连接本机内置的控制中心，无需手动配置地址；边缘节点凭据在“边缘节点”页面维护。</p>
      </section>
    </template>
    <transition name="save-pill">
      <div v-if="native && !loadError && changed" class="save-pill">
        <span>有未保存的更改</span>
        <n-button type="primary" :loading="saving" @click="save"
          ><template #icon><Save /></template>保存设置</n-button
        >
      </div>
    </transition>
  </div>
</template>

<style scoped>
.browser-preferences { margin-bottom: 20px; }
/* 悬浮保存按钮：仅在存在未保存更改时出现，任何滚动位置都可见，保存后消失 */
.save-pill {
  position: fixed;
  right: 32px;
  bottom: 24px;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px 10px 16px;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: #1a201f;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
}
.save-pill span {
  font-size: 12px;
  color: var(--text-secondary);
}
.save-pill-enter-active,
.save-pill-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.save-pill-enter-from,
.save-pill-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
:global(.theme-light) .save-pill {
  background: #ffffff;
  border-color: var(--border);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.14);
}
@media (max-width: 700px) {
  .save-pill {
    right: 16px;
    bottom: 84px;
  }
}
/* 紧凑行高，整页控制在一屏内 */
.settings-view :deep(.setting-row) {
  min-height: 0;
  padding: 12px 18px;
}
.settings-view :deep(.settings-panel h2) {
  padding: 12px 18px 10px;
}
.section-description{margin:0;padding:12px 18px 0;color:var(--text-secondary);font-size:12px}
.settings-panel .setting-row > div{flex:1;min-width:0}
.settings-panel .setting-row > div b{display:block;font-size:13px}
.settings-panel .setting-row > div span{display:block;margin-top:3px;color:var(--text-secondary);font-size:11px}
.number-input{width:150px}
</style>
