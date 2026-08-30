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
    { path: "/dashboard", component: () => import("./views/DashboardView.vue") },
    { path: "/settings", component: () => import("./views/SettingsView.vue") },
    { path: "/", redirect: "/tunnels" },
    { path: "/logs", redirect: "/dashboard" }
  ]
});
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15000, retry: 1, refetchOnWindowFocus: false }
  }
});
const app = createApp(App);
app.use(router).use(VueQueryPlugin, { queryClient });
router.isReady().then(() => {
  // 启动页位于 #app 之外，可在 Vue 挂载期间继续覆盖页面，实现平滑过渡
  const splash = document.getElementById("splash");
  splash?.classList.add("fade-out");
  app.mount("#app");
  if (splash) setTimeout(() => splash.remove(), 500);
});
