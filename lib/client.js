/**
 * dsh-wallpaper-glass —— 浏览器半侧。
 *
 * 客户端插件 bundle（lazy-CJS factory 格式，由 dsh-client-modules 提供）。
 * 它做四件事：
 *   1. 在 #root 之下垫一层壁纸背景（视频/图片 + 模糊 + 暗化 + 暗角 + 颗粒 + 微粒）。
 *   2. 把 GUI 的大块不透明表面换成半透明玻璃，再补霓虹描边与柔光。
 *   3. 右下角一个悬浮玻璃面板：壁纸源与界面外观分开选。
 *   4. 与宿主 /wallpaper-glass/api 同步配置，跟随 Wallpaper Engine 换壁纸热切换。
 *
 * 对 React 树之外 DOM 的所有改动都记录在 markedNodes 里，卸载时完全还原。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wallpaper-glass',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const API = '/wallpaper-glass/api'

    const PRESETS = {
      clear: { label: '原图直出', tone: 'dark', blur: 0, dim: 0.1, saturate: 1.02, neon: '#8fe3ff', radius: 16, alpha: 0.5, particles: false, grain: false, scan: false, readScrim: 0.25 },
      noir: { label: '深色毛玻璃', tone: 'dark', blur: 8, dim: 0.3, saturate: 1.25, neon: '#8fe3ff', radius: 16, alpha: 0.42, particles: true, grain: true, scan: false, readScrim: 0 },
      frost: { label: '浅色磨砂', tone: 'light', blur: 10, dim: 0.16, saturate: 0.95, neon: '#4f7dfb', radius: 18, alpha: 0.5, particles: false, grain: true, scan: false, readScrim: 0 },
      cyber: { label: '赛博霓虹', tone: 'dark', blur: 5, dim: 0.5, saturate: 1.55, neon: '#ff5cf0', radius: 10, alpha: 0.36, particles: true, grain: true, scan: true, readScrim: 0 },
      minimal: { label: '极简隐去', tone: 'dark', blur: 20, dim: 0.42, saturate: 1.02, neon: '#cfd8e8', radius: 12, alpha: 0.24, particles: false, grain: false, scan: false, readScrim: 0 },
    }

    const state = {
      config: null,
      desktop: null,
      library: [],
      hidden: 0,
      server: { connected: false, we: false, dir: '' },
      panelOpen: false,
    }

    const dom = {}
    let currentWallpaperId = ''
    let lastSaveAt = 0
    let mirrorTimer = 0
    let sweepTimer = 0
    let observer = null
    let markedNodes = new Set()
    let glassBudget = 0
    let sharpMode = false
    let mediaEl = null
    let disposed = false

    const $ = (sel, root = document) => root.querySelector(sel)
    /** preview-only wallpapers (scene.pkg / web / app) cannot render in a browser, so hide them. */
    const usableLibraryItem = (item) => !!(item && (item.hasVideo || item.type === 'image'))
    const flag = (value) => (value ? '1' : '0')
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

    function log(...args) {
      try { console.log('%c[wallpaper-glass]', 'color:#8fe3ff', ...args) } catch {}
    }

    function reducedMotion() {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
    }

    // ── 与宿主通信 ──────────────────────────────────────────────────────
    async function getState(refresh) {
      const url = API + '/state' + (refresh ? '?refresh=1' : '')
      const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error('state HTTP ' + res.status)
      return res.json()
    }

    async function saveConfig(patch) {
      lastSaveAt = Date.now()
      try {
        const res = await fetch(API + '/config', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        const body = await res.json().catch(() => ({}))
        if (body && body.config) state.config = body.config
        setStatus('已保存')
      } catch (error) {
        setStatus('保存失败：' + (error && error.message ? error.message : error), true)
      }
    }

    // ── 样式 ────────────────────────────────────────────────────────────
    function styleSheet() {
      return `
#wg-bg, #wg-bg *, #wg-fab, #wg-panel, #wg-panel * { box-sizing: border-box; }
#wg-bg {
  position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none;
  background: #05070c;
}
#wg-bg[data-mode="transparent"] { display: none; }
#wg-bg .wg-frame {
  position: absolute; inset: -7%;
  transform: scale(var(--wg-zoom, 1.04));
  transition: opacity 900ms ease;
  opacity: 0;
  will-change: opacity;
}
#wg-bg .wg-frame.is-on { opacity: 1; }
#wg-bg .wg-frame > video, #wg-bg .wg-frame > img {
  width: 100%; height: 100%; object-fit: cover; display: block;
  filter: blur(var(--wg-blur, 8px)) saturate(var(--wg-sat, 1.25)) brightness(var(--wg-bright, 0.9));
  transform: translateZ(0);
}
#wg-bg .wg-frame > img[data-lowres="1"] {
  /* 预览图只有几百像素宽时，硬拉会变成大块马赛克；柔化后当背景反而自然 */
  filter: blur(calc(var(--wg-blur, 0px) + 14px)) saturate(var(--wg-sat, 1)) brightness(var(--wg-bright, 0.95)) !important;
}
#wg-bg[data-still="1"] .wg-frame.is-on > video,
#wg-bg[data-still="1"] .wg-frame.is-on > img { animation: wg-drift 52s ease-in-out infinite alternate; }
@keyframes wg-drift {
  0%   { transform: scale(1) translate3d(-0.5%, -0.3%, 0); }
  100% { transform: scale(1.05) translate3d(0.7%, 0.5%, 0); }
}
#wg-bg .wg-tint {
  position: absolute; inset: 0;
  background:
    radial-gradient(120% 80% at 12% 0%, color-mix(in srgb, var(--wg-neon) 13%, transparent), transparent 58%),
    radial-gradient(90% 70% at 96% 100%, color-mix(in srgb, var(--wg-neon) 11%, transparent), transparent 62%),
    linear-gradient(180deg, rgba(4,6,11,calc(var(--wg-dim, 0.3) * 1.1)) 0%, rgba(4,6,11,var(--wg-dim, 0.3)) 46%, rgba(2,3,7,calc(var(--wg-dim, 0.3) + 0.02)) 100%);
}
#wg-bg .wg-vignette {
  position: absolute; inset: 0;
  background: radial-gradient(130% 110% at 50% 42%, transparent 46%, rgba(0,0,0,0.22) 100%);
  mix-blend-mode: multiply;
}
/* 阅读衬底：只压正文栏那一竖条（宽度按 _centerCol 实测），壁纸边缘保持原样、不模糊 */
#wg-bg .wg-read {
  position: absolute; top: 0; bottom: 0; opacity: 0; transition: opacity 400ms ease;
  left: var(--wg-read-x, 280px);
  width: var(--wg-read-w, calc(100% - 280px));
  background: linear-gradient(180deg,
    rgba(3,6,12, calc(var(--wg-read-alpha, 0.55) * 0.95)) 0%,
    rgba(3,6,12, calc(var(--wg-read-alpha, 0.55) * 0.72)) 28%,
    rgba(3,6,12, calc(var(--wg-read-alpha, 0.55) * 0.7)) 62%,
    rgba(3,6,12, calc(var(--wg-read-alpha, 0.55) * 0.34)) 86%,
    rgba(3,6,12, 0) 100%);
  -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 18%, #000 82%, transparent 100%);
  mask-image: linear-gradient(90deg, transparent 0%, #000 18%, #000 82%, transparent 100%);
}
#wg-bg[data-read="1"] .wg-read { opacity: 1; }
#wg-bg .wg-grain {
  position: absolute; inset: 0; opacity: 0.05; mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/></filter><rect width='140' height='140' filter='url(%23n)' opacity='0.9'/></svg>");
  background-size: 180px 180px;
}
#wg-bg[data-grain="0"] .wg-grain { display: none; }
#wg-bg .wg-particles { position: absolute; inset: 0; overflow: hidden; }
#wg-bg[data-particles="0"] .wg-particles { display: none; }
#wg-bg .wg-particles i {
  position: absolute; bottom: -6%; width: 3px; height: 3px; border-radius: 50%;
  background: color-mix(in srgb, var(--wg-neon) 78%, white);
  box-shadow: 0 0 10px color-mix(in srgb, var(--wg-neon) 65%, transparent);
  opacity: 0; animation: wg-float linear infinite;
}
@keyframes wg-float {
  0% { transform: translate3d(0, 0, 0) scale(0.6); opacity: 0; }
  14% { opacity: var(--wg-p-op, 0.5); }
  86% { opacity: var(--wg-p-op, 0.5); }
  100% { transform: translate3d(var(--wg-p-x, 20px), -108vh, 0) scale(1.1); opacity: 0; }
}
#wg-bg .wg-scan {
  position: absolute; inset: 0; display: none; pointer-events: none;
  background: repeating-linear-gradient(180deg, rgba(255,255,255,0.05) 0 1px, transparent 1px 3px);
  mix-blend-mode: overlay; opacity: 0.55;
}
#wg-bg[data-scan="1"] .wg-scan { display: block; }

/* ── 把 GUI 表面玻璃化 ───────────────────────────────────────────── */
html.wg-on, html.wg-on body { background: transparent !important; }
html.wg-on #root { background: transparent !important; }
html.wg-transparent, html.wg-transparent body, html.wg-transparent #root { background: transparent !important; }
html.wg-on [data-wg-glass="panel"] {
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--wg-neon) 20%, transparent),
    inset 0 1px 0 rgba(255,255,255,0.07),
    0 24px 70px -34px rgba(0,0,0,0.85) !important;
}
html.wg-on [data-wg-glass="column"] {
  background-image: linear-gradient(101deg, rgba(4,7,12,0.5) 0%, rgba(4,7,12,0.12) 58%, rgba(4,7,12,0) 100%) !important;
  box-shadow:
    inset -1px 0 0 color-mix(in srgb, var(--wg-neon) 20%, transparent),
    inset 0 -1px 0 rgba(0,0,0,0.25) !important;
}
html.wg-on ::selection { background: color-mix(in srgb, var(--wg-neon) 45%, transparent); color: #fff; }
html.wg-on ::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--wg-neon) 26%, transparent) !important; border-radius: 8px; }
/* 原图模式：壁纸清晰时不再给文字加光晕（大半径光晕会把字衬得发虚） */
html.wg-sharp #root { text-shadow: 0 1px 1px rgba(0, 0, 0, 0.5); }
html.wg-sharp [data-wg-glass="panel"] { border-color: color-mix(in srgb, var(--wg-neon) 16%, transparent); }

/* ── 悬浮按钮 ───────────────────────────────────────────────────── */
#wg-fab {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483001;
  width: 42px; height: 42px; border-radius: 14px; cursor: pointer; padding: 0;
  display: grid; place-items: center; color: var(--wg-text, #eaf2ff);
  background: linear-gradient(160deg, rgba(22,28,40,0.86), rgba(10,14,22,0.86));
  border: 1px solid color-mix(in srgb, var(--wg-neon) 34%, transparent);
  box-shadow: 0 10px 30px rgba(0,0,0,0.45), 0 0 22px color-mix(in srgb, var(--wg-neon) 16%, transparent);
  backdrop-filter: blur(14px) saturate(150%);
  transition: transform 180ms ease, box-shadow 220ms ease, border-color 220ms ease, opacity 200ms ease;
  opacity: 0.8;
}
#wg-fab:hover { transform: translateY(-2px) scale(1.03); opacity: 1; border-color: color-mix(in srgb, var(--wg-neon) 60%, transparent); box-shadow: 0 14px 34px rgba(0,0,0,0.5), 0 0 30px color-mix(in srgb, var(--wg-neon) 30%, transparent); }
#wg-fab svg { width: 20px; height: 20px; display: block; }
#wg-fab[data-open="1"] { opacity: 1; border-color: color-mix(in srgb, var(--wg-neon) 62%, transparent); }

/* ── 面板 ───────────────────────────────────────────────────────── */
#wg-panel {
  position: fixed; right: 18px; bottom: 72px; z-index: 2147483002;
  width: 372px; max-height: min(78vh, 760px);
  display: flex; flex-direction: column; overflow: hidden;
  color: var(--wg-text, #eaf2ff);
  font: 13px/1.5 "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  background: linear-gradient(180deg, rgba(22,28,42,0.86), rgba(9,13,20,0.9));
  border: 1px solid color-mix(in srgb, var(--wg-neon) 30%, transparent);
  border-radius: 20px;
  box-shadow: 0 30px 80px rgba(0,0,0,0.62), 0 0 0 1px rgba(255,255,255,0.04), 0 0 46px color-mix(in srgb, var(--wg-neon) 14%, transparent);
  backdrop-filter: blur(30px) saturate(165%);
  transform-origin: 100% 100%;
  animation: wg-in 220ms cubic-bezier(.2,.9,.3,1);
}
#wg-panel[hidden] { display: none; }
@keyframes wg-in { from { opacity: 0; transform: translateY(10px) scale(0.97); } to { opacity: 1; transform: none; } }

#wg-panel .wg-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); }
#wg-panel .wg-mark {
  width: 26px; height: 26px; border-radius: 9px; display: grid; place-items: center; flex: none;
  background: linear-gradient(150deg, color-mix(in srgb, var(--wg-neon) 55%, transparent), color-mix(in srgb, var(--wg-neon) 12%, transparent));
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.16), 0 0 16px color-mix(in srgb, var(--wg-neon) 30%, transparent);
}
#wg-panel .wg-mark svg { width: 15px; height: 15px; color: #061018; }
#wg-panel .wg-title { font-weight: 600; letter-spacing: 0.2px; font-size: 13.5px; }
#wg-panel .wg-sub { font-size: 11px; color: rgba(234,242,255,0.5); margin-top: 1px; }
#wg-panel .wg-close { margin-left: auto; width: 26px; height: 26px; border-radius: 8px; border: 0; cursor: pointer; background: transparent; color: rgba(234,242,255,0.62); display: grid; place-items: center; }
#wg-panel .wg-close:hover { background: rgba(255,255,255,0.08); color: #fff; }
#wg-panel .wg-tabs { display: flex; gap: 6px; padding: 10px 16px 0; }
#wg-panel .wg-tab {
  flex: 1; padding: 7px 10px; border-radius: 10px; cursor: pointer; border: 1px solid transparent;
  background: rgba(255,255,255,0.04); color: rgba(234,242,255,0.66); font-size: 12.5px; transition: all 160ms ease;
}
#wg-panel .wg-tab[data-active="1"] {
  color: #fff; background: color-mix(in srgb, var(--wg-neon) 16%, rgba(255,255,255,0.04));
  border-color: color-mix(in srgb, var(--wg-neon) 40%, transparent);
  box-shadow: 0 0 18px color-mix(in srgb, var(--wg-neon) 16%, transparent);
}
#wg-panel .wg-body { padding: 12px 16px 14px; overflow: auto; flex: 1; }
#wg-panel .wg-body::-webkit-scrollbar { width: 8px; }
#wg-panel .wg-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 8px; border: 2px solid transparent; background-clip: padding-box; }

#wg-panel .wg-seg { display: flex; gap: 6px; padding: 3px; border-radius: 12px; background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.05); }
#wg-panel .wg-seg button { flex: 1; padding: 7px 6px; border-radius: 9px; border: 0; cursor: pointer; font-size: 12px; background: transparent; color: rgba(234,242,255,0.66); transition: all 150ms ease; }
#wg-panel .wg-seg button[data-active="1"] {
  color: #061018; font-weight: 600;
  background: linear-gradient(160deg, color-mix(in srgb, var(--wg-neon) 92%, white), color-mix(in srgb, var(--wg-neon) 68%, #0b1220));
  box-shadow: 0 4px 14px color-mix(in srgb, var(--wg-neon) 26%, transparent);
}
#wg-panel .wg-now { display: flex; align-items: center; gap: 9px; margin: 12px 0 10px; padding: 9px 11px; border-radius: 12px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); }
#wg-panel .wg-now .wg-thumb { width: 40px; height: 26px; border-radius: 7px; object-fit: cover; background: rgba(255,255,255,0.06); flex: none; }
#wg-panel .wg-now .wg-meta { min-width: 0; }
#wg-panel .wg-now .wg-name { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#wg-panel .wg-now .wg-hint { font-size: 11px; color: rgba(234,242,255,0.48); display: flex; align-items: center; gap: 5px; }
.wg-dot { width: 6px; height: 6px; border-radius: 50%; background: #6ee7a8; box-shadow: 0 0 8px #6ee7a8aa; flex: none; }
.wg-dot[data-off="1"] { background: #7a8698; box-shadow: none; }

#wg-panel .wg-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; margin-top: 4px; }
#wg-panel .wg-card {
  position: relative; border-radius: 11px; overflow: hidden; cursor: pointer; aspect-ratio: 16 / 10;
  border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.05); padding: 0; transition: all 160ms ease;
}
#wg-panel .wg-card img { width: 100%; height: 100%; object-fit: cover; display: block; opacity: 0.92; }
#wg-panel .wg-card:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--wg-neon) 55%, transparent); }
#wg-panel .wg-card[data-active="1"] { border-color: color-mix(in srgb, var(--wg-neon) 85%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--wg-neon) 55%, transparent), 0 6px 18px rgba(0,0,0,0.4); }
#wg-panel .wg-card .wg-cap {
  position: absolute; inset: auto 0 0 0; padding: 10px 6px 5px; font-size: 10px; line-height: 1.25;
  color: #eaf2ff; background: linear-gradient(180deg, transparent, rgba(4,7,12,0.88));
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left;
}
#wg-panel .wg-card .wg-live { position: absolute; top: 5px; left: 5px; font-size: 9px; padding: 1px 5px; border-radius: 5px; background: color-mix(in srgb, var(--wg-neon) 80%, black); color: #06121a; font-weight: 700; letter-spacing: 0.3px; }
#wg-panel .wg-empty { padding: 18px 8px; text-align: center; color: rgba(234,242,255,0.45); font-size: 12px; grid-column: 1 / -1; }

#wg-panel .wg-custom { display: none; gap: 6px; margin-top: 10px; }
#wg-panel .wg-custom[data-show="1"] { display: flex; }
#wg-panel .wg-custom input {
  flex: 1; min-width: 0; padding: 8px 10px; border-radius: 10px; font-size: 11.5px;
  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.09); color: #eaf2ff; outline: none;
}
#wg-panel .wg-custom input:focus { border-color: color-mix(in srgb, var(--wg-neon) 60%, transparent); }
#wg-panel .wg-btn { padding: 8px 12px; border-radius: 10px; font-size: 12px; cursor: pointer; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.06); color: #eaf2ff; transition: all 150ms ease; }
#wg-panel .wg-btn:hover { background: rgba(255,255,255,0.11); }
#wg-panel .wg-btn.wg-primary {
  color: #06121a; font-weight: 600; border-color: transparent;
  background: linear-gradient(160deg, color-mix(in srgb, var(--wg-neon) 95%, white), color-mix(in srgb, var(--wg-neon) 62%, #0b1220));
  box-shadow: 0 6px 20px color-mix(in srgb, var(--wg-neon) 26%, transparent);
}

#wg-panel .wg-presets { display: grid; grid-template-columns: repeat(2, 1fr); gap: 7px; }
#wg-panel .wg-preset {
  display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-radius: 11px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.07); background: rgba(255,255,255,0.04); color: rgba(234,242,255,0.78);
  font-size: 12px; transition: all 150ms ease;
}
#wg-panel .wg-preset:hover { background: rgba(255,255,255,0.08); }
#wg-panel .wg-preset[data-active="1"] {
  color: #fff; border-color: color-mix(in srgb, var(--wg-neon) 55%, transparent);
  background: color-mix(in srgb, var(--wg-neon) 13%, rgba(255,255,255,0.03));
  box-shadow: 0 0 20px color-mix(in srgb, var(--wg-neon) 14%, transparent);
}
#wg-panel .wg-preset .wg-swatch { width: 18px; height: 18px; border-radius: 6px; flex: none; border: 1px solid rgba(255,255,255,0.18); }

#wg-panel .wg-group { margin-top: 14px; }
#wg-panel .wg-group-title { font-size: 11px; letter-spacing: 0.6px; text-transform: uppercase; color: rgba(234,242,255,0.42); margin-bottom: 8px; }
#wg-panel .wg-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; }
#wg-panel .wg-row > label { flex: none; width: 52px; font-size: 12px; color: rgba(234,242,255,0.74); }
#wg-panel .wg-row .wg-val { flex: none; width: 40px; text-align: right; font-size: 11px; color: rgba(234,242,255,0.5); font-variant-numeric: tabular-nums; }
#wg-panel input[type="range"] { -webkit-appearance: none; appearance: none; flex: 1; height: 20px; background: transparent; cursor: pointer; }
#wg-panel input[type="range"]::-webkit-slider-runnable-track {
  height: 4px; border-radius: 4px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--wg-neon) 80%, transparent) var(--wg-p, 50%), rgba(255,255,255,0.12) var(--wg-p, 50%));
}
#wg-panel input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; width: 13px; height: 13px; margin-top: -4.5px; border-radius: 50%;
  background: #fff; box-shadow: 0 0 0 3px color-mix(in srgb, var(--wg-neon) 35%, transparent), 0 2px 6px rgba(0,0,0,0.5);
}
#wg-panel input[type="color"] { width: 34px; height: 24px; padding: 0; border-radius: 7px; border: 1px solid rgba(255,255,255,0.16); background: transparent; cursor: pointer; }
#wg-panel input[type="color"]::-webkit-color-swatch-wrapper { padding: 2px; }
#wg-panel input[type="color"]::-webkit-color-swatch { border: 0; border-radius: 5px; }

#wg-panel .wg-switch { display: flex; align-items: center; justify-content: space-between; padding: 7px 0; font-size: 12px; color: rgba(234,242,255,0.78); cursor: pointer; }
#wg-panel .wg-switch input { display: none; }
#wg-panel .wg-switch .wg-knob { width: 34px; height: 19px; border-radius: 999px; background: rgba(255,255,255,0.12); position: relative; transition: background 180ms ease; flex: none; }
#wg-panel .wg-switch .wg-knob::after {
  content: ""; position: absolute; top: 2.5px; left: 2.5px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; transition: transform 180ms cubic-bezier(.2,.9,.3,1); box-shadow: 0 1px 3px rgba(0,0,0,0.4);
}
#wg-panel .wg-switch input:checked + .wg-knob { background: color-mix(in srgb, var(--wg-neon) 72%, #0a1018); }
#wg-panel .wg-switch input:checked + .wg-knob::after { transform: translateX(15px); }

#wg-panel .wg-foot { display: flex; align-items: center; gap: 8px; padding: 10px 16px 12px; font-size: 11px; color: rgba(234,242,255,0.45); border-top: 1px solid rgba(255,255,255,0.06); }
#wg-panel .wg-foot .wg-status { margin-left: auto; }
#wg-panel .wg-foot .wg-status[data-error="1"] { color: #ff9c9c; }
#wg-panel .wg-tip { margin: 8px 0 2px; padding: 8px 10px; border-radius: 10px; font-size: 11px; line-height: 1.5; color: rgba(234,242,255,0.58); background: color-mix(in srgb, var(--wg-neon) 7%, transparent); border: 1px solid color-mix(in srgb, var(--wg-neon) 18%, transparent); }

html.wg-tone-light #wg-panel { background: linear-gradient(180deg, rgba(255,255,255,0.94), rgba(244,247,255,0.94)); color: #0f1420; border-color: rgba(20,40,80,0.14); box-shadow: 0 30px 70px rgba(10,20,40,0.28), 0 0 0 1px rgba(255,255,255,0.6); }
html.wg-tone-light #wg-panel .wg-sub, html.wg-tone-light #wg-panel .wg-foot, html.wg-tone-light #wg-panel .wg-now .wg-hint { color: rgba(15,20,32,0.5); }
html.wg-tone-light #wg-panel .wg-tab, html.wg-tone-light #wg-panel .wg-seg button, html.wg-tone-light #wg-panel .wg-preset, html.wg-tone-light #wg-panel .wg-row > label, html.wg-tone-light #wg-panel .wg-switch { color: rgba(15,20,32,0.72); }
html.wg-tone-light #wg-panel .wg-tab, html.wg-tone-light #wg-panel .wg-preset, html.wg-tone-light #wg-panel .wg-now, html.wg-tone-light #wg-panel .wg-seg { background: rgba(12,24,45,0.05); border-color: rgba(12,24,45,0.08); }
html.wg-tone-light #wg-panel .wg-title, html.wg-tone-light #wg-panel .wg-now .wg-name { color: #0f1420; }
html.wg-tone-light #wg-panel .wg-tip { color: rgba(15,20,32,0.62); }
html.wg-tone-light #wg-panel .wg-foot { border-top-color: rgba(12,24,45,0.08); }
`
    }

    // ── DOM ─────────────────────────────────────────────────────────────
    const ICON_LAYERS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7.5 12 3l8 4.5-8 4.5-8-4.5Z"/><path d="m4 12.2 8 4.5 8-4.5"/><path d="m4 16.7 8 4.5 8-4.5"/></svg>'
    const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>'
    const ICON_GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.05A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.05A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10 3.05V3a2 2 0 1 1 4 0v.05A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.05a1.7 1.7 0 0 0-1.55 1Z"/></svg>'

    function buildLayers() {
      const bg = document.createElement('div')
      bg.id = 'wg-bg'
      bg.setAttribute('aria-hidden', 'true')
      bg.innerHTML = [
        '<div class="wg-frame wg-frame-a"></div>',
        '<div class="wg-frame wg-frame-b"></div>',
        '<div class="wg-tint"></div>',
        '<div class="wg-vignette"></div>',
        '<div class="wg-read"></div>',
        '<div class="wg-scan"></div>',
        '<div class="wg-grain"></div>',
        '<div class="wg-particles"></div>',
      ].join('')
      const particles = $('.wg-particles', bg)
      const count = reducedMotion() ? 0 : 16
      for (let i = 0; i < count; i++) {
        const dot = document.createElement('i')
        const size = (Math.random() * 2 + 1.5).toFixed(1)
        dot.style.left = Math.round(Math.random() * 100) + '%'
        dot.style.width = size + 'px'
        dot.style.height = size + 'px'
        dot.style.animationDuration = (16 + Math.random() * 22).toFixed(1) + 's'
        dot.style.animationDelay = (-Math.random() * 30).toFixed(1) + 's'
        dot.style.setProperty('--wg-p-x', (Math.random() * 90 - 45).toFixed(0) + 'px')
        dot.style.setProperty('--wg-p-op', (0.22 + Math.random() * 0.42).toFixed(2))
        particles.appendChild(dot)
      }
      document.body.appendChild(bg)
      dom.bg = bg
      dom.frameA = $('.wg-frame-a', bg)
      dom.frameB = $('.wg-frame-b', bg)
    }

    function buildFab() {
      const fab = document.createElement('button')
      fab.id = 'wg-fab'
      fab.type = 'button'
      fab.title = '壁纸与界面外观'
      fab.innerHTML = ICON_GEAR
      fab.addEventListener('click', () => togglePanel())
      document.body.appendChild(fab)
      dom.fab = fab
    }

    function buildPanel() {
      const panel = document.createElement('div')
      panel.id = 'wg-panel'
      panel.hidden = true
      panel.innerHTML = `
<div class="wg-head">
  <div class="wg-mark">${ICON_LAYERS}</div>
  <div>
    <div class="wg-title">壁纸 × 界面</div>
    <div class="wg-sub" data-role="sub">读取中…</div>
  </div>
  <button class="wg-close" type="button" data-role="close" aria-label="关闭">${ICON_CLOSE}</button>
</div>
<div class="wg-tabs">
  <button class="wg-tab" type="button" data-tab="wall" data-active="1">壁纸</button>
  <button class="wg-tab" type="button" data-tab="look" data-active="0">外观</button>
</div>
<div class="wg-body" data-role="body">
  <section data-pane="wall">
    <div class="wg-seg" data-role="source">
      <button type="button" data-value="desktop" data-active="1">跟随桌面</button>
      <button type="button" data-value="pinned" data-active="0">壁纸库</button>
      <button type="button" data-value="custom" data-active="0">自定义</button>
    </div>
    <div class="wg-now">
      <img class="wg-thumb" data-role="thumb" alt="" />
      <div class="wg-meta">
        <div class="wg-name" data-role="name">—</div>
        <div class="wg-hint"><span class="wg-dot" data-role="dot"></span><span data-role="hint">连接中…</span></div>
      </div>
    </div>
    <div class="wg-grid" data-role="grid"></div>
    <div class="wg-custom" data-role="custom">
      <input type="text" data-role="path" placeholder="C:\\Users\\...\\wallpaper.mp4" spellcheck="false" />
      <button class="wg-btn wg-primary" type="button" data-role="applyPath">应用</button>
    </div>
    <p class="wg-tip" data-role="hintList">壁纸源与界面外观互不影响：界面可以用另一张壁纸，桌面仍是原来那张。</p>
  </section>
  <section data-pane="look" hidden>
    <div class="wg-group">
      <div class="wg-group-title">风格预设</div>
      <div class="wg-presets" data-role="presets"></div>
    </div>
    <div class="wg-group">
      <div class="wg-group-title">质感</div>
      <div class="wg-row"><label>模糊</label><input type="range" data-key="blur" min="0" max="40" step="1" /><span class="wg-val" data-val="blur"></span></div>
      <div class="wg-row"><label>暗度</label><input type="range" data-key="dim" min="0" max="0.9" step="0.02" /><span class="wg-val" data-val="dim"></span></div>
      <div class="wg-row"><label>饱和</label><input type="range" data-key="saturate" min="0.4" max="2" step="0.05" /><span class="wg-val" data-val="saturate"></span></div>
      <div class="wg-row"><label>缩放</label><input type="range" data-key="zoom" min="1" max="1.25" step="0.01" /><span class="wg-val" data-val="zoom"></span></div>
      <div class="wg-row"><label>圆角</label><input type="range" data-key="radius" min="0" max="28" step="1" /><span class="wg-val" data-val="radius"></span></div>
      <div class="wg-row"><label>衬底</label><input type="range" data-key="readScrim" min="0" max="1" step="0.05" /><span class="wg-val" data-val="readScrim"></span></div>
      <div class="wg-row"><label>点缀色</label><input type="color" data-key="neon" /><span class="wg-val"></span></div>
    </div>
    <div class="wg-group">
      <div class="wg-group-title">行为</div>
      <label class="wg-switch">强制深色玻璃<input type="checkbox" data-key="forceDark" /><span class="wg-knob"></span></label>
      <label class="wg-switch">壁纸柔化（加模糊）<input type="checkbox" data-key="soften" /><span class="wg-knob"></span></label>
      <label class="wg-switch">面板毛玻璃<input type="checkbox" data-key="blurPanels" /><span class="wg-knob"></span></label>
      <label class="wg-switch">高对比面板<input type="checkbox" data-key="contrast" /><span class="wg-knob"></span></label>
      <label class="wg-switch">漂浮微粒<input type="checkbox" data-key="particles" /><span class="wg-knob"></span></label>
      <label class="wg-switch">播放动态壁纸<input type="checkbox" data-key="mediaOn" /><span class="wg-knob"></span></label>
      <label class="wg-switch">透出桌面（透明窗口）<input type="checkbox" data-key="transparent" /><span class="wg-knob"></span></label>
    </div>
    <p class="wg-tip" data-role="tip">透明窗口需要先运行 tools/asar-patch.mjs apply 打补丁并重启 DSH；没打补丁时勾选只会去掉内置壁纸层。</p>
  </section>
</div>
<div class="wg-foot">
  <span data-role="engine">Wallpaper Engine</span>
  <span class="wg-status" data-role="status"></span>
</div>`
      document.body.appendChild(panel)
      dom.panel = panel
      dom.sub = $('[data-role="sub"]', panel)
      dom.grid = $('[data-role="grid"]', panel)
      dom.custom = $('[data-role="custom"]', panel)
      dom.path = $('[data-role="path"]', panel)
      dom.name = $('[data-role="name"]', panel)
      dom.hint = $('[data-role="hint"]', panel)
      dom.dot = $('[data-role="dot"]', panel)
      dom.thumb = $('[data-role="thumb"]', panel)
      dom.status = $('[data-role="status"]', panel)
      dom.engine = $('[data-role="engine"]', panel)
      dom.tip = $('[data-role="tip"]', panel)
      dom.presets = $('[data-role="presets"]', panel)

      $('[data-role="close"]', panel).addEventListener('click', () => togglePanel(false))
      for (const tab of panel.querySelectorAll('.wg-tab')) tab.addEventListener('click', () => switchTab(tab.dataset.tab))
      for (const btn of $('[data-role="source"]', panel).querySelectorAll('button')) {
        btn.addEventListener('click', () => onSourceChange(btn.dataset.value))
      }
      $('[data-role="applyPath"]', panel).addEventListener('click', onApplyPath)
      dom.path.addEventListener('keydown', (event) => { if (event.key === 'Enter') onApplyPath() })

      for (const [key, preset] of Object.entries(PRESETS)) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'wg-preset'
        btn.dataset.preset = key
        btn.dataset.active = '0'
        const swatch = document.createElement('span')
        swatch.className = 'wg-swatch'
        swatch.style.background = 'linear-gradient(140deg, ' + preset.neon + ', rgba(12,16,24,0.9))'
        const label = document.createElement('span')
        label.textContent = preset.label
        btn.append(swatch, label)
        btn.addEventListener('click', () => applyPreset(key))
        dom.presets.appendChild(btn)
      }

      for (const input of panel.querySelectorAll('input[data-key]')) {
        const key = input.dataset.key
        const handler = () => onControlChange(input, key)
        input.addEventListener(input.type === 'range' || input.type === 'color' ? 'input' : 'change', handler)
      }
      panel.addEventListener('wheel', (event) => event.stopPropagation())
    }

    function switchTab(tab) {
      for (const btn of dom.panel.querySelectorAll('.wg-tab')) btn.dataset.active = flag(btn.dataset.tab === tab)
      for (const pane of dom.panel.querySelectorAll('section[data-pane]')) pane.hidden = pane.dataset.pane !== tab
    }

    function togglePanel(force) {
      const open = force === undefined ? dom.panel.hidden : force
      state.panelOpen = open
      dom.panel.hidden = !open
      dom.fab.dataset.open = flag(open)
      if (open) { refreshState(false); renderPanel() }
    }

    // ── 主题变量 ────────────────────────────────────────────────────────
    function presetOf(key) {
      return PRESETS[key] || PRESETS.noir
    }

    function applyTheme() {
      const cfg = state.config || {}
      const style = cfg.style || {}
      const preset = presetOf(style.preset)
      const root = document.documentElement
      const light = preset.tone === 'light'
      const neon = style.neon || preset.neon
      const alpha = Number.isFinite(style.panelAlpha) ? style.panelAlpha : preset.alpha
      const radius = clamp(Number(style.radius ?? preset.radius), 0, 28)

      root.style.setProperty('--wg-neon', neon)
      root.style.setProperty('--wg-blur', clamp(Number(style.blur ?? preset.blur), 0, 60) + 'px')
      root.style.setProperty('--wg-sat', String(clamp(Number(style.saturate ?? preset.saturate), 0.2, 2.5)))
      root.style.setProperty('--wg-dim', String(clamp(Number(style.dim ?? preset.dim), 0, 0.95)))
      root.style.setProperty('--wg-bright', String(clamp(1 - Number(style.dim ?? preset.dim) * 0.35, 0.45, 1)))
      root.style.setProperty('--wg-zoom', String(clamp(Number(style.zoom ?? 1.04), 1, 1.4)))
      root.style.setProperty('--wg-radius', radius + 'px')
      root.style.setProperty('--wg-text', light ? '#0f1420' : '#eaf2ff')

      root.classList.add('wg-on')
      root.classList.toggle('wg-tone-light', light)
      const blurPx = clamp(Number(style.blur ?? preset.blur), 0, 60)
      sharpMode = blurPx <= 3
      root.classList.toggle('wg-sharp', sharpMode)
      const transparent = cfg.mode === 'transparent'
      root.classList.toggle('wg-transparent', transparent)
      if (dom.bg) {
        dom.bg.dataset.mode = transparent ? 'transparent' : 'builtin'
        dom.bg.dataset.particles = flag(style.particles !== false && !reducedMotion())
        dom.bg.dataset.grain = flag(style.grain !== false)
        dom.bg.dataset.scan = flag(style.scan === true || (style.preset === 'cyber'))
        const scrim = clamp(Number(style.readScrim ?? preset.readScrim ?? 0), 0, 1)
        root.style.setProperty('--wg-read-alpha', String(scrim))
        dom.bg.dataset.read = flag(blurPx <= 3 && scrim > 0.02)
      }

      const effective = style.contrast ? Math.min(0.9, alpha + 0.28) : alpha
      const fill = light
        ? `rgba(255,255,255,${(effective + 0.16).toFixed(2)})`
        : `rgba(12,16,24,${effective.toFixed(2)})`
      root.style.setProperty('--wg-surface', fill)
      root.style.setProperty('--wg-surface-chrome', light
        ? `rgba(255,255,255,${Math.min(0.94, effective + 0.3).toFixed(2)})`
        : `rgba(12,16,24,${Math.min(0.88, effective + 0.2).toFixed(2)})`)
      root.style.setProperty('--wg-surface-solid', light
        ? `rgba(255,255,255,${Math.min(0.96, effective + 0.34).toFixed(2)})`
        : `rgba(12,16,24,${Math.min(0.9, effective + 0.34).toFixed(2)})`)
      root.style.setProperty('--wg-surface-blur', light
        ? `rgba(255,255,255,${Math.min(0.92, effective + 0.2).toFixed(2)})`
        : `rgba(12,16,24,${Math.min(0.86, effective + 0.22).toFixed(2)})`)
      root.style.setProperty('--wg-surface-col', light
        ? `rgba(255,255,255,${Math.max(0.3, effective - 0.04).toFixed(2)})`
        : `rgba(9,13,20,${Math.max(0.38, effective - 0.02).toFixed(2)})`)

      applyForceDark(style.forceDark !== false && !light)
      if (transparent || style.blurPanels === false) {
        for (const el of document.querySelectorAll('[data-wg-blur]')) {
          el.style.removeProperty('backdrop-filter')
          el.style.removeProperty('-webkit-backdrop-filter')
          delete el.dataset.wgBlur
        }
      }
      scheduleSweep()
    }

    // in dark glass mode the stock secondary/tertiary greys are too dim over a bright wallpaper
    const LABEL_TOKENS = [
      ['--dsw-alias-label-secondary', 'rgba(238,244,255,0.92)'],
      ['--dsw-alias-label-tertiary', 'rgba(228,236,250,0.72)'],
      ['--dsw-alias-label-quaternary', 'rgba(220,230,248,0.6)'],
    ]

    function applyLabelBoost(on) {
      const body = document.body
      if (!body) return
      for (const [name, value] of LABEL_TOKENS) {
        if (on) body.style.setProperty(name, value, 'important')
        else body.style.removeProperty(name)
      }
    }

    function applyForceDark(on) {
      const body = document.body
      if (!body) return
      if (on) {
        if (!body.hasAttribute('data-ds-dark-theme')) body.setAttribute('data-ds-dark-theme', '')
        applyLabelBoost(true)
      } else {
        if (body.hasAttribute('data-ds-dark-theme')) body.removeAttribute('data-ds-dark-theme')
        applyLabelBoost(false)
      }
    }

    // ── 背景媒体 ────────────────────────────────────────────────────────
    function mediaUrlFor(item) {
      if (!item) return ''
      const cfg = state.config || {}
      if (item.hasVideo && cfg.mediaOn !== false) return item.mediaUrl || item.previewUrl || ''
      return item.previewUrl || item.mediaUrl || ''
    }

    function createMedia(item, url) {
      const useVideo = !!(item && item.hasVideo && state.config && state.config.mediaOn !== false)
      if (useVideo) {
        const video = document.createElement('video')
        video.autoplay = true
        video.muted = true
        video.loop = true
        video.playsInline = true
        video.preload = 'auto'
        video.setAttribute('muted', '')
        video.src = url
        video.addEventListener('error', () => {
          log('视频加载失败，回退到预览图', item && item.id)
          if (item && item.previewUrl && item.previewUrl !== url && video.parentElement) {
            const img = document.createElement('img')
            img.src = item.previewUrl
            img.alt = ''
            video.parentElement.replaceChild(img, video)
            mediaEl = img
          }
        })
        return video
      }
      const img = document.createElement('img')
      img.src = url
      img.alt = ''
      img.decoding = 'async'
      img.addEventListener('load', () => {
        try {
          const need = window.innerWidth * 0.9
          if (img.naturalWidth && img.naturalWidth < need) img.dataset.lowres = '1'
        } catch {}
      })
      return img
    }

    function applyWallpaper(item) {
      if (!dom.bg) return
      const url = mediaUrlFor(item)
      if (!url) {
        dom.frameA.innerHTML = ''
        dom.frameB.innerHTML = ''
        currentWallpaperId = ''
        return
      }
      const target = dom.frameA.classList.contains('is-on') ? dom.frameB : dom.frameA
      const other = target === dom.frameA ? dom.frameB : dom.frameA
      target.innerHTML = ''
      mediaEl = createMedia(item, url)
      target.appendChild(mediaEl)
      dom.bg.dataset.still = flag(!(item && item.hasVideo && state.config && state.config.mediaOn !== false))
      requestAnimationFrame(() => {
        target.classList.add('is-on')
        other.classList.remove('is-on')
      })
      currentWallpaperId = item.id || ''
    }

    // ── 玻璃化扫描 ──────────────────────────────────────────────────────
    function parseAlpha(color) {
      if (!color || color === 'transparent') return 0
      const m = color.match(/rgba?\(([^)]+)\)/)
      if (!m) return 0
      const parts = m[1].split(',').map((v) => v.trim())
      return parts.length < 4 ? 1 : Number(parts[3])
    }

    function blurAllowed() {
      const style = (state.config && state.config.style) || {}
      if (style.blurPanels === false) return false
      if (state.config && state.config.mode === 'transparent') return false
      return true
    }

    function insideScroll(el) {
      return !!(el.closest && el.closest('[class*="scrollBody"]'))
    }

    /** 这个面板里装着输入编辑器吗（输入框在会话页贴底、在新会话页居中，只能按内容找）。 */
    function holdsComposer(el) {
      const editor = document.querySelector('[contenteditable="true"], textarea')
      return !!(editor && el.contains(editor))
    }

    const isModalNow = (el) => !!(el && el.closest && el.closest('[class*="overlay"], [role="dialog"], [class*="_dialog"]'))

    function paintSurface(el, kind) {
      if (!el || el.id === 'wg-panel' || el.id === 'wg-fab' || el.id === 'wg-bg') return
      if (el.closest && el.closest('#wg-panel')) return
      if (kind === 'clear') {
        el.style.setProperty('background-color', 'transparent', 'important')
        el.style.setProperty('background-image', 'none', 'important')
        delete el.dataset.wgGlass
        el.dataset.wgClear = '1'
        markedNodes.add(el)
        return
      }
      delete el.dataset.wgClear
      if (kind === 'panel' || kind === 'column') el.style.setProperty('background-image', 'none', 'important')
      const selfRect = el.getBoundingClientRect()
      const isBar = kind === 'bar'
      const modalSolid = isModalNow(el) && !blurAllowed()
      el.style.setProperty('background-color', (kind === 'column' || isBar)
        ? (isBar ? 'var(--wg-surface-chrome, rgba(12,16,24,0.7))' : 'var(--wg-surface-col, rgba(10,14,22,0.3))')
        : (selfRect.height <= 96 ? 'var(--wg-surface-chrome, rgba(12,16,24,0.7))'
          : modalSolid ? 'var(--wg-surface-solid, rgba(12,16,24,0.84))' : 'var(--wg-surface, rgba(12,16,24,0.42))'), 'important')
      if (kind === 'panel') el.style.setProperty('border-radius', 'var(--wg-radius, 16px)', 'important')
      // 毛玻璃只给「对话滚动区之外」的面板：输入框、对话框、菜单、卡片。
      // 对话里的代码块/工具卡是 800px 宽的横条，一张张叠下来会把整个正文区糊成一块，
      // 所以按 scrollBody 祖先排除掉，而不是按尺寸猜。
      const blurRect = el.getBoundingClientRect()
      const blurSmall = blurRect.width * blurRect.height < window.innerWidth * window.innerHeight * 0.18
        && blurRect.height < window.innerHeight * 0.55
      const isModal = !!(el.closest && el.closest('[class*="overlay"], [role="dialog"], [class*="_dialog"]'))
      // modals may blur their own backdrop even when large: that only blurs behind the dialog, not the main UI
      if (kind === 'panel' && glassBudget > 0 && blurAllowed() && (blurSmall || isModal) && (!insideScroll(el) || holdsComposer(el))) {
        el.style.setProperty('background-color', 'var(--wg-surface-blur, rgba(12,16,24,0.72))', 'important')
        el.style.setProperty('backdrop-filter', 'blur(18px) saturate(150%)', 'important')
        el.style.setProperty('-webkit-backdrop-filter', 'blur(18px) saturate(150%)', 'important')
        glassBudget--
        el.dataset.wgBlur = '1'
      }
      el.dataset.wgGlass = kind
      markedNodes.add(el)
    }

    function measureReadingBand() {
      const root = document.documentElement
      const center = document.querySelector('[class*="_centerCol"]')
      if (!center) return
      const rect = center.getBoundingClientRect()
      if (rect.width < 200) return
      root.style.setProperty('--wg-read-x', Math.round(rect.left) + 'px')
      root.style.setProperty('--wg-read-w', Math.round(rect.width) + 'px')
    }

    function sweepSurfaces() {
      if (disposed || !document.body) return
      measureReadingBand()
      const style = (state.config && state.config.style) || {}
      const transparentMode = !!(state.config && state.config.mode === 'transparent')
      glassBudget = 22
      const vw = window.innerWidth || 1
      const vh = window.innerHeight || 1
      const total = vw * vh
      // modal layers: full-screen fixed portals that do NOT wrap the app frame
      const modalLayers = new Set()
      for (const node of document.body.querySelectorAll('*')) {
        if (node.closest && (node.closest('#wg-bg') || node.closest('#wg-panel'))) continue
        const ns = window.getComputedStyle(node)
        if (ns.position !== 'fixed') continue
        const nr = node.getBoundingClientRect()
        if (nr.width < vw * 0.8 || nr.height < vh * 0.8) continue
        if (node.querySelector && node.querySelector('[class*="_centerCol"], [class*="_frame"]')) continue
        modalLayers.add(node)
      }
      for (const el of document.body.querySelectorAll('*')) {
        if (el.id && el.id.indexOf('wg-') === 0) continue
        if (el.closest && (el.closest('#wg-panel') || el.closest('#wg-fab') || el.closest('#wg-bg'))) continue
        if (modalLayers.size) {
          let up = el.parentElement
          let depth = 0
          let inside = false
          while (up && depth < 30) {
            if (modalLayers.has(up)) { inside = true; break }
            up = up.parentElement
            depth++
          }
          // direct child of the modal layer is the dialog shell: keep it; everything deeper is the app's own surface
          if (inside && up !== el.parentElement) continue
        }
        const rect = el.getBoundingClientRect()
        const area = rect.width * rect.height
        if (rect.width < 24 || rect.height < 6) continue
        // scrims can be small (e.g. a 264x24 sidebar fade), so test them before the area gate
        let cs = null
        let alpha = 0
        let gradient = false
        if (rect.height <= 220 && rect.width >= 100) {
          cs = window.getComputedStyle(el)
          alpha = parseAlpha(cs.backgroundColor)
          gradient = !!(cs.backgroundImage && cs.backgroundImage.indexOf('gradient') !== -1)
          if (gradient && alpha < 0.3) { paintSurface(el, 'clear'); continue }
        }
        // narrow tab strips / toolbars are small by area but still need a readable backing
        const chromeLike = rect.height <= 96 && rect.width >= 80
        if (!chromeLike && (area < total * 0.02 || rect.height < 24)) continue
        if (chromeLike && rect.height < 18) continue
        if (!cs) {
          cs = window.getComputedStyle(el)
          alpha = parseAlpha(cs.backgroundColor)
          gradient = !!(cs.backgroundImage && cs.backgroundImage.indexOf('gradient') !== -1)
        }
        // 渐隐遮罩：颜色是透明的，但渐变本身不透明。正文底部/输入框下面那条就是这种，
        // short scrims were already cleared above; full-screen dim masks must stay
        // edge chrome rows (header strip, status row) are often transparent but still need a backing
        if (alpha < 0.3) continue
        const radius = parseFloat(cs.borderRadius) || 0
        const tall = rect.height > vh * 0.75
        const veryTall = rect.height > vh * 0.8
        const widePane = rect.width > vw * 0.6
        const narrowColumn = rect.width < vw * 0.28
        const fullScreenBoard = area > total * 0.55 && radius < 10
        // a real layout column touches both edges AND is not inside a modal layer
        const inModal = !!(el.closest && el.closest('[class*="overlay"], [class*="_dialog"], [role="dialog"]'))
        const spansVertically = !inModal && rect.top <= 48 && rect.bottom >= vh - 6

        if (transparentMode) {
          if (alpha >= 0.85 && (fullScreenBoard || tall)) paintSurface(el, 'clear')
          continue
        }
        const insideGlass = !!(el.parentElement && el.parentElement.closest && el.parentElement.closest('[data-wg-glass]'))
        if (insideGlass) {
          // 玻璃面板里再叠一层大面积不透明底会黑成一块；小控件（按钮等）保持原样。
          // small chrome (tab strips, toolbars) inside a glass pane still gets its own backing
          if (rect.height <= 96 && rect.width >= 80) { paintSurface(el, 'panel'); continue }
          if (area > total * 0.012 && alpha >= 0.55) paintSurface(el, 'clear')
          continue
        }
        if (fullScreenBoard && alpha >= 0.85) paintSurface(el, 'clear')   // 不透明整屏底板
        else if (fullScreenBoard) continue                                 // 半透明遮罩：保留焦点感
        else if (veryTall && widePane && spansVertically) paintSurface(el, 'clear')            // 正文栏（含桌面标题栏留白）：清透，壁纸保持锐利
        else if (veryTall && narrowColumn && spansVertically) paintSurface(el, 'column')       // 侧栏整列：上底色，不切圆角
        else if (chromeLike) paintSurface(el, 'panel')                      // tab strips / toolbars
        else if (radius >= 10) paintSurface(el, 'panel')                    // 圆角面板 / 对话框 / 卡片
        else if (tall && narrowColumn && area > total * 0.05) paintSurface(el, 'column')
        else if (tall) paintSurface(el, 'clear')
        else if (area > total * 0.08) paintSurface(el, 'panel')
      }
      for (const el of document.querySelectorAll('[class*="_sidebarCol"], [class*="_dialog"]')) {
        if (markedNodes.has(el)) continue
        if (el.parentElement && el.parentElement.closest && el.parentElement.closest('[data-wg-glass]')) continue
        const rect = el.getBoundingClientRect()
        paintSurface(el, rect.height > vh * 0.7 ? 'column' : 'panel')
      }
    }

    function scheduleSweep() {
      if (sweepTimer || disposed) return
      sweepTimer = setTimeout(() => {
        sweepTimer = 0
        try { sweepSurfaces() } catch (error) { log('sweep failed', error) }
      }, 200)
    }

    function undoSurfaces() {
      for (const el of markedNodes) {
        try {
          el.style.removeProperty('background-color')
          el.style.removeProperty('background-image')
          el.style.removeProperty('border-radius')
          el.style.removeProperty('backdrop-filter')
          el.style.removeProperty('-webkit-backdrop-filter')
          delete el.dataset.wgGlass
          delete el.dataset.wgClear
          delete el.dataset.wgBlur
        } catch {}
      }
      markedNodes = new Set()
    }

    function installObserver() {
      if (observer) return
      observer = new MutationObserver((records) => {
        if (disposed) return
        let relevant = false
        for (const record of records) {
          if (record.type === 'childList') { relevant = true; break }
          if (record.type === 'attributes' && record.attributeName === 'data-ds-dark-theme') { relevant = true; break }
        }
        if (!relevant) return
        const style = (state.config && state.config.style) || {}
        if (style.forceDark !== false && presetOf(style.preset).tone !== 'light') applyForceDark(true)
        scheduleSweep()
      })
      // observe() 对同一节点是替换语义，所以 childList 与 attributes 必须一次给全。
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-ds-dark-theme'],
      })
    }

    // ── 面板渲染 ────────────────────────────────────────────────────────
    function setStatus(text, error) {
      if (!dom.status) return
      dom.status.textContent = text || ''
      dom.status.dataset.error = error ? '1' : '0'
    }

    function formatValue(key, value) {
      if (key === 'dim' || key === 'saturate' || key === 'zoom' || key === 'readScrim') return Math.round(value * 100) + '%'
      if (key === 'blur' || key === 'radius') return Math.round(value) + 'px'
      return String(value)
    }

    function syncControls() {
      if (!dom.panel || !state.config) return
      const cfg = state.config
      const style = cfg.style || {}
      const preset = presetOf(style.preset)
      for (const btn of dom.panel.querySelectorAll('[data-role="source"] button')) btn.dataset.active = flag(btn.dataset.value === cfg.source)
      dom.custom.dataset.show = flag(cfg.source === 'custom')
      if (dom.path && document.activeElement !== dom.path) dom.path.value = cfg.customPath || ''
      for (const btn of dom.presets.querySelectorAll('.wg-preset')) btn.dataset.active = flag(btn.dataset.preset === style.preset)

      const values = {
        blur: style.blur ?? preset.blur,
        dim: style.dim ?? preset.dim,
        saturate: style.saturate ?? preset.saturate,
        zoom: style.zoom ?? 1.04,
        radius: style.radius ?? preset.radius,
        readScrim: style.readScrim ?? preset.readScrim ?? 0,
        neon: style.neon || preset.neon,
      }
      for (const input of dom.panel.querySelectorAll('input[data-key]')) {
        const key = input.dataset.key
        if (input.type === 'checkbox') {
          if (key === 'mediaOn') input.checked = cfg.mediaOn !== false
          else if (key === 'transparent') input.checked = cfg.mode === 'transparent'
          else if (key === 'soften') input.checked = Number(style.blur ?? preset.blur) > 3
          else if (key === 'contrast') input.checked = style.contrast === true
          else if (key === 'readScrim') input.checked = style.readScrim !== false
          else input.checked = style[key] !== false
          continue
        }
        if (values[key] === undefined) continue
        input.value = values[key]
        if (input.type === 'range') {
          const pct = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100
          input.style.setProperty('--wg-p', pct + '%')
          const label = dom.panel.querySelector('[data-val="' + key + '"]')
          if (label) label.textContent = formatValue(key, Number(input.value))
        }
      }
    }

    function renderLibrary() {
      if (!dom.grid) return
      dom.grid.innerHTML = ''
      const items = state.library || []
      if (!items.length) {
        const empty = document.createElement('div')
        empty.className = 'wg-empty'
        empty.textContent = state.server.we
          ? '壁纸库是空的：Wallpaper Engine 里还没订阅壁纸。'
          : '没找到 Wallpaper Engine，先启动它，或改用自定义文件。'
        dom.grid.appendChild(empty)
        return
      }
      const cfg = state.config || {}
      for (const item of items.slice(0, 60)) {
        const card = document.createElement('button')
        card.type = 'button'
        card.className = 'wg-card'
        card.dataset.active = flag(cfg.source === 'pinned' && cfg.pinnedId === item.id)
        card.title = item.title
        const img = document.createElement('img')
        img.loading = 'lazy'
        img.decoding = 'async'
        img.src = item.previewUrl || item.mediaUrl
        img.alt = ''
        const cap = document.createElement('span')
        cap.className = 'wg-cap'
        cap.textContent = item.title
        card.append(img, cap)
        if (item.hasVideo) {
          const live = document.createElement('span')
          live.className = 'wg-live'
          live.textContent = '动态'
          card.appendChild(live)
        }
        card.addEventListener('click', async () => {
          state.config = { ...(state.config || {}), source: 'pinned', pinnedId: item.id }
          applyWallpaper(item)
          renderPanel()
          await saveConfig({ source: 'pinned', pinnedId: item.id })
        })
        dom.grid.appendChild(card)
      }
    }

    function currentItem() {
      const cfg = state.config || {}
      if (cfg.source === 'pinned') return (state.library || []).find((row) => row.id === cfg.pinnedId) || state.desktop
      if (cfg.source === 'custom') return state.desktop
      return state.desktop
    }

    function renderNow() {
      const cfg = state.config || {}
      const item = currentItem()
      if (dom.name) dom.name.textContent = item ? item.title : '没有可用的壁纸'
      if (dom.thumb) {
        const src = item && (item.previewUrl || item.mediaUrl)
        if (src) { dom.thumb.src = src; dom.thumb.style.visibility = 'visible' } else { dom.thumb.removeAttribute('src'); dom.thumb.style.visibility = 'hidden' }
      }
      if (dom.dot) dom.dot.dataset.off = flag(!state.server.we)
      if (dom.hint) {
        const parts = []
        if (cfg.source === 'custom') parts.push('自定义文件')
        else if (cfg.source === 'pinned') parts.push('已固定')
        else parts.push(state.server.we ? '跟随桌面' : '桌面静图')
        if (item && item.type === 'scene') parts.push('场景壁纸：只有预览图，会偏糊')
        parts.push(state.server.we ? 'Wallpaper Engine 已连接' : 'Wallpaper Engine 未连接')
        dom.hint.textContent = parts.join(' · ')
      }
      if (dom.engine) dom.engine.textContent = state.server.we ? 'Wallpaper Engine' : 'Windows 桌面'
    }

    function renderPanel() {
      if (!dom.panel || !state.config) return
      syncControls()
      renderLibrary()
      renderNow()
      const tip = $('[data-role="hintList"]', dom.panel)
      if (tip) {
        tip.textContent = state.hidden > 0
          ? '壁纸源与界面外观互不影响；已隐藏 ' + state.hidden + ' 个只有预览图的壁纸（scene.pkg / 网页 / 程序类），浏览器渲染不了。'
          : '壁纸源与界面外观互不影响：界面可以用另一张壁纸，桌面仍是原来那张。'
      }
    }

    // ── 交互 ────────────────────────────────────────────────────────────
    async function onSourceChange(source) {
      if (!state.config) return
      state.config = { ...state.config, source }
      if (source === 'pinned') {
        const item = (state.library || []).find((row) => row.id === state.config.pinnedId) || (state.library || [])[0]
        if (item) { state.config.pinnedId = item.id; applyWallpaper(item) }
        else applyWallpaper(state.desktop)
      } else if (source === 'desktop') {
        applyWallpaper(state.desktop)
      }
      renderPanel()
      await saveConfig({ source })
      if (source === 'custom' && dom.path) dom.path.focus()
    }

    async function onApplyPath() {
      const value = String(dom.path.value || '').trim()
      if (!value) return
      setStatus('检查文件…')
      try {
        const res = await fetch(API + '/probe?path=' + encodeURIComponent(value), { credentials: 'same-origin' })
        const body = await res.json()
        if (!body.ok) { setStatus(body.error || '文件不可用', true); return }
        state.config = { ...state.config, source: 'custom', customPath: value }
        await saveConfig({ source: 'custom', customPath: value })
        await refreshState(true)
        setStatus('已应用')
      } catch (error) {
        setStatus('检查失败：' + (error.message || error), true)
      }
    }

    async function applyPreset(key) {
      const preset = PRESETS[key]
      if (!preset) return
      state.config = {
        ...state.config,
        style: {
          ...(state.config.style || {}),
          preset: key,
          blur: preset.blur,
          dim: preset.dim,
          saturate: preset.saturate,
          neon: preset.neon,
          radius: preset.radius,
          panelAlpha: preset.alpha,
          particles: preset.particles,
          grain: preset.grain,
          scan: preset.scan,
          readScrim: preset.readScrim,
        },
      }
      applyTheme()
      renderPanel()
      await saveConfig({ style: state.config.style })
    }

    let saveTimer = 0
    function onControlChange(input, key) {
      if (!state.config) return
      if (key === 'transparent') {
        state.config = { ...state.config, mode: input.checked ? 'transparent' : 'builtin' }
        applyTheme()
        saveConfig({ mode: state.config.mode })
        return
      }
      if (key === 'mediaOn') {
        state.config = { ...state.config, mediaOn: input.checked }
        applyTheme()
        applyWallpaper(currentItem())
        saveConfig({ mediaOn: input.checked })
        return
      }
      if (key === 'soften') {
        const next = { ...(state.config.style || {}), blur: input.checked ? 10 : 0 }
        state.config = { ...state.config, style: next }
        applyTheme()
        renderPanel()
        saveConfig({ style: next })
        return
      }
      const value = input.type === 'checkbox' ? input.checked : input.type === 'range' ? Number(input.value) : input.value
      if (input.type === 'range') {
        const pct = ((Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100
        input.style.setProperty('--wg-p', pct + '%')
        const label = dom.panel.querySelector('[data-val="' + key + '"]')
        if (label) label.textContent = formatValue(key, Number(input.value))
      }
      state.config = { ...state.config, style: { ...(state.config.style || {}), [key]: value } }
      applyTheme()
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => saveConfig({ style: state.config.style }), 260)
      if (key === 'particles') renderPanel()
    }

    // ── 数据同步 ────────────────────────────────────────────────────────
    async function refreshState(force) {
      try {
        const data = await getState(force)
        state.config = data.config
        state.desktop = data.desktop
        const rawLibrary = data.library || []
        state.library = rawLibrary.filter(usableLibraryItem)
        state.hidden = Math.max(rawLibrary.length - state.library.length, (data.counts && data.counts.hidden) || 0)
        // if the pinned wallpaper is hidden (preview-only), fall back to desktop
        if (state.config && state.config.source === 'pinned' && !state.library.some((x) => x.id === state.config.pinnedId)) {
          state.config = { ...state.config, source: 'desktop', pinnedId: '' }
          saveConfig({ source: 'desktop', pinnedId: '' })
        }
        state.server = {
          connected: true,
          we: !!(data.wallpaperEngine && data.wallpaperEngine.connected && data.wallpaperEngine.running),
          dir: data.wallpaperEngine ? data.wallpaperEngine.dir : '',
        }
        applyTheme()
        const item = currentItem()
        if (item && item.id !== currentWallpaperId) applyWallpaper(item)
        else if (!item) applyWallpaper(null)
        if (dom.sub) dom.sub.textContent = state.server.we ? 'Wallpaper Engine 已连接' : 'Windows 桌面壁纸'
        if (state.panelOpen) renderPanel()
        setStatus('已连接')
      } catch (error) {
        state.server = { connected: false, we: false, dir: '' }
        setStatus('插件后端未就绪', true)
        if (dom.hint) dom.hint.textContent = '后端未连接'
        log('state failed', error)
      }
    }

    function startMirroring() {
      stopMirroring()
      mirrorTimer = setInterval(async () => {
        if (disposed) return
        const cfg = state.config
        if (!cfg) return
        try {
          const data = await getState(false)
          // 1) 外部改了配置（手改 config.json / 另一个窗口）：同步过来并即时生效。
          if (Date.now() - lastSaveAt > 4000 && configSignature(data.config) !== configSignature(state.config)) {
            state.config = data.config
            state.desktop = data.desktop
            const raw2 = data.library || state.library
            state.library = raw2.filter(usableLibraryItem)
            state.hidden = raw2.length - state.library.length
            applyTheme()
            const item = currentItem()
            if (item && item.id !== currentWallpaperId) applyWallpaper(item)
            if (state.panelOpen) renderPanel()
            return
          }
          // 2) 跟随桌面壁纸：WE 换图就热切换。
          if (state.config.source !== 'desktop') return
          if (data.desktop && data.desktop.id !== currentWallpaperId) {
            state.desktop = data.desktop
            const raw3 = data.library || state.library
            state.library = raw3.filter(usableLibraryItem)
            state.hidden = raw3.length - state.library.length
            applyWallpaper(data.desktop)
            if (state.panelOpen) renderPanel()
          }
        } catch {}
      }, 5000)
    }

    function configSignature(config) {
      if (!config) return ''
      const style = config.style || {}
      return JSON.stringify([
        config.mode, config.source, config.pinnedId, config.customPath, config.mediaOn,
        style.preset, style.blur, style.dim, style.saturate, style.zoom, style.neon,
        style.radius, style.panelAlpha, style.forceDark, style.particles, style.blurPanels, style.grain, style.scan, style.readScrim, style.contrast,
      ])
    }

    function stopMirroring() {
      if (mirrorTimer) { clearInterval(mirrorTimer); mirrorTimer = 0 }
    }

    // ── 生命周期 ────────────────────────────────────────────────────────
    const BUILD_ID = '2026-11-09T08:30'

    function mount() {
      try { window.__WALLPAPER_GLASS_VERSION__ = BUILD_ID } catch {}
      if (document.getElementById('wg-bg')) return
      const style = document.createElement('style')
      style.id = 'wg-style'
      style.dataset.pluginCss = 'dsh-wallpaper-glass/theme.css'
      style.textContent = styleSheet()
      document.head.appendChild(style)
      dom.style = style

      buildLayers()
      buildFab()
      buildPanel()
      installObserver()
      window.addEventListener('resize', scheduleSweep)
      document.addEventListener('keydown', onKeydown)

      refreshState(true).then(startMirroring)
      scheduleSweep()
      setTimeout(scheduleSweep, 1200)
      setTimeout(scheduleSweep, 3200)
      log('mounted')
    }

    function onKeydown(event) {
      if (event.key === 'Escape' && state.panelOpen) togglePanel(false)
    }

    function unmount() {
      disposed = true
      stopMirroring()
      clearTimeout(sweepTimer)
      clearTimeout(saveTimer)
      if (observer) { observer.disconnect(); observer = null }
      window.removeEventListener('resize', scheduleSweep)
      document.removeEventListener('keydown', onKeydown)
      undoSurfaces()
      const root = document.documentElement
      root.classList.remove('wg-on', 'wg-transparent', 'wg-tone-light', 'wg-sharp')
      for (const key of ['--wg-neon', '--wg-blur', '--wg-sat', '--wg-dim', '--wg-bright', '--wg-zoom', '--wg-text', '--wg-surface', '--wg-surface-col', '--wg-surface-blur', '--wg-surface-chrome', '--wg-surface-solid', '--wg-radius']) {
        root.style.removeProperty(key)
      }
      for (const node of [dom.panel, dom.fab, dom.bg, dom.style]) { try { node && node.remove() } catch {} }
      dom.panel = dom.fab = dom.bg = dom.style = null
      log('unmounted')
    }

    function apply(ctx) {
      if (typeof document === 'undefined') return
      const start = () => { try { mount() } catch (error) { log('mount failed', error) } }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
      else start()
      if (ctx && typeof ctx.effect === 'function') ctx.effect(() => unmount)
    }

    exports.apply = apply
    exports.inject = []
    exports.unmount = unmount
    return module.exports
  },
})
