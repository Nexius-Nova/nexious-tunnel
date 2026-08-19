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
  app.mount("#app");
  const splash = document.getElementById("splash");
  if (splash) {
    splash.classList.add("fade-out");
    setTimeout(() => splash.remove(), 500);
  }
});
