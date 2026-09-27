<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import {
  NConfigProvider,
  NDialogProvider,
  NIcon,
  NLayout,
  NLayoutContent,
  NLayoutSider,
  NMenu,
  NMessageProvider,
  NModal,
  NNotificationProvider,
  darkTheme,
  dateZhCN,
  zhCN,
  type MenuOption
} from "naive-ui";
import {
  Crown,
  Cable,
  ChevronLeft,
  CircleGauge,
  LogOut,
  MapPin,
  Minus,
  Moon,
  Settings,
  ShieldCheck,
  Square,
  Sun,
  X,
  Zap
} from "lucide-vue-next";
import { useRoute, useRouter } from "vue-router";
import LoginView from "./views/LoginView.vue";
import TitleBar from "./components/TitleBar.vue";
import ReauthenticateModal from "./components/ReauthenticateModal.vue";
import { resumeLifecycleGuards } from "./composables/useTunnelLifecycle";
import {
  currentUser,
  displayName,
  isAdmin,
  isAuthenticated,
  logout,
  refreshIdentity,
  mustChangePassword
} from "./session";
import { currentThemeStyle, naiveButtonTokens, naiveCommonTokens, setThemeMode, themeLight, themeStyleId } from "./theme";

const queryClient = useQueryClient();
const collapsed = ref(false),
  route = useRoute(),
  router = useRouter(),
  // 深浅色状态由 theme.ts 统一持有，切换时通过事件广播同步所有消费方
  isDark = computed(() => !themeLight.value),
  transitioning = ref(false);
let themeTimer: number | undefined;

// 启动时先确认身份，再决定显示登录页还是主界面。
// 期间显示启动占位，避免已登录用户看到登录页「闪一下」。
const sessionReady = ref(false);

async function bootstrapSession() {
  try {
    const result = await refreshIdentity();
    if (result === "anonymous" && !mustChangePassword.value) {
      // 没有会话时停留在此，由模板渲染登录页。
    }
  } finally {
    sessionReady.value = true;
  }
}

async function onSignedIn() {
  sessionReady.value = true;
  resumeLifecycleGuards();
  // 切换身份后清空缓存，避免上一个账号的数据残留。
  queryClient.clear();
  if (route.path === "/accounts" && !isAdmin.value) await router.replace("/tunnels");
}

async function signOut() {
  // stop_all_agents 与守护挂起统一收敛在 session.logout()，登录页的返回/切换账号路径同样生效。
  try { await logout(); } catch { /* 离线时仍退出本机登录状态 */ }
  finally { queryClient.clear(); await router.replace("/tunnels"); }
}

// 退出登录是破坏性操作（会停止本机隧道代理），点击后先弹确认框。
const signOutConfirm = ref(false);
const signingOut = ref(false);
async function confirmSignOut() {
  signingOut.value = true;
  try { await signOut(); }
  finally { signingOut.value = false; signOutConfirm.value = false; }
}
// 返回 false 阻止弹窗自动关闭，等待退出完成后再收起，期间按钮保持 loading。
function onSignOutPositive(): false {
  void confirmSignOut();
  return false;
}
watch(() => currentUser.value?.id, () => queryClient.clear());

// 普通用户不应停留在管理员页面。必须同时监听 route.path —— 只看 isAdmin/sessionReady
// 的话，登录后手动导航（或直接改 hash）不会触发，界面会停在会返回 403 的页面上。
// 前缀匹配：节点详情是 /nodes/:id 子路径，精确匹配会漏掉它，普通用户就会停在 403 页面。
const ADMIN_ONLY_PATHS = ["/accounts", "/nodes"];
const isAdminOnlyPath = (path: string) =>
  ADMIN_ONLY_PATHS.some((base) => path === base || path.startsWith(`${base}/`));
watch(
  [isAdmin, sessionReady, () => route.path],
  async ([admin, ready, path]) => {
    if (!ready) return;
    if (!admin && isAdminOnlyPath(path)) await router.replace("/tunnels");
  }
);

function toggleTheme() {
  transitioning.value = true;
  setThemeMode(!isDark.value);
  // 连续切换时先清掉上一个定时器，避免旧回调提前结束本次过渡动画。
  if (themeTimer) window.clearTimeout(themeTimer);
  themeTimer = window.setTimeout(() => {
    transitioning.value = false;
    themeTimer = undefined;
  }, 350);
}
// 主题风格下发到 <body>；.shell 由模板绑定 data-accent。
// naive-ui 弹层挂在 body 下，两处都要有属性才能覆盖到。
watch(
  themeStyleId,
  (id) => {
    document.body.dataset.accent = id;
  },
  { immediate: true }
);
onBeforeUnmount(() => {
  if (themeTimer) window.clearTimeout(themeTimer);
});

const icon = (component: unknown) => () =>
  h(NIcon, null, { default: () => h(component as never) });
onMounted(() => { void bootstrapSession(); });
// 导航按角色过滤：普通用户看不到「边缘节点」与「账号管理」。
// 这只是可见性控制，真正的边界在服务端（requireAdmin + owner_id 作用域）。
const menu = computed<MenuOption[]>(() => [
  { label: "隧道管理", key: "/tunnels", icon: icon(Cable) },
  ...(isAdmin.value ? [{ label: "边缘节点", key: "/nodes", icon: icon(MapPin) }] : []),
  { label: "运行总览", key: "/dashboard", icon: icon(CircleGauge) },
  ...(isAdmin.value ? [{ label: "账号管理", key: "/accounts", icon: icon(ShieldCheck) }] : []),
  { type: "divider", key: "d" },
  { label: "会员与邀请", key: "/membership", icon: icon(Crown) },
  { label: "账号安全", key: "/profile", icon: icon(ShieldCheck) },
  { label: "偏好设置", key: "/settings", icon: icon(Settings) }
]);
const mobileMenu = computed(() => [
  { label: "隧道", path: "/tunnels", icon: Cable },
  ...(isAdmin.value ? [{ label: "节点", path: "/nodes", icon: MapPin }] : []),
  { label: "总览", path: "/dashboard", icon: CircleGauge },
  ...(isAdmin.value ? [{ label: "账号", path: "/accounts", icon: ShieldCheck }] : []),
  {label:"会员",path:"/membership",icon:Crown},
  {label:"安全",path:"/profile",icon:ShieldCheck},
  { label: "设置", path: "/settings", icon: Settings }
]);
// 子页面（如 /nodes/:id）要归到所属的一级菜单，否则侧栏不会高亮任何项。
const active = computed(() => {
  const path = route.path;
  return path.startsWith("/nodes/") ? "/nodes" : path;
});
// naive-ui token 随风格 + 深浅模式整套切换（中性色、圆角、语义色与 primary 按钮文字色）
const themeOverrides = computed(() => ({
  common: naiveCommonTokens(currentThemeStyle.value, themeLight.value),
  ...naiveButtonTokens(currentThemeStyle.value, themeLight.value)
}));
// body 背景 / theme-color 跟随当前风格的对应模式底色
watch(
  [isDark, currentThemeStyle],
  ([dark, style]) => {
    const bg = dark ? style.dark.bg : style.light.bg;
    document.body.style.backgroundColor = bg;
    document.body.classList.toggle("theme-light", !dark);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", bg);
  },
  { immediate: true }
);
</script>
<template>
  <n-config-provider
    :theme="isDark ? darkTheme : null"
    :theme-overrides="themeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <n-dialog-provider
      ><n-notification-provider
        ><n-message-provider>
          <ReauthenticateModal />
          <div
            class="shell"
            :class="{
              'theme-light': !isDark,
              'theme-transitioning': transitioning
            }"
            :data-accent="themeStyleId"
          >
            <TitleBar :light="!isDark" />
            <!-- 未登录（或需先改密）只渲染登录页；会话确认完成前用隐形占位，避免登录页闪现 -->
            <LoginView v-if="!sessionReady" class="session-placeholder" />
            <LoginView
              v-else-if="!isAuthenticated || mustChangePassword"
              @done="onSignedIn"
            />
            <n-layout v-else has-sider class="shell-body">
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
                  <!-- 折叠态也保留主题切换入口，仅切换按钮为紧凑尺寸 -->
                  <button
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
                <div v-if="!collapsed && isAuthenticated" class="account-bar">
                  <div class="account-id">
                    <b>{{ displayName }}</b>
                    <span>{{ isAdmin ? "管理员" : "普通用户" }}</span>
                  </div>
                  <button
                    class="account-out"
                    title="退出登录"
                    aria-label="退出登录"
                    @click="signOutConfirm = true"
                  >
                    <LogOut :size="15" />
                  </button>
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
    <!-- 退出登录确认框：登出会停止本机隧道代理，必须让用户知情确认 -->
    <n-modal
      v-model:show="signOutConfirm"
      preset="dialog"
      type="warning"
      title="退出登录"
      content="退出后将停止本机隧道代理并返回登录页，确认退出？"
      positive-text="退出登录"
      negative-text="取消"
      :loading="signingOut"
      :mask-closable="!signingOut"
      :closable="!signingOut"
      @positive-click="onSignOutPositive"
    />
  </n-config-provider>
</template>
