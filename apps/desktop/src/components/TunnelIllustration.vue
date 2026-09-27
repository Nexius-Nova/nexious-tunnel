<script setup lang="ts">
// 登录页插画：用产品自身的拓扑（本地服务 → 加密隧道 → 边缘节点）作为视觉主角，
// 而不是放一张与产品无关的装饰图。内联 SVG：无需外部资源，也不受 CSP 的 img-src 限制，
// 并且能用 CSS 变量跟随深浅主题、用 prefers-reduced-motion 关掉动效。
let uid = 0;
// 同一页面可能挂载多份（占位 + 实体），渐变 id 必须唯一，否则会互相引用。
const id = `art${(uid += 1)}-${Math.random().toString(36).slice(2, 7)}`;
</script>

<template>
  <figure class="tunnel-art" aria-hidden="true">
    <svg viewBox="0 0 440 200" role="presentation" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient :id="`${id}-line`" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="var(--art-accent)" stop-opacity="0.18" />
          <stop offset="0.5" stop-color="var(--art-accent)" stop-opacity="0.75" />
          <stop offset="1" stop-color="var(--art-accent)" stop-opacity="0.3" />
        </linearGradient>
        <radialGradient :id="`${id}-glow`" cx="0.55" cy="0.5" r="0.5">
          <stop offset="0" stop-color="var(--art-accent)" stop-opacity="0.14" />
          <stop offset="1" stop-color="var(--art-accent)" stop-opacity="0" />
        </radialGradient>
      </defs>

      <!-- 隧道区域的环境光 -->
      <ellipse cx="232" cy="96" rx="190" ry="86" :fill="`url(#${id}-glow)`" />

      <!-- 本地服务 -->
      <g class="art-device">
        <rect x="16" y="74" width="104" height="76" rx="10" />
        <rect class="art-screen" x="28" y="86" width="80" height="52" rx="5" />
        <path class="art-code" d="M 38 100 H 78" />
        <path class="art-code" d="M 38 112 H 98" />
        <path class="art-code" d="M 38 124 H 66" />
      </g>

      <!-- 隧道：底轨 + 流动虚线 -->
      <path
        class="art-track"
        d="M 124 112 C 180 112 182 62 240 62 C 298 62 300 112 338 112"
      />
      <path
        class="art-flow"
        d="M 124 112 C 180 112 182 62 240 62 C 298 62 300 112 338 112"
      />

      <!-- 沿隧道流动的数据包（offset-path 沿同一条曲线运动） -->
      <circle class="art-packet" r="3.8" />
      <circle class="art-packet art-packet-b" r="3.8" />
      <circle class="art-packet art-packet-c" r="3" />

      <!-- 加密标记：放在隧道最高点，表示这条链路是加密的 -->
      <g class="art-badge">
        <circle cx="240" cy="62" r="14" />
        <path class="art-lock" d="M 235.5 68 H 244.5 A 1.5 1.5 0 0 0 246 66.5 V 61.5 A 1.5 1.5 0 0 0 244.5 60 H 235.5 A 1.5 1.5 0 0 0 234 61.5 V 66.5 A 1.5 1.5 0 0 0 235.5 68 Z" />
        <path class="art-lock" d="M 237 60 V 56.6 A 3 3 0 0 1 243 56.6 V 60" />
      </g>

      <!-- 边缘节点 -->
      <g class="art-node">
        <path d="M 380 70 L 416 91 L 416 133 L 380 154 L 344 133 L 344 91 Z" />
        <circle class="art-globe" cx="380" cy="112" r="15" />
        <ellipse class="art-globe" cx="380" cy="112" rx="6.5" ry="15" />
        <path class="art-globe" d="M 365 112 H 395" />
      </g>

      <text class="art-label" x="68" y="180" text-anchor="middle">本地服务</text>
      <text class="art-label" x="380" y="180" text-anchor="middle">边缘节点</text>
    </svg>
  </figure>
</template>

<style scoped>
.tunnel-art {
  margin: 26px 0 0;
  width: 100%;
}
.tunnel-art svg {
  display: block;
  width: 100%;
  height: auto;
  overflow: visible;
}

/* 深色（默认）配色 */
.tunnel-art {
  --art-accent: var(--accent);
  --art-accent-soft: rgba(var(--accent-rgb), 0.42);
  --art-stroke: rgba(200, 205, 208, 0.4);
  --art-stroke-soft: rgba(170, 175, 180, 0.22);
  --art-fill: rgba(255, 255, 255, 0.03);
  --art-badge-fill: #1a1c1e;
  --art-text: rgba(170, 176, 180, 0.6);
  /* 数据包用接近白的高光色：与同色虚线区分开，读起来才像"正在传输的数据" */
  --art-packet: #eef0f2;
}

/* ── 颜色：由主题变量驱动 ── */
.art-device rect {
  fill: none;
  stroke: var(--art-stroke);
  stroke-width: 1.6;
}
.art-device .art-screen {
  stroke: var(--art-stroke-soft);
  fill: var(--art-fill);
}
.art-device .art-code {
  stroke: var(--art-stroke);
  stroke-width: 2.6;
  stroke-linecap: round;
}
.art-node > path:first-child {
  fill: var(--art-fill);
  stroke: var(--art-accent-soft);
  stroke-width: 1.6;
}
.art-node .art-globe {
  fill: none;
  stroke: var(--art-accent);
  stroke-width: 1.4;
  opacity: 0.85;
}
.art-track {
  fill: none;
  stroke: var(--art-stroke-soft);
  stroke-width: 1.5;
}
.art-flow {
  fill: none;
  stroke: var(--art-accent);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-dasharray: 5 15;
  opacity: 0.7;
  animation: artDash 2.4s linear infinite;
}
@keyframes artDash {
  to {
    stroke-dashoffset: -40;
  }
}
.art-badge circle {
  fill: var(--art-badge-fill);
  stroke: var(--art-accent-soft);
  stroke-width: 1.4;
}
.art-lock {
  fill: none;
  stroke: var(--art-accent);
  stroke-width: 1.3;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.art-label {
  font: 500 10.5px ui-monospace, Consolas, monospace;
  letter-spacing: 1.6px;
  fill: var(--art-text);
}

/* ── 数据包：沿同一条曲线运动 ── */
/* 默认隐藏再按需开启：offset-path 会把路径坐标叠加到元素自身位置上，
   因此圆点不能带 cx/cy；而缺少 offset-path 支持时圆点会停在原点(0,0)，
   所以只在支持时才显示，避免画布角落出现杂点。 */
.art-packet {
  fill: var(--art-packet);
  opacity: 0;
}
@supports (offset-path: path("M 0 0")) {
  .art-packet {
    offset-path: path("M 124 112 C 180 112 182 62 240 62 C 298 62 300 112 338 112");
    offset-rotate: 0deg;
    animation: artFlow 3.4s cubic-bezier(0.45, 0, 0.55, 1) infinite;
  }
  .art-packet-b {
    animation-delay: 1.15s;
  }
  .art-packet-c {
    animation-delay: 2.3s;
  }
}
@keyframes artFlow {
  0% {
    offset-distance: 0%;
    opacity: 0;
  }
  12% {
    opacity: 1;
  }
  85% {
    opacity: 0.95;
  }
  100% {
    offset-distance: 100%;
    opacity: 0;
  }
}

/* 浅色主题：整体降低对比度，避免插画比表单更抢眼 */
.theme-light .tunnel-art {
  --art-accent: var(--accent);
  --art-accent-soft: rgba(var(--accent-rgb), 0.45);
  --art-stroke: rgba(70, 75, 82, 0.4);
  --art-stroke-soft: rgba(70, 75, 82, 0.22);
  --art-fill: rgba(0, 0, 0, 0.03);
  --art-badge-fill: #f4f5f7;
  --art-text: rgba(100, 106, 112, 0.7);
  --art-packet: var(--accent);
}

/* 尊重系统的「减少动态效果」：保留静态插画，停止流动 */
@media (prefers-reduced-motion: reduce) {
  .art-flow {
    animation: none !important;
    /* 静态时把虚线画成完整虚线，不再需要流动 */
    stroke-dasharray: none;
    opacity: 0.85;
  }
  /* 数据包归零后停在原点会很难看，直接隐藏，插画本身仍然完整 */
  .art-packet {
    animation: none !important;
    opacity: 0 !important;
  }
}
</style>
