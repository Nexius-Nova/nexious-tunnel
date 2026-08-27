<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { NButton, NFormItem, NInput, NSwitch, useMessage } from "naive-ui";
import { MonitorUp, Moon, PanelTopClose, Save, Settings2 } from "lucide-vue-next";
import type { Preferences } from "../types";
import PageHeader from "../components/PageHeader.vue";
import StateBlock from "../components/StateBlock.vue";

const message = useMessage();
const darkMode = ref(localStorage.getItem("nexious-theme") !== "light");
const loading = ref(true),
  saving = ref(false);
const form = reactive<Preferences>({
  autoStart: false,
  minimizeToTray: true,
  apiUrl: "http://127.0.0.1:8787",
  apiToken: ""
});
const saved = ref<Preferences>({ ...form });
const changed = computed(
  () => JSON.stringify(form) !== JSON.stringify(saved.value)
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

onMounted(async () => {
  try {
    const value = await invoke<Preferences>("get_desktop_preferences");
    Object.assign(form, value);
    saved.value = { ...value };
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
});

async function save() {
  saving.value = true;
  try {
    const value = await invoke<Preferences>("set_desktop_preferences", {
      preferences: { ...form }
    });
    Object.assign(form, value);
    saved.value = { ...value };
    message.success("桌面设置已生效");
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    saving.value = false;
  }
}
function setTheme(value:boolean) {
  darkMode.value=value;
  localStorage.setItem("nexious-theme",value?"dark":"light");
  window.dispatchEvent(new CustomEvent("nexious-theme-change",{detail:value?"dark":"light"}));
}
</script>

<template>
  <div class="view settings-view">
    <PageHeader
      eyebrow="DESKTOP CONTROL"
      title="偏好设置"
      description="控制客户端的启动方式与后台运行行为。"
    />
    <StateBlock v-if="loading" loading />
    <template v-else>
      <section class="settings-summary">
        <div class="summary-icon"><Settings2 /></div>
        <div>
          <b>桌面集成</b><span>这些设置仅作用于当前设备，保存后立即生效。</span>
        </div>
        <i>WINDOWS</i>
      </section>
      <section class="settings-panel">
        <h2>桌面偏好</h2>
        <div class="setting-row">
          <i><Moon /></i>
          <div><b>深色主题</b><span>切换当前设备上的黑白界面主题</span></div>
          <n-switch :value="darkMode" aria-label="深色主题" @update:value="setTheme" />
        </div>
        <div v-for="item in items" :key="item.key" class="setting-row">
          <i><component :is="item.icon" /></i>
          <div>
            <b>{{ item.title }}</b
            ><span>{{ item.desc }}</span>
          </div>
          <n-switch v-model:value="form[item.key]" :aria-label="item.title" />
        </div>
      </section>
      <section class="settings-panel server-settings">
        <h2>主控制中心</h2>
        <p class="section-description">用于读取和管理全部边缘节点及隧道。每个节点的独立连接凭据在“边缘节点”页面维护。</p>
        <div class="server-form">
          <n-form-item label="主控制中心 API 地址"
            ><n-input
              v-model:value="form.apiUrl"
                placeholder="https://relay.example.com"
          /></n-form-item>
          <n-form-item label="主控制中心 Token"
            ><n-input
              v-model:value="form.apiToken"
              type="password"
              show-password-on="click"
              placeholder="填写服务器管理 Token"
          /></n-form-item>
        </div>
      </section>
      <div class="save-bar">
        <span>{{ changed ? "有尚未保存的更改" : "所有设置均已保存" }}</span>
        <n-button
          type="primary"
          :disabled="!changed"
          :loading="saving"
          @click="save"
          ><template #icon><Save /></template>保存设置</n-button
        >
      </div>
    </template>
  </div>
</template>

<style scoped>
.settings-summary {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
  padding: 16px 18px;
  border: 1px solid rgba(35, 155, 97, 0.18);
  border-radius: 8px;
  background: rgba(35, 155, 97, 0.06);
}
.summary-icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(57, 217, 138, 0.28);
  border-radius: 6px;
  color: #39d98a;
  background: rgba(35, 155, 97, 0.08);
}
.summary-icon svg {
  width: 18px;
}
.settings-summary > div:nth-child(2) {
  flex: 1;
  min-width: 0;
}
.settings-summary b,
.settings-summary span {
  display: block;
}
.settings-summary b {
  font-size: 13px;
}
.settings-summary span {
  margin-top: 4px;
  color: #74807a;
  font-size: 11px;
}
.settings-summary > i {
  font: 500 10px "IBM Plex Mono";
  font-style: normal;
  letter-spacing: 1.5px;
  color: #39d98a;
}
.server-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  padding: 18px 20px;
}
.server-form :deep(.n-form-item) {
  margin: 0;
}
.section-description{margin:0;padding:14px 20px 0;color:var(--text-secondary);font-size:12px}
@media (max-width: 700px) {
  .server-form {
    grid-template-columns: 1fr;
  }
  .settings-summary > i {
    display: none;
  }
  .settings-summary {
    align-items: flex-start;
  }
  .save-bar {
    align-items: stretch;
    flex-direction: column;
    gap: 12px;
  }
  .save-bar :deep(.n-button) {
    width: 100%;
  }
}
</style>
