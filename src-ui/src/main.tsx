// main.tsx — Entry point

import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppProvider } from './store/app-state';
import { App } from './App';
import { invoke, commands } from './tauri';
import { loadToolInfo } from './lib/tool-info';
import { onWindowBackground, onWindowForeground } from './lib/window-focus-filter';

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
//
// Before reveal, sync window width to the persisted panel-hidden state
// (cc-left-hidden / cc-right-hidden). The titlebar's panel-toggle path
// physically shrinks the window by 320px per panel, but Tauri does NOT
// persist window size across restarts (no tauri-plugin-window-state).
// Without this sync, a user who closed with panels hidden would reopen
// at the full 1600px default with a stretched-empty center column, and
// toggling a panel back on would grow the window past 1600px because
// adjustWindowForPanel works in deltas from the current size. Keep
// PANEL_WIDTH in sync with TitleBar.tsx and the --w-left/right CSS vars.
async function syncWindowToPanelStateAndShow() {
  try {
    const leftHidden = localStorage.getItem('cc-left-hidden') === '1';
    const rightHidden = localStorage.getItem('cc-right-hidden') === '1';
    const hiddenCount = (leftHidden ? 1 : 0) + (rightHidden ? 1 : 0);
    if (hiddenCount > 0) {
      const { getCurrentWindow, PhysicalSize } = await import('@tauri-apps/api/window');
      const w = getCurrentWindow();
      if (!(await w.isMaximized())) {
        const scale = await w.scaleFactor();
        const shrinkPx = Math.round(320 * hiddenCount * scale);
        const minWidthPx = Math.round(900 * scale); // matches tauri.conf.json minWidth
        const size = await w.innerSize();
        const targetW = Math.max(minWidthPx, size.width - shrinkPx);
        if (targetW !== size.width) {
          await w.setSize(new PhysicalSize(targetW, size.height));
        }
      }
    }
  } catch {}
  invoke('show_main_window').catch(() => {});
}

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    void syncWindowToPanelStateAndShow();
  });
});

// ── Background-mode throttle ────────────────────────────────────────────
// When the OS hides the Coffee CLI window (other Space, app switched
// away, minimized) tell the Rust backend to widen every per-session
// worker's sleep / coalesce window. Without this, a backgrounded app
// keeps paying the full 8ms emitter cadence + 500ms ticker cadence per
// session forever — measurable as a warm chassis on Apple Silicon
// laptops left running all day. The cost of being wrong here is a few
// hundred ms of stale agent-status updates when the user returns.
const syncBackgroundMode = () => {
  commands.setBackgroundMode(document.hidden).catch(() => {});
};
document.addEventListener('visibilitychange', syncBackgroundMode);
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
});

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
