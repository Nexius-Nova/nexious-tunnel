<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { invoke } from "@tauri-apps/api/core";
import {
  NConfigProvider,
  NDialogProvider,
  NIcon,
  NLayout,
  NLayoutContent,
  NLayoutSider,
  NMenu,
  NMessageProvider,
  NNotificationProvider,
  darkTheme,
  type MenuOption
} from "naive-ui";
import {
  Activity,
  Cable,
  ChevronLeft,
  CircleGauge,
  MapPin,
  Minus,
  Moon,
  Settings,
  Square,
  Sun,
  X,
  Zap
} from "lucide-vue-next";
import { useRoute, useRouter } from "vue-router";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api/client";

const collapsed = ref(false),
  route = useRoute(),
  router = useRouter(),
  isDark = ref(localStorage.getItem("nexious-theme") !== "light"),
  transitioning = ref(false);

function toggleTheme() {
  transitioning.value = true;
  isDark.value = !isDark.value;
  localStorage.setItem("nexious-theme", isDark.value ? "dark" : "light");
  setTimeout(() => {
    transitioning.value = false;
  }, 350);
}
function syncTheme(event:Event) {
  isDark.value=(event as CustomEvent<string>).detail==="dark";
}
onMounted(()=>window.addEventListener("nexious-theme-change",syncTheme));
onBeforeUnmount(()=>window.removeEventListener("nexious-theme-change",syncTheme));

const isTauri =
  typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
const appWindow = isTauri ? getCurrentWindow() : null;
async function winMinimize() {
  await appWindow?.minimize();
}
async function winToggleMax() {
  if (!appWindow) return;
  const maximized = await appWindow.isMaximized();
  await (maximized ? appWindow.unmaximize() : appWindow.maximize());
}
async function winClose() {
  await appWindow?.close();
}
async function onTitlebarDown(e: MouseEvent) {
  // Only start drag on left click, and not on buttons
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest("button")) return;
  await appWindow?.startDragging();
}

const icon = (component: unknown) => () =>
  h(NIcon, null, { default: () => h(component as never) });
// 侧栏控制中心状态：真实轮询健康检查，不再硬编码“在线”文案。
const controlCenterHost = ref("127.0.0.1:8787");
const healthQuery = useQuery({
  queryKey: ["control-center-health"],
  queryFn: () => api.health(),
  refetchInterval: 15000,
  retry: false,
  staleTime: 10000
});
const controlOnline = computed(() => healthQuery.data.value?.ok === true);
onMounted(async () => {
  try {
    const preferences = await invoke<{ apiUrl?: string; api_url?: string }>(
      "get_desktop_preferences"
    );
    const apiUrl = preferences.apiUrl ?? preferences.api_url ?? "";
    if (apiUrl) controlCenterHost.value = apiUrl.replace(/^https?:\/\//, "");
  } catch {
    // 浏览器开发环境没有 Tauri IPC，保留默认展示
  }
});
const menu: MenuOption[] = [
  { label: "隧道管理", key: "/tunnels", icon: icon(Cable) },
  { label: "边缘节点", key: "/nodes", icon: icon(MapPin) },
  { label: "运行总览", key: "/dashboard", icon: icon(CircleGauge) },
  { type: "divider", key: "d" },
  { label: "偏好设置", key: "/settings", icon: icon(Settings) }
];
const mobileMenu = [
  { label: "隧道", path: "/tunnels", icon: Cable },
  { label: "节点", path: "/nodes", icon: MapPin },
  { label: "总览", path: "/dashboard", icon: CircleGauge },
  { label: "设置", path: "/settings", icon: Settings }
];
const active = computed(() => route.path);
const themeOverrides = {
  common: {
    primaryColor: "#239b61",
    primaryColorHover: "#2ebd78",
    primaryColorPressed: "#187a4b",
    borderRadius: "8px",
    fontFamily: "'IBM Plex Sans','Microsoft YaHei',sans-serif"
  }
};
watch(
  isDark,
  (dark) => {
    document.body.style.backgroundColor = dark ? "#101315" : "#f3f5f4";
    document.body.classList.toggle("theme-light", !dark);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? "#101315" : "#f3f5f4");
  },
  { immediate: true }
);
</script>
<template>
  <n-config-provider
    :theme="isDark ? darkTheme : null"
    :theme-overrides="themeOverrides"
  >
    <n-dialog-provider
      ><n-notification-provider
        ><n-message-provider>
          <div
            class="shell"
            :class="{
              'theme-light': !isDark,
              'theme-transitioning': transitioning
            }"
          >
            <!-- Custom Title Bar -->
            <div
              class="titlebar"
              :class="{ 'theme-light': !isDark }"
              @mousedown="onTitlebarDown"
            >
              <div class="titlebar-left">
                <div class="titlebar-mark">
                  <Zap :size="14" fill="currentColor" />
                </div>
                <span>Nexious Tunnel</span>
              </div>
              <div class="titlebar-controls">
                <button class="tb-btn" @click="winMinimize" title="最小化">
                  <Minus :size="14" />
                </button>
                <button class="tb-btn" @click="winToggleMax" title="最大化">
                  <Square :size="12" />
                </button>
                <button class="tb-btn tb-close" @click="winClose" title="关闭">
                  <X :size="14" />
                </button>
              </div>
            </div>
            <n-layout has-sider class="shell-body">
              <n-layout-sider
                bordered
                collapse-mode="width"
                :collapsed-width="72"
                :width="232"
                :collapsed="collapsed"
                class="sidebar"
              >
                <div class="brand" :class="{ compact: collapsed }">
                  <div class="brand-mark">
                    <Zap :size="20" fill="currentColor" />
                  </div>
                  <div v-if="!collapsed">
                    <strong>NEXIOUS</strong><span>TUNNEL</span>
                  </div>
                  <button
                    v-if="!collapsed"
                    class="theme-button"
                    :aria-label="isDark ? '切换到白色主题' : '切换到黑色主题'"
                    :title="isDark ? '白色主题' : '黑色主题'"
                    @click="toggleTheme"
                  >
                    <Sun v-if="isDark" :size="16" /><Moon v-else :size="16" />
                  </button>
                </div>
                <n-menu
                  :collapsed="collapsed"
                  :collapsed-width="72"
                  :collapsed-icon-size="21"
                  :value="active"
                  :options="menu"
                  @update:value="(v: string) => router.push(v)"
                />
                <button
                  class="collapse-button"
                  :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
                  :title="collapsed ? '展开侧栏' : '收起侧栏'"
                  @click="collapsed = !collapsed"
                >
                  <ChevronLeft :size="17" :class="{ flip: collapsed }" />
                </button>
                <div
                  v-if="!collapsed"
                  class="daemon"
                  :class="{ offline: !controlOnline }"
                >
                  <i></i>
                  <div>
                    <b>{{ controlOnline ? "控制中心在线" : "控制中心离线" }}</b>
                    <span>{{ controlCenterHost }}</span>
                  </div>
                  <Activity :size="16" />
                </div>
              </n-layout-sider>
              <n-layout
                ><n-layout-content
                  ><router-view /></n-layout-content
              ></n-layout>
            </n-layout>
            <nav class="mobile-nav">
              <button
                v-for="item in mobileMenu"
                :key="item.path"
                :class="{ active: active === item.path }"
                @click="router.push(item.path)"
              >
                <component :is="item.icon" /><span>{{ item.label }}</span>
              </button>
            </nav>
          </div>
        </n-message-provider></n-notification-provider
      ></n-dialog-provider
    >
  </n-config-provider>
</template>
