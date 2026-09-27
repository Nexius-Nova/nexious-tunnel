<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

type ZenState = "running" | "pending" | "idle";

const props = withDefaults(defineProps<{ state?: ZenState }>(), {
  state: "idle"
});

const canvas = ref<HTMLCanvasElement | null>(null);

// 「极光云雾 + 星尘」禅模式背景：画面里没有任何可辨识的线条，
// 只有几团大范围柔光缓慢流动呼吸，以及少量漂浮的光点。
// 柔光与光点都用预烘焙的小贴图放大绘制：既避免了每帧重绘大面积径向渐变
// （在 WebView2 上会退化成色块且吃性能），又能稳定拿到柔和的边缘。
interface Cloud {
  x: number;
  y: number;
  radius: number;
  driftX: number;
  driftY: number;
  speed: number;
  phase: number;
  alpha: number;
}
interface Star {
  x: number;
  y: number;
  vx: number;
  vy: number;
  core: number;
  alpha: number;
  twinkle: number;
  phase: number;
}

let ctx: CanvasRenderingContext2D | null = null;
let blob: HTMLCanvasElement | null = null;
let dot: HTMLCanvasElement | null = null;
let observer: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;
let raf = 0;
let width = 0;
let height = 0;
let clouds: Cloud[] = [];
let stars: Star[] = [];
let last = 0;
let elapsed = 0;
let reduceMotion = false;
let lightTheme = false;
let accent = "239, 68, 68";
// 当前贴图使用的着色与深浅色，用于判断是否需要重新烘焙。
let baked = "";

const pointer = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4, active: false, strength: 0 };

// 状态映射氛围：running 明亮畅快、pending 整体转暖（连接中）、idle 收敛安静。
const MOODS: Record<ZenState, { drift: number; life: number; warm: boolean }> = {
  running: { drift: 1, life: 1, warm: false },
  pending: { drift: 0.62, life: 0.84, warm: true },
  idle: { drift: 0.34, life: 0.6, warm: false }
};
const WARM = "255, 198, 140";
// 云雾位置与基础不透明度：错落分布，避免对称带来的机械感。
const CLOUD_SPOTS: [number, number, number][] = [
  [0.18, 0.26, 0.2],
  [0.82, 0.18, 0.17],
  [0.66, 0.74, 0.15],
  [0.26, 0.82, 0.13],
  [0.5, 0.46, 0.1]
];

const rand = (min: number, max: number) => min + Math.random() * (max - min);

function readAccentRgb() {
  const raw = getComputedStyle(document.body).getPropertyValue("--accent").trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(raw);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  }
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(raw);
  return rgb ? `${rgb[1]}, ${rgb[2]}, ${rgb[3]}` : undefined;
}

function makeCanvas(size: number) {
  const element = document.createElement("canvas");
  element.width = size;
  element.height = size;
  return element;
}

// 云雾贴图：中心亮、边缘完全透明的大范围柔光。
function bakeBlob(color: string) {
  const element = makeCanvas(256);
  const bc = element.getContext("2d");
  if (!bc) return;
  const half = element.width / 2;
  const gradient = bc.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0, `rgba(${color}, 1)`);
  gradient.addColorStop(0.32, `rgba(${color}, 0.5)`);
  gradient.addColorStop(0.62, `rgba(${color}, 0.16)`);
  gradient.addColorStop(1, `rgba(${color}, 0)`);
  bc.fillStyle = gradient;
  bc.fillRect(0, 0, element.width, element.height);
  blob = element;
}

// 星点贴图：中心的实心高光 + 外扩光晕，整体只占贴图中心约 1/7，便于按尺寸缩放。
function bakeDot(color: string) {
  const element = makeCanvas(64);
  const dc = element.getContext("2d");
  if (!dc) return;
  const half = element.width / 2;
  const gradient = dc.createRadialGradient(half, half, 0, half, half, half);
  // 深色底用白色核心最亮；浅色底白点会消失，改用强调色本身做核心。
  gradient.addColorStop(0, lightTheme ? `rgba(${color}, 0.95)` : "rgba(255, 255, 255, 1)");
  gradient.addColorStop(0.14, `rgba(${color}, 0.8)`);
  gradient.addColorStop(0.42, `rgba(${color}, 0.2)`);
  gradient.addColorStop(1, `rgba(${color}, 0)`);
  dc.fillStyle = gradient;
  dc.fillRect(0, 0, element.width, element.height);
  dot = element;
}

function ensureTextures(tint: string) {
  const key = `${tint}|${lightTheme}`;
  if (key === baked) return;
  baked = key;
  bakeBlob(tint);
  bakeDot(tint);
}

function buildScene() {
  // 云团半径按短边比例换算成像素，窗口尺寸变化时重新生成。
  const base = Math.max(1, Math.min(width, height));
  clouds = CLOUD_SPOTS.map(([x, y, alpha], index) => ({
    x,
    y,
    radius: rand(0.44, 0.72) * base * (index === 4 ? 0.78 : 1),
    driftX: rand(0.04, 0.11),
    driftY: rand(0.035, 0.09),
    speed: rand(0.05, 0.1),
    phase: rand(0, Math.PI * 2),
    alpha
  }));
  const count = Math.min(110, Math.max(26, Math.round((width * height) / 11000)));
  stars = Array.from({ length: count }, () => {
    const hero = Math.random() < 0.12;
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      vx: rand(3, 13),
      vy: rand(-7, 7),
      core: hero ? rand(1.8, 2.8) : rand(0.6, 1.5),
      alpha: hero ? rand(0.5, 0.8) : rand(0.22, 0.55),
      twinkle: rand(0.4, 1.4),
      phase: rand(0, Math.PI * 2)
    };
  });
}

function resize() {
  const element = canvas.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = Math.max(1, Math.round(rect.width));
  height = Math.max(1, Math.round(rect.height));
  element.width = Math.round(width * dpr);
  element.height = Math.round(height * dpr);
  ctx = element.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  buildScene();
  // 首帧同步绘制：标签页在后台时 rAF 被挂起，只靠动画循环会导致画布一直空白。
  draw(0);
}

function draw(dt: number) {
  const c = ctx;
  if (!c) return;
  elapsed += dt;
  const mood = MOODS[props.state] ?? MOODS.idle;
  const life = reduceMotion ? mood.life * 0.92 : mood.life;
  ensureTextures(mood.warm ? WARM : accent);

  if (pointer.active) {
    pointer.x += (pointer.tx - pointer.x) * Math.min(1, dt * 4);
    pointer.y += (pointer.ty - pointer.y) * Math.min(1, dt * 4);
    pointer.strength += (1 - pointer.strength) * Math.min(1, dt * 2.4);
  } else {
    pointer.strength += (0 - pointer.strength) * Math.min(1, dt * 1.6);
  }
  // 视差：云雾朝指针反方向轻移，制造"层在身后"的纵深。
  const shiftX = -(pointer.x / Math.max(1, width) - 0.5) * 40 * pointer.strength;
  const shiftY = -(pointer.y / Math.max(1, height) - 0.5) * 26 * pointer.strength;

  c.clearRect(0, 0, width, height);

  // forEach 回调内 TS 无法保持模块变量的 null 窄化，先固化为局部常量。
  const cloudTexture = blob;
  if (cloudTexture) {
    // 深色底用叠加混合让云雾互相发光；浅色底普通合成，避免越叠越白。
    c.globalCompositeOperation = lightTheme ? "source-over" : "lighter";
    const dim = lightTheme ? 0.7 : 1;
    clouds.forEach((cloud) => {
      const t = elapsed * cloud.speed * (0.55 + mood.drift * 0.85) + cloud.phase;
      const radius = cloud.radius * (1 + Math.sin(t * 0.8) * 0.09);
      const x = (cloud.x + Math.sin(t) * cloud.driftX) * width + shiftX;
      const y = (cloud.y + Math.cos(t * 0.77) * cloud.driftY) * height + shiftY;
      c.globalAlpha = Math.min(1, cloud.alpha * life * dim * (1 + Math.sin(t * 1.3) * 0.12));
      c.drawImage(cloudTexture, x - radius, y - radius, radius * 2, radius * 2);
    });
    c.globalCompositeOperation = "source-over";
    c.globalAlpha = 1;
  }

  const starTexture = dot;
  if (starTexture) {
    const drift = 0.4 + mood.drift * 0.9;
    stars.forEach((star) => {
      if (!reduceMotion) {
        star.x += star.vx * drift * dt;
        star.y += star.vy * drift * dt;
        if (star.x > width + 40) {
          star.x = -40;
          star.y = Math.random() * height;
        }
        if (star.y < -40) star.y = height + 40;
        else if (star.y > height + 40) star.y = -40;
      }
      const twinkle = 0.55 + 0.45 * Math.sin(elapsed * star.twinkle + star.phase);
      // 指针附近的星点更亮，形成轻量的互动反馈。
      const near =
        pointer.strength > 0.01
          ? Math.max(0, 1 - Math.hypot(star.x - pointer.x, star.y - pointer.y) / 220) ** 2 * pointer.strength
          : 0;
      c.globalAlpha = Math.min(1, star.alpha * twinkle * life * (1 + near * 1.8));
      const halo = star.core * 7;
      c.drawImage(starTexture, star.x - halo, star.y - halo, halo * 2, halo * 2);
    });
    c.globalAlpha = 1;
  }
}

function loop(now: number) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  draw(dt);
  raf = window.requestAnimationFrame(loop);
}

function start() {
  if (raf || reduceMotion || !canvas.value) return;
  last = performance.now();
  raf = window.requestAnimationFrame(loop);
}
function stop() {
  if (!raf) return;
  window.cancelAnimationFrame(raf);
  raf = 0;
}
function onVisibility() {
  if (document.hidden) stop();
  else start();
}

function syncTheme() {
  const nextLight = document.body.classList.contains("theme-light");
  const nextAccent = readAccentRgb() ?? accent;
  if (nextLight === lightTheme && nextAccent === accent) return;
  lightTheme = nextLight;
  accent = nextAccent;
  // 贴图着色与深浅色都变了，作废缓存后由下一帧重新烘焙。
  baked = "";
  draw(0);
}

function onPointerMove(event: PointerEvent) {
  const element = canvas.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  pointer.tx = event.clientX - rect.left;
  pointer.ty = event.clientY - rect.top;
  pointer.active = true;
}
function onPointerLeave() {
  pointer.active = false;
}

onMounted(() => {
  reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  lightTheme = document.body.classList.contains("theme-light");
  accent = readAccentRgb() ?? accent;
  resize();
  observer = new ResizeObserver(() => resize());
  if (canvas.value) observer.observe(canvas.value);
  themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class", "data-accent"] });
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerleave", onPointerLeave);
  window.addEventListener("blur", onPointerLeave);
  start();
});

onBeforeUnmount(() => {
  stop();
  observer?.disconnect();
  observer = null;
  themeObserver?.disconnect();
  themeObserver = null;
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerleave", onPointerLeave);
  window.removeEventListener("blur", onPointerLeave);
});

watch(
  () => props.state,
  () => {
    // 状态切换立即重绘一帧（静态降级模式下也能反映最新氛围）。
    draw(0.0001);
  }
);
</script>

<template>
  <canvas ref="canvas" class="flow-canvas" aria-hidden="true"></canvas>
</template>

<style scoped>
.flow-canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
</style>
