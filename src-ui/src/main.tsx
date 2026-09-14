// main.tsx — Entry point

import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppProvider } from './store/app-state';
import { App } from './App';
import { invoke, commands } from './tauri';
import { loadToolInfo } from './lib/tool-info';
import { onWindowBackground, onWindowForeground } from './lib/window-focus-filter';
import { IS_MACOS, IS_WINDOWS } from './lib/platform';

// macOS uses native window decorations + traffic lights (titleBarStyle:
// "Overlay" in tauri.macos.conf.json). Tag <html> before first paint so the
// titlebar renders without our custom min/max/close and the #root corner clip
// is dropped — the OS owns the corners there. Win/Linux keep the frameless
// shell with custom controls on the right.
if (IS_MACOS) document.documentElement.classList.add('is-macos');
// Windows: marks the platform where Frost's native Acrylic path is used (the
// window goes opaque + DWM rounds the corners, so the CSS clip must drop —
// gated to this class so Linux keeps its transparent + CSS-clip rounded look).
if (IS_WINDOWS) document.documentElement.classList.add('is-windows');

// Block React mount on the registry IPC so every component reads
// canonical display names on first render (no 'claude' → 'Claude
// Code' label flash). The window is `visible: false` until
// show_main_window fires below, so the ~10ms wait is invisible.
void loadToolInfo().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <AppProvider>
        <App />
      </AppProvider>
    </React.StrictMode>
  );
});

// Warm document.fonts so Inter is fully decoded BEFORE any UI element first
// needs glyphs that the body had not yet rendered. <link rel="preload"> in
// index.html only guarantees the woff2 file is fetched — the browser still
// defers font-face activation until a layout pass demands it. That deferred
// activation is what caused the language-menu jitter: the menu was the first
// place glyph badges (Я, Ñ, Vi, ề…) appeared, so opening it triggered
// activation + font-display: swap, reflowing every row mid-frame.
//
// `document.fonts.load(spec)` runs the activation immediately. We don't await
// — letting React mount in parallel is fine; the fonts will be ready well
// before the user can click the language toggle.
if (typeof document !== 'undefined' && document.fonts) {
  document.fonts.load('400 14px Inter');
  document.fonts.load('500 14px Inter');
  document.fonts.load('600 14px Inter');
  document.fonts.load('700 14px Inter');
}

// Window starts with `visible: false` (see tauri.conf.json) to hide the
// Windows-default chrome flash. Reveal it only after the first paint so
// the first frame the user sees is the final themed UI.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    invoke('show_main_window').catch(() => {});
  });
});

// ── Background-mode throttle ────────────────────────────────────────────
// When the OS hides the Coffee CLI window (other Space, app switched
// away, minimized) tell the Rust backend to widen every per-session
// worker's sleep / coalesce window. Without this, a backgrounded app
// keeps paying the full 8ms emitter cadence per session forever — measurable
// as a warm chassis on Apple Silicon laptops left running all day.
const syncBackgroundMode = () => {
  commands.setBackgroundMode(document.hidden).catch(() => {});
};
document.addEventListener('visibilitychange', syncBackgroundMode);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) nudgeWholeWindowRepaint();
});
// Also catch focus/blur — visibilitychange does not fire when the
// window is merely covered by another app on the same Space (macOS) or
// pushed behind on Windows. Combined with visibilitychange this covers
// every "user isn't looking at us" path.
//
// Routed through window-focus-filter so spurious blur+focus pairs from
// Tauri's `start_dragging()` on Windows (modal sizing/moving loop briefly
// unfocuses WebView2, refocuses ~5ms later) don't toggle background mode
// every time the user grabs the titlebar. The filter waits SETTLE_MS
// (100ms) before honoring a blur; a focus within that window cancels.
onWindowBackground(() => {
  commands.setBackgroundMode(true).catch(() => {});
});
onWindowForeground(() => {
  commands.setBackgroundMode(false).catch(() => {});
  nudgeWholeWindowRepaint();
});

// ── Whole-window repaint on refocus ────────────────────────────────────────
// While the app is backgrounded the WebView stops presenting (rAF throttles
// to ~1fps or pauses). On alt-tab back, the window can be composited from the
// last presented frame for a beat before any invalidation re-rasters it —
// text then reads as a transient double image until something moves. The
// terminal canvas has its own mask+refresh cycle (TierTerminal), but the
// chrome around it (titlebar, tabs, sidebars, diff panel) has none.
//
// Nudge the whole tree through a fresh raster+present the moment the window
// regains focus: a near-identity scale on <html> forces every layer's
// content to re-raster, and the flip-back on the next frame leaves the
// layout exactly as it was. 0.9999 is below any visible threshold for the
// single frame it lives. The 250ms timeout backstops the case where rAF is
// still on the background throttle right after refocus.
function nudgeWholeWindowRepaint() {
  const root = document.documentElement;
  let done = false;
  const restore = () => {
    if (done) return;
    done = true;
    root.style.transform = '';
  };
  root.style.transform = 'scale(0.9999)';
  requestAnimationFrame(restore);
  setTimeout(restore, 250);
}

// Suppress the WebView's built-in context menu (Back / Reload / Save As / Print / Inspect…).
// Our own React components handle onContextMenu directly and render
// custom menus via app state — preventing the browser default at the
// window level is layered on top, so those custom menus still appear.
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

// Production: block F12 / Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C to
// prevent users from opening the WebView devtools on a shipped build.
// Dev builds leave the shortcuts alone so we can still inspect.
if (!import.meta.env.DEV) {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F12') { e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
      const k = e.key.toUpperCase();
      if (k === 'I' || k === 'J' || k === 'C') { e.preventDefault(); }
    }
  });
}
