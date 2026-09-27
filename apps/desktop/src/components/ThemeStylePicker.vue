<script setup lang="ts">
import { Check } from "lucide-vue-next";
import { THEME_STYLES, themeStyleId, setThemeStyle } from "../theme";

/**
 * 主题风格选择器：左侧色卡预览该风格的强调色与深/浅底色，
 * 右侧显示风格名与一句话定位，点击立即生效并持久化。
 */
</script>

<template>
  <div class="style-grid" role="radiogroup" aria-label="主题风格">
    <button
      v-for="style in THEME_STYLES"
      :key="style.id"
      type="button"
      class="style-option"
      :class="{ active: themeStyleId === style.id }"
      role="radio"
      :aria-checked="themeStyleId === style.id"
      :aria-label="`${style.name}：${style.description}`"
      @click="setThemeStyle(style.id)"
    >
      <span class="swatch" aria-hidden="true">
        <!-- 左侧强调色主条 + 右侧面板/底色块，模拟该风格的实际界面构成 -->
        <i class="bar" :style="{ background: style.dark.accent }" />
        <span class="tiles">
          <i :style="{ background: style.light.surface }" />
          <i :style="{ background: style.dark.border }" />
        </span>
      </span>
      <span class="meta">
        <span class="meta-top">
          <b>{{ style.name }}</b>
          <Transition name="check-pop">
            <Check v-if="themeStyleId === style.id" class="check" :size="15" aria-hidden="true" />
          </Transition>
        </span>
        <small>{{ style.description }}</small>
      </span>
    </button>
  </div>
</template>

<style scoped>
.style-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: 12px;
  padding: 14px 18px 16px;
}
.style-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px 10px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
}
.style-option:hover {
  border-color: var(--accent);
}
.style-option:active {
  transform: scale(0.98);
}
.style-option.active {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
/* 色卡：强调色竖条 + 浅色面板块 + 结构块，一眼看出该风格的构成 */
.swatch {
  flex: none;
  width: 52px;
  height: 46px;
  padding: 6px;
  display: flex;
  gap: 4px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--surface-raised);
}
.swatch .bar {
  flex: 1.2;
  border-radius: 5px;
}
.swatch .tiles {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.swatch .tiles i {
  flex: 1;
  border-radius: 4px;
}
.meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.meta-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.meta b {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary);
}
.meta small {
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--text-secondary);
}
.check {
  color: var(--accent);
  flex: none;
}
.check-pop-enter-active,
.check-pop-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.check-pop-enter-from,
.check-pop-leave-to {
  opacity: 0;
  transform: scale(0.5);
}
</style>
