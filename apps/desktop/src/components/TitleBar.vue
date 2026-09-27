<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X, Zap } from "lucide-vue-next";

// 标题栏同时用于主界面与登录页：窗口是 decorations:false 的无边框窗口，
// 没有标题栏就无法拖动、最小化或关闭，因此登录页必须也渲染它。
defineProps<{ light?: boolean }>();

const isTauri =
  typeof window !== "undefined" && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
const appWindow = isTauri ? getCurrentWindow() : null;
// 跟踪窗口最大化状态，用于切换按钮图标与提示文案（最大化 ⇆ 还原）。
const maximized = ref(false);
let unlistenResized: (() => void) | undefined;
onMounted(async () => {
  if (!appWindow) return;
  maximized.value = await appWindow.isMaximized();
  // 最大化 / 还原都会触发 resized 事件，在回调里读取真实状态即可覆盖
  // 手动拖拽、双击标题栏等所有改变窗口尺寸的途径。
  unlistenResized = await appWindow.onResized(async () => {
    maximized.value = await appWindow.isMaximized();
  });
});
onBeforeUnmount(() => unlistenResized?.());

async function winMinimize() {
  await appWindow?.minimize();
}
async function winToggleMax() {
  if (!appWindow) return;
  await (maximized.value ? appWindow.unmaximize() : appWindow.maximize());
}
async function winClose() {
  await appWindow?.close();
}
async function onTitlebarDown(event: MouseEvent) {
  // 仅左键拖动，且避开按钮，否则点击窗口按钮会误触发拖拽。
  if (event.button !== 0) return;
  if ((event.target as HTMLElement).closest("button")) return;
  await appWindow?.startDragging();
}
// 双击标题栏空白区切换最大化（与系统窗口习惯一致），按钮区域除外。
async function onTitlebarDblclick(event: MouseEvent) {
  if ((event.target as HTMLElement).closest("button")) return;
  await winToggleMax();
}
</script>

<template>
  <div class="titlebar" :class="{ 'theme-light': light }" @mousedown="onTitlebarDown" @dblclick="onTitlebarDblclick">
    <div class="titlebar-left">
      <div class="titlebar-mark"><Zap :size="14" fill="currentColor" /></div>
      <span>Nexious Tunnel</span>
    </div>
    <div class="titlebar-controls">
      <button class="tb-btn" title="最小化" aria-label="最小化" @click="winMinimize">
        <Minus :size="14" />
      </button>
      <button
        class="tb-btn"
        :title="maximized ? '还原' : '最大化'"
        :aria-label="maximized ? '还原' : '最大化'"
        @click="winToggleMax"
      >
        <!-- 最大化时用双层方块表达"还原"，与 Windows 系统标题栏一致 -->
        <Copy v-if="maximized" :size="12" /><Square v-else :size="12" />
      </button>
      <button class="tb-btn tb-close" title="关闭" aria-label="关闭" @click="winClose">
        <X :size="14" />
      </button>
    </div>
  </div>
</template>
