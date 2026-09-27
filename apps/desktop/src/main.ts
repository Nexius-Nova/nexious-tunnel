import { createApp } from "vue";
import { VueQueryPlugin, QueryClient } from "@tanstack/vue-query";
import { createRouter, createWebHashHistory } from "vue-router";
import App from "./App.vue";
import "./styles.css";
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/tunnels", component: () => import("./views/TunnelsView.vue") },
    { path: "/nodes", component: () => import("./views/NodesView.vue") },
    { path: "/nodes/:id", component: () => import("./views/NodeDetailView.vue") },
    { path: "/dashboard", component: () => import("./views/DashboardView.vue") },
    { path: "/accounts", component: () => import("./views/AccountsView.vue") },
    { path: "/membership", component: () => import("./views/MembershipView.vue") },
    { path: "/profile", component: () => import("./views/ProfileView.vue") },
    { path: "/settings", component: () => import("./views/SettingsView.vue") },
    { path: "/", redirect: "/tunnels" },
    { path: "/logs", redirect: "/dashboard" },
    { path: "/:pathMatch(.*)*", redirect: "/tunnels" }
  ]
});
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15000, retry: 1, refetchOnWindowFocus: false }
  }
});
const app = createApp(App);
app.use(router).use(VueQueryPlugin, { queryClient });

// 启动页位于 #app 之外，可在 Vue 挂载期间继续覆盖页面，实现平滑过渡。
function dismissSplash() {
  const splash = document.getElementById("splash");
  if (!splash) return;
  splash.classList.add("fade-out");
  setTimeout(() => splash.remove(), 500);
}

router.isReady().then(() => {
  dismissSplash();
  app.mount("#app");
}).catch((error) => {
  // 路由初始化失败也必须挂载应用并移除启动页，否则窗口会永远停在启动页。
  console.error("路由初始化失败", error);
  dismissSplash();
  app.mount("#app");
});
