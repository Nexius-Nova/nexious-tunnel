import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.VITE_PROXY_TARGET || "http://127.0.0.1:8787",
        changeOrigin: true
      }
    }
  },
  clearScreen: false,
  test: {
    // 仅扫描 src 下的单元测试，避免误抓 src-tauri/target 中打包进去的服务端测试副本。
    include: ["src/**/*.test.ts"]
  }
});
