import { computed, ref } from "vue";

/**
 * 主题风格（整套界面风格预设）与深浅色模式的单一数据源。
 *
 * 设计取向：克制高级感 —— 全部风格共享中性基底（仅色温与明度微调），
 * 个性来自单一点缀色、底色明度与圆角，不做大面积彩底。
 *
 * 每套风格自带深 / 浅两套完整配色：页面底色、侧栏与标题栏、面板、
 * 悬停底色、滚动条、文字层次、强调色与圆角。风格通过 data-accent
 * 属性下发到 <body> 与 .shell，styles.css 中按
 * `[data-accent="…"]` / `.theme-light[data-accent="…"]` 两组选择器
 * 覆盖全局变量（后者的优先级高于全局 .theme-light 块）。
 */

/** 单一模式（深/浅）下的完整配色档位 */
export interface ThemeModePalette {
  /** 页面底色 */
  bg: string;
  /** 内容面板 */
  surface: string;
  /** 凸起面板（弹层、表格头、输入框底） */
  surfaceRaised: string;
  /** 悬停底色 */
  surfaceHover: string;
  /** 侧栏 / 标题栏等结构面板 */
  surfaceDeep: string;
  border: string;
  borderSubtle: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  scrollbar: string;
  scrollbarHover: string;
  /** 强调色 */
  accent: string;
  /** 强调色 rgb 三元组，供 rgba(var(--accent-rgb), a) 组合透明度 */
  rgb: string;
  /** 悬停态强调色（深色下更亮、浅色下更深） */
  hover: string;
  /** 强调色染色面板底色 */
  softBg: string;
  /** 强调色染色面板描边（主要在浅色模式使用） */
  softBorder: string;
}

export interface ThemeStyle {
  id: string;
  name: string;
  /** 风格一句话定位（选择器副标题） */
  description: string;
  /** 风格专属圆角（px），与深浅模式无关 */
  radius: number;
  dark: ThemeModePalette;
  light: ThemeModePalette;
  /** naive-ui themeOverrides 主色（分模式，mono 类风格深浅差异大） */
  naive: { dark: { primary: string; hover: string; pressed: string }; light: { primary: string; hover: string; pressed: string } };
}

export const THEME_STYLES: ThemeStyle[] = [
  {
    id: "classic",
    name: "Classic",
    description: "均衡的工作台主题",
    radius: 8,
    dark: {
      bg: "#101112",
      surface: "#17191a",
      surfaceRaised: "#1c1e20",
      surfaceHover: "#232628",
      surfaceDeep: "#141617",
      border: "#2a2d2f",
      borderSubtle: "#222527",
      textPrimary: "#e8eaea",
      textSecondary: "#8f9796",
      textMuted: "#6d7573",
      scrollbar: "#34383a",
      scrollbarHover: "#464b4d",
      accent: "#ef4444",
      rgb: "239, 68, 68",
      hover: "#f87171",
      softBg: "#221616",
      softBorder: "#55302f"
    },
    light: {
      bg: "#f6f6f7",
      surface: "#ffffff",
      surfaceRaised: "#f9f9fa",
      surfaceHover: "#f0f1f2",
      surfaceDeep: "#ffffff",
      border: "#e3e4e7",
      borderSubtle: "#ededef",
      textPrimary: "#1a1b1e",
      textSecondary: "#66686e",
      textMuted: "#8e9095",
      scrollbar: "#c7c9cd",
      scrollbarHover: "#aeb0b6",
      accent: "#d92d20",
      rgb: "217, 45, 32",
      hover: "#b42318",
      softBg: "#fdeceb",
      softBorder: "#f3c1bd"
    },
    naive: {
      dark: { primary: "#ef4444", hover: "#f87171", pressed: "#d92d20" },
      light: { primary: "#d92d20", hover: "#e3483c", pressed: "#b42318" }
    }
  },
  {
    id: "claw",
    name: "Claw",
    description: "锐利红的指挥面板",
    radius: 4,
    dark: {
      bg: "#0d0e0f",
      surface: "#141516",
      surfaceRaised: "#191b1c",
      surfaceHover: "#202223",
      surfaceDeep: "#111212",
      border: "#26282a",
      borderSubtle: "#1f2123",
      textPrimary: "#e4e6e7",
      textSecondary: "#8a9194",
      textMuted: "#686f72",
      scrollbar: "#2f3335",
      scrollbarHover: "#404548",
      accent: "#e5484d",
      rgb: "229, 72, 77",
      hover: "#ff5d5d",
      softBg: "#221517",
      softBorder: "#5b2b2e"
    },
    light: {
      bg: "#f5f5f6",
      surface: "#ffffff",
      surfaceRaised: "#f8f9f9",
      surfaceHover: "#eff0f1",
      surfaceDeep: "#ffffff",
      border: "#e2e3e5",
      borderSubtle: "#ececee",
      textPrimary: "#191a1c",
      textSecondary: "#65676b",
      textMuted: "#8d8f94",
      scrollbar: "#c6c8cb",
      scrollbarHover: "#adb0b4",
      accent: "#b42318",
      rgb: "180, 35, 24",
      hover: "#912018",
      softBg: "#fcebea",
      softBorder: "#f2c2c0"
    },
    naive: {
      dark: { primary: "#e5484d", hover: "#ff5d5d", pressed: "#c53030" },
      light: { primary: "#b42318", hover: "#d92d20", pressed: "#912018" }
    }
  },
  {
    id: "knot",
    name: "Knot",
    description: "结构化的蓝紫聚焦",
    radius: 8,
    dark: {
      bg: "#101014",
      surface: "#16161b",
      surfaceRaised: "#1b1b21",
      surfaceHover: "#22222a",
      surfaceDeep: "#131318",
      border: "#282832",
      borderSubtle: "#212129",
      textPrimary: "#e6e6ec",
      textSecondary: "#8d8d9b",
      textMuted: "#6b6b78",
      scrollbar: "#31313c",
      scrollbarHover: "#42424f",
      accent: "#818cf8",
      rgb: "129, 140, 248",
      hover: "#a5b0fb",
      softBg: "#1a1a2e",
      softBorder: "#42427a"
    },
    light: {
      bg: "#f5f5f8",
      surface: "#ffffff",
      surfaceRaised: "#f8f8fb",
      surfaceHover: "#eff0f6",
      surfaceDeep: "#ffffff",
      border: "#e2e3ea",
      borderSubtle: "#ececf2",
      textPrimary: "#1a1a22",
      textSecondary: "#646472",
      textMuted: "#8d8d9a",
      scrollbar: "#c6c7d2",
      scrollbarHover: "#aeb0bd",
      accent: "#4f46e5",
      rgb: "79, 70, 229",
      hover: "#4338ca",
      softBg: "#ebeefc",
      softBorder: "#c3cbf5"
    },
    naive: {
      dark: { primary: "#818cf8", hover: "#a5b0fb", pressed: "#6366f1" },
      light: { primary: "#4f46e5", hover: "#6366f1", pressed: "#4338ca" }
    }
  },
  {
    id: "dash",
    name: "Dash",
    description: "清爽的青色运维模式",
    radius: 8,
    dark: {
      bg: "#0e1214",
      surface: "#14191c",
      surfaceRaised: "#191f22",
      surfaceHover: "#20272b",
      surfaceDeep: "#111618",
      border: "#252d31",
      borderSubtle: "#1f262a",
      textPrimary: "#e3e9eb",
      textSecondary: "#8a959b",
      textMuted: "#6a757b",
      scrollbar: "#2e383d",
      scrollbarHover: "#3f4b51",
      accent: "#22c9dd",
      rgb: "34, 201, 221",
      hover: "#5cd9e9",
      softBg: "#12242a",
      softBorder: "#295560"
    },
    light: {
      bg: "#f4f7f8",
      surface: "#ffffff",
      surfaceRaised: "#f8fbfb",
      surfaceHover: "#edf3f4",
      surfaceDeep: "#ffffff",
      border: "#dfe6e8",
      borderSubtle: "#eaeff1",
      textPrimary: "#171d20",
      textSecondary: "#5f6b70",
      textMuted: "#88939a",
      scrollbar: "#c3ced2",
      scrollbarHover: "#aab7bd",
      accent: "#0d8aa2",
      rgb: "13, 138, 162",
      hover: "#0a7188",
      softBg: "#e3f4f8",
      softBorder: "#b3dfe8"
    },
    naive: {
      dark: { primary: "#22c9dd", hover: "#5cd9e9", pressed: "#0d8aa2" },
      light: { primary: "#0d8aa2", hover: "#14a3bd", pressed: "#0a7188" }
    }
  },
  {
    id: "forest",
    name: "Forest",
    description: "平静的编辑绿系",
    radius: 8,
    dark: {
      bg: "#0f1211",
      surface: "#151a18",
      surfaceRaised: "#1a201e",
      surfaceHover: "#212826",
      surfaceDeep: "#121715",
      border: "#272e2b",
      borderSubtle: "#202624",
      textPrimary: "#e5eae8",
      textSecondary: "#8b9691",
      textMuted: "#6b7671",
      scrollbar: "#303936",
      scrollbarHover: "#414c48",
      accent: "#3fb970",
      rgb: "63, 185, 112",
      hover: "#66cd8f",
      softBg: "#15241c",
      softBorder: "#2c5440"
    },
    light: {
      bg: "#f4f7f5",
      surface: "#ffffff",
      surfaceRaised: "#f8fbf9",
      surfaceHover: "#ecf2ee",
      surfaceDeep: "#ffffff",
      border: "#dfe7e2",
      borderSubtle: "#eaf0ec",
      textPrimary: "#171d1a",
      textSecondary: "#5f6b65",
      textMuted: "#88948e",
      scrollbar: "#c4cfc9",
      scrollbarHover: "#aab8b1",
      accent: "#15803d",
      rgb: "21, 128, 61",
      hover: "#116631",
      softBg: "#e5f4ea",
      softBorder: "#b6dcc4"
    },
    naive: {
      dark: { primary: "#3fb970", hover: "#66cd8f", pressed: "#2b9a5b" },
      light: { primary: "#15803d", hover: "#1da251", pressed: "#116631" }
    }
  },
  {
    id: "slate",
    name: "Slate",
    description: "致密石墨控制室",
    radius: 6,
    dark: {
      bg: "#12161d",
      surface: "#181d25",
      surfaceRaised: "#1d232c",
      surfaceHover: "#242b35",
      surfaceDeep: "#141920",
      border: "#2a323d",
      borderSubtle: "#232a33",
      textPrimary: "#e4e9ef",
      textSecondary: "#8b95a2",
      textMuted: "#6b7684",
      scrollbar: "#303a46",
      scrollbarHover: "#41505f",
      accent: "#7f95ad",
      rgb: "127, 149, 173",
      hover: "#9db1c6",
      softBg: "#1a222c",
      softBorder: "#3c4c60"
    },
    light: {
      bg: "#f3f5f7",
      surface: "#ffffff",
      surfaceRaised: "#f8fafb",
      surfaceHover: "#edf0f3",
      surfaceDeep: "#ffffff",
      border: "#e0e4e9",
      borderSubtle: "#eaeef1",
      textPrimary: "#171b21",
      textSecondary: "#5e6874",
      textMuted: "#87919d",
      scrollbar: "#c2cad2",
      scrollbarHover: "#a9b4c0",
      accent: "#4d6a85",
      rgb: "77, 106, 133",
      hover: "#3d5670",
      softBg: "#e9eff5",
      softBorder: "#c1cfda"
    },
    naive: {
      dark: { primary: "#7f95ad", hover: "#9db1c6", pressed: "#647d97" },
      light: { primary: "#4d6a85", hover: "#5d7a96", pressed: "#3d5670" }
    }
  },
  {
    id: "paper",
    name: "Paper",
    description: "暖纸文档阅读优先",
    radius: 8,
    dark: {
      bg: "#121110",
      surface: "#191816",
      surfaceRaised: "#1f1d1b",
      surfaceHover: "#262421",
      surfaceDeep: "#151412",
      border: "#2c2926",
      borderSubtle: "#232120",
      textPrimary: "#ebe8e3",
      textSecondary: "#9a938a",
      textMuted: "#756f66",
      scrollbar: "#383430",
      scrollbarHover: "#4a453f",
      accent: "#cf9264",
      rgb: "207, 146, 100",
      hover: "#ddab84",
      softBg: "#241c13",
      softBorder: "#5c462e"
    },
    light: {
      bg: "#faf8f4",
      surface: "#ffffff",
      surfaceRaised: "#fcfaf6",
      surfaceHover: "#f2efe8",
      surfaceDeep: "#ffffff",
      border: "#e6e1d7",
      borderSubtle: "#efebe3",
      textPrimary: "#1c1a16",
      textSecondary: "#6d675c",
      textMuted: "#948d81",
      scrollbar: "#ccc7bd",
      scrollbarHover: "#b4ada1",
      accent: "#9a5f33",
      rgb: "154, 95, 51",
      hover: "#7d4b26",
      softBg: "#f6ecdf",
      softBorder: "#e4c9ab"
    },
    naive: {
      dark: { primary: "#cf9264", hover: "#ddab84", pressed: "#b57947" },
      light: { primary: "#9a5f33", hover: "#b57947", pressed: "#7d4b26" }
    }
  },
  {
    id: "amber",
    name: "Amber",
    description: "高对比计划台",
    radius: 6,
    dark: {
      bg: "#11100c",
      surface: "#1a1814",
      surfaceRaised: "#201d18",
      surfaceHover: "#27241e",
      surfaceDeep: "#161411",
      border: "#2d2a23",
      borderSubtle: "#242220",
      textPrimary: "#ece8e0",
      textSecondary: "#9c9487",
      textMuted: "#767062",
      scrollbar: "#39352c",
      scrollbarHover: "#4b463c",
      accent: "#f5a623",
      rgb: "245, 166, 35",
      hover: "#ffbe3d",
      softBg: "#241d0e",
      softBorder: "#63501f"
    },
    light: {
      bg: "#faf7f0",
      surface: "#ffffff",
      surfaceRaised: "#fcfaf5",
      surfaceHover: "#f2ede1",
      surfaceDeep: "#ffffff",
      border: "#e6e1d4",
      borderSubtle: "#efeade",
      textPrimary: "#1c1913",
      textSecondary: "#6d675a",
      textMuted: "#948c7c",
      scrollbar: "#ccc6b9",
      scrollbarHover: "#b4ac9b",
      accent: "#b45309",
      rgb: "180, 83, 9",
      hover: "#92400e",
      softBg: "#f8eedd",
      softBorder: "#ecd3a8"
    },
    naive: {
      dark: { primary: "#f5a623", hover: "#ffbe3d", pressed: "#d18a12" },
      light: { primary: "#b45309", hover: "#d97706", pressed: "#92400e" }
    }
  }
];

export const DEFAULT_THEME_STYLE = "classic";
export const THEME_STORAGE_KEY = "nexious-theme-style";

function storedThemeStyle(): string {
  const id = localStorage.getItem(THEME_STORAGE_KEY);
  return THEME_STYLES.some((s) => s.id === id) ? id! : DEFAULT_THEME_STYLE;
}

/** 当前主题风格 id（响应式，设置页与图表等共享） */
export const themeStyleId = ref(storedThemeStyle());
export const currentThemeStyle = computed(
  () => THEME_STYLES.find((s) => s.id === themeStyleId.value) ?? THEME_STYLES[0]
);

/** 是否浅色模式（响应式）。深浅切换沿用 nexious-theme-change 事件广播。 */
export const themeLight = ref(localStorage.getItem("nexious-theme") === "light");

function syncThemeLight(event: Event) {
  themeLight.value = (event as CustomEvent<string>).detail === "light";
}
window.addEventListener("nexious-theme-change", syncThemeLight);

/** 应用主题风格：写 localStorage、更新响应式状态并下发到 <body> */
export function setThemeStyle(id: string) {
  if (!THEME_STYLES.some((s) => s.id === id)) return;
  themeStyleId.value = id;
  localStorage.setItem(THEME_STORAGE_KEY, id);
  document.body.dataset.accent = id;
}

/** 切换深浅色模式（dark=true 表示深色），并广播事件同步各处 */
export function setThemeMode(dark: boolean) {
  themeLight.value = !dark;
  localStorage.setItem("nexious-theme", dark ? "dark" : "light");
  window.dispatchEvent(
    new CustomEvent("nexious-theme-change", { detail: dark ? "dark" : "light" })
  );
}

/** naive-ui 组件级 token：实底 primary 按钮的文字色需按底色亮度显式给黑/白，
 *  naive 默认白字在琥珀这类亮色点缀底上对比不足 */
function hexLuminance(hex: string): number {
  const v = hex.replace("#", "");
  const full = v.length === 3 ? v.split("").map((c) => c + c).join("") : v;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function naiveButtonTokens(style: ThemeStyle, light: boolean) {
  const n = light ? style.naive.light : style.naive.dark;
  const onPrimary = hexLuminance(n.primary) > 0.5 ? "rgba(0, 0, 0, 0.82)" : "rgba(255, 255, 255, 0.86)";
  return {
    Button: {
      textColorPrimary: onPrimary,
      textColorPrimaryHover: onPrimary,
      textColorPrimaryPressed: onPrimary,
      textColorPrimaryFocus: onPrimary
    }
  };
}

/** naive-ui 通用 token：按当前风格 + 深浅模式生成整套中性色 */
export function naiveCommonTokens(style: ThemeStyle, light: boolean) {
  const p = light ? style.light : style.dark;
  const n = light ? style.naive.light : style.naive.dark;
  // 语义色与风格解耦、全局统一：深色用 400 系（亮一档）、浅色用 600 系（深一档），
  // 收敛 naive 默认的高饱和绿/橙，避免与低饱和的中性界面打架。
  const semantic = light
    ? { success: "#16a34a", warning: "#d97706", error: "#dc2626", info: "#2563eb" }
    : { success: "#4ade80", warning: "#fbbf24", error: "#f87171", info: "#60a5fa" };
  return {
    primaryColor: n.primary,
    primaryColorHover: n.hover,
    primaryColorPressed: n.pressed,
    successColor: semantic.success,
    successColorHover: semantic.success,
    successColorPressed: semantic.success,
    warningColor: semantic.warning,
    warningColorHover: semantic.warning,
    warningColorPressed: semantic.warning,
    errorColor: semantic.error,
    errorColorHover: semantic.error,
    errorColorPressed: semantic.error,
    infoColor: semantic.info,
    infoColorHover: semantic.info,
    infoColorPressed: semantic.info,
    bodyColor: p.bg,
    cardColor: p.surface,
    modalColor: p.surfaceRaised,
    dialogColor: p.surfaceRaised,
    popoverColor: p.surfaceRaised,
    tableColor: p.surface,
    tableHeaderColor: p.surfaceRaised,
    inputColor: light ? p.surface : p.surfaceRaised,
    actionColor: p.surfaceRaised,
    borderColor: p.border,
    dividerColor: p.borderSubtle,
    textColorBase: p.textPrimary,
    textColor1: p.textPrimary,
    textColor2: p.textSecondary,
    textColor3: p.textMuted,
    placeholderColor: p.textMuted,
    borderRadius: `${style.radius}px`,
    borderRadiusSmall: `${Math.max(style.radius - 2, 2)}px`,
    fontFamily: "'Segoe UI','Microsoft YaHei',system-ui,sans-serif"
  };
}
