// 启动引导脚本必须内联在 HTML 之外：内联脚本会被严格的 CSP（script-src 'self'）拦截，
// 而主题判定又必须在首帧绘制前完成，因此放在独立文件中以阻塞脚本方式加载。
// 主题判定必须在首帧绘制前完成，避免浅色主题下闪现深色启动页
if (
  localStorage.getItem('nexious-theme') === 'light' ||
  (!localStorage.getItem('nexious-theme') &&
    window.matchMedia('(prefers-color-scheme:light)').matches)
) {
  document.body.classList.add('light');
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', '#f6f6f7');
}
// 主题风格（整套界面风格）同样在首帧前下发，启动页底色/点缀色即跟随该风格；
// 合法 id 列表需与 src/theme.ts 的 THEME_STYLES 保持一致。
const ACCENT_STYLE_IDS = ['classic', 'claw', 'knot', 'dash', 'forest', 'slate', 'paper', 'amber'];
const storedAccent = localStorage.getItem('nexious-theme-style');
if (storedAccent && ACCENT_STYLE_IDS.includes(storedAccent)) {
  document.body.dataset.accent = storedAccent;
}
// 窗口以隐藏方式启动，等启动页完成首帧绘制后再显示，避免看到空白窗口
if (window.__TAURI__) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      try {
        const api = window.__TAURI__.window;
        const current = (api.getCurrentWindow ?? api.getCurrent)?.call(api);
        current?.show()?.catch?.(() => {});
        current?.setFocus()?.catch?.(() => {});
      } catch {}
    })
  );
}
