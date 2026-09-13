// App.tsx — 3-panel IDE layout (frameless window)

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppState } from './store/app-state';
import { retryInvoke } from './tauri';
import { initNotifySound } from './lib/notify-sound';
import { routeFileDrop } from './lib/file-drop';
import { initHistoryAutoRefresh } from './lib/history-cache';
import { isFrostShape } from './lib/personalization';
import { systemThemeColor } from './lib/system-theme';
import { TitleBar } from './components/common/TitleBar';
import { ResizeEdges } from './components/common/ResizeEdges';
import { PanelResizer, type PanelSide } from './components/common/PanelResizer';
import { SettingsModal } from './components/common/SettingsModal';
import { Explorer } from './components/left/Explorer';
import { CenterPanel } from './components/center/CenterPanel';
import { ActiveGambit } from './components/center/ActiveGambit';
import { RightPanel } from './components/right/Compiler';
import { GitStatusProvider } from './lib/git-status';
import './styles/global.css';

// CSS transition duration on .panel-left / .panel-right in global.css.
// Bumping this here = bump the matching --panel-slide-ms variable too,
// otherwise React unmounts mid-animation and the panel snaps.
const PANEL_SLIDE_MS = 250;

interface PanelWidths {
  left: number;
  right: number;
}

const PANEL_WIDTHS_STORAGE_KEY = 'cc-panel-widths';
const PANEL_CENTER_MIN = 400;
const PANEL_LEFT_MIN = 210;
const PANEL_LEFT_MAX = 380;
const PANEL_RIGHT_MIN = 200;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

function defaultPanelWidths(
  viewportWidth: number,
  leftHidden = false,
  rightHidden = false,
): PanelWidths {
  const fluid = clamp(viewportWidth * 0.28, 240, 320);
  return normalizePanelWidths({ left: fluid, right: fluid }, viewportWidth, leftHidden, rightHidden);
}

function normalizePanelWidths(
  widths: PanelWidths,
  viewportWidth: number,
  leftHidden = false,
  rightHidden = false,
): PanelWidths {
  const singlePanelAvailable = Math.max(
    Math.max(PANEL_LEFT_MIN, PANEL_RIGHT_MIN),
    viewportWidth - PANEL_CENTER_MIN,
  );
  const individualLeftMaximum = Math.max(
    PANEL_LEFT_MIN,
    Math.min(PANEL_LEFT_MAX, singlePanelAvailable),
  );
  const individualRightMaximum = Math.max(PANEL_RIGHT_MIN, singlePanelAvailable);
  let left = clamp(widths.left, PANEL_LEFT_MIN, individualLeftMaximum);
  let right = clamp(widths.right, PANEL_RIGHT_MIN, individualRightMaximum);

  // Hidden panels keep an individually valid stored width, but do not consume
  // the visible layout's width budget. When both sides are visible, reserve
  // their minimums and keep the center workspace at or above its floor.
  if (leftHidden || rightHidden) {
    return { left: Math.round(left), right: Math.round(right) };
  }

  const available = Math.max(PANEL_LEFT_MIN + PANEL_RIGHT_MIN, viewportWidth - PANEL_CENTER_MIN);
  const leftMaximum = Math.max(PANEL_LEFT_MIN, Math.min(PANEL_LEFT_MAX, available - PANEL_RIGHT_MIN));
  left = clamp(left, PANEL_LEFT_MIN, leftMaximum);
  const rightMaximum = Math.max(PANEL_RIGHT_MIN, available - left);
  right = clamp(right, PANEL_RIGHT_MIN, rightMaximum);

  if (left + right > available) {
    right = Math.max(PANEL_RIGHT_MIN, available - left);
    left = Math.max(PANEL_LEFT_MIN, available - right);
  }
  return { left: Math.round(left), right: Math.round(right) };
}

function loadPanelWidths(
  viewportWidth: number,
  leftHidden: boolean,
  rightHidden: boolean,
): PanelWidths {
  try {
    const parsed = JSON.parse(localStorage.getItem(PANEL_WIDTHS_STORAGE_KEY) || '') as Partial<PanelWidths>;
    if (Number.isFinite(parsed.left) && Number.isFinite(parsed.right)) {
      return normalizePanelWidths(
        { left: parsed.left!, right: parsed.right! },
        viewportWidth,
        leftHidden,
        rightHidden,
      );
    }
  } catch { /* Missing/malformed preferences fall back to the fluid defaults. */ }
  return defaultPanelWidths(viewportWidth, leftHidden, rightHidden);
}

function persistPanelWidths(widths: PanelWidths) {
  try { localStorage.setItem(PANEL_WIDTHS_STORAGE_KEY, JSON.stringify(widths)); } catch { /* Best effort. */ }
}

function applyPanelWidths(widths: PanelWidths) {
  const root = document.documentElement;
  root.style.setProperty('--w-left', `${widths.left}px`);
  root.style.setProperty('--w-right', `${widths.right}px`);
}

/**
 * Drive the slide-open / slide-closed animation for a single side panel.
 *
 *   hidden=true  → if currently mounted, apply `is-collapsed` (CSS animates
 *                  width 320→0) then unmount after PANEL_SLIDE_MS so the
 *                  child stops firing IPC + event subs while invisible.
 *   hidden=false → mount immediately at width 0 (`is-collapsed`), then
 *                  drop the class on the next paint so CSS animates
 *                  0→320. Two rAFs are needed: one to commit React's
 *                  initial collapsed render, a second to let the browser
 *                  paint at width 0 before the class flip — otherwise the
 *                  transition has no "from" frame and the panel just snaps.
 *
 * Initial render skips the animation: a panel hidden from launch starts
 * unmounted with no flicker; a visible-by-default panel renders at full
 * width with no fake collapse-then-expand.
 */
function useSlidingPanel(hidden: boolean): { mounted: boolean; collapsed: boolean } {
  const [mounted, setMounted] = useState(!hidden);
  const [collapsed, setCollapsed] = useState(false);
  const isFirstRun = useRef(true);
  const timeoutRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect -- This hook is an explicit CSS transition state machine synchronized to the hidden prop. */
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (hidden) {
      setCollapsed(true);
      timeoutRef.current = window.setTimeout(() => {
        setMounted(false);
        setCollapsed(false);
        timeoutRef.current = null;
      }, PANEL_SLIDE_MS);
    } else {
      setMounted(true);
      setCollapsed(true);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = requestAnimationFrame(() => {
          setCollapsed(false);
          rafRef.current = null;
        });
      });
    }
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [hidden]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return { mounted, collapsed };
}

export function App() {
  const { state, dispatch } = useAppState();

  const [panelWidths, setPanelWidths] = useState<PanelWidths>(() => loadPanelWidths(
    window.innerWidth,
    state.leftPanelHidden,
    state.rightPanelHidden,
  ));
  const panelWidthsRef = useRef(panelWidths);

  const leftPanel = useSlidingPanel(state.leftPanelHidden);
  const rightPanel = useSlidingPanel(state.rightPanelHidden);

  useLayoutEffect(() => applyPanelWidths(panelWidths), [panelWidths]);

  useEffect(() => {
    let visibilityFrame: number | null = requestAnimationFrame(() => {
      visibilityFrame = null;
      syncWidths();
    });
    function syncWidths() {
      const next = normalizePanelWidths(
        panelWidthsRef.current,
        window.innerWidth,
        state.leftPanelHidden,
        state.rightPanelHidden,
      );
      if (next.left === panelWidthsRef.current.left && next.right === panelWidthsRef.current.right) return;
      panelWidthsRef.current = next;
      applyPanelWidths(next);
      persistPanelWidths(next);
      setPanelWidths(next);
    }
    window.addEventListener('resize', syncWidths);
    return () => {
      window.removeEventListener('resize', syncWidths);
      if (visibilityFrame !== null) cancelAnimationFrame(visibilityFrame);
    };
  }, [state.leftPanelHidden, state.rightPanelHidden]);

  const resizePanel = (side: PanelSide, requestedSize: number) => {
    const current = panelWidthsRef.current;
    const available = Math.max(
      side === 'left' ? PANEL_LEFT_MIN : PANEL_RIGHT_MIN,
      window.innerWidth - PANEL_CENTER_MIN,
    );
    const otherPanelHidden = side === 'left' ? state.rightPanelHidden : state.leftPanelHidden;
    const reservedByOtherPanel = otherPanelHidden ? 0 : side === 'left' ? current.right : current.left;
    const maximum = side === 'left'
      ? Math.max(PANEL_LEFT_MIN, Math.min(PANEL_LEFT_MAX, available - reservedByOtherPanel))
      : Math.max(PANEL_RIGHT_MIN, available - reservedByOtherPanel);
    const next = {
      ...current,
      [side]: Math.round(clamp(requestedSize, side === 'left' ? PANEL_LEFT_MIN : PANEL_RIGHT_MIN, maximum)),
    };
    panelWidthsRef.current = next;
    applyPanelWidths(next);
  };

  const finishPanelResize = () => {
    const next = panelWidthsRef.current;
    setPanelWidths(next);
    persistPanelWidths(next);
  };

  const resetPanelWidth = (side: PanelSide) => {
    const defaults = defaultPanelWidths(
      window.innerWidth,
      state.leftPanelHidden,
      state.rightPanelHidden,
    );
    const next = normalizePanelWidths(
      { ...panelWidthsRef.current, [side]: defaults[side] },
      window.innerWidth,
      state.leftPanelHidden,
      state.rightPanelHidden,
    );
    panelWidthsRef.current = next;
    applyPanelWidths(next);
    setPanelWidths(next);
    persistPanelWidths(next);
  };

  // Completion / permission chimes (Settings ▸ Sound). Reads the terminals
  // array (the same source the dynamic island reads via agentStatus) so chimes
  // match the visual status exactly. This fires on every terminals change.
  useEffect(() => {
    return initNotifySound(state.terminals);
  }, [state.terminals]);

  // Apply theme + shape on mount and change — must sync with the inline script in index.html
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', state.currentTheme);
    try { localStorage.setItem('cc-theme', state.currentTheme); } catch { /* Best-effort operation; failure is non-fatal. */ }
  }, [state.currentTheme]);

  // "跟随系统" auto-follow: when on, keep currentTheme synced to the OS
  // light/dark preference. Dual-listens to matchMedia (CSS
  // prefers-color-scheme) and Tauri's onThemeChanged (OS-level; catches
  // changes matchMedia misses on some hosts). Manual swatch picks flip
  // themeAuto off (SettingsModal), so this listener is dormant whenever
  // the user is choosing manually.
  useEffect(() => {
    if (!state.themeAuto) return;
    const apply = () => {
      const next = systemThemeColor();
      if (next !== state.currentTheme) dispatch({ type: 'SET_THEME', theme: next });
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        unlisten = await getCurrentWindow().onThemeChanged(apply);
      } catch { /* Tauri API unavailable outside the desktop shell. */ }
    })();
    return () => {
      mq.removeEventListener('change', apply);
      unlisten?.();
    };
  }, [state.themeAuto, state.currentTheme, dispatch]);

  useEffect(() => {
    // Frost shapes reuse the whole glass chrome; normalize data-shape to
    // "glass" and expose the variant via data-frost (see [data-frost=...]
    // in global.css). Must mirror the inline script in index.html.
    const el = document.documentElement;
    const frost = isFrostShape(state.currentShape);
    if (frost) {
      el.setAttribute('data-shape', 'glass');
      el.setAttribute('data-frost', state.currentShape);
    } else {
      el.setAttribute('data-shape', state.currentShape);
      el.removeAttribute('data-frost');
    }
    try { localStorage.setItem('cc-shape', state.currentShape); } catch { /* Best-effort operation; failure is non-fatal. */ }

    // Frost = OS/compositor blur under a CSS tint from the selected theme.
    // Windows uses DWM Acrylic, macOS NSVisualEffectView, and Linux requests
    // KWin's native X11/Wayland blur when available. Other Linux compositors
    // keep genuine translucency without substituting an in-app wallpaper.
    const inv = retryInvoke();
    if (inv) {
      inv('set_frosted_backdrop', {
        on: frost,
        dark: state.currentTheme !== 'light',
      }).catch(() => {});
    }
  }, [state.currentShape, state.currentTheme]);

  // Sync the UI language to the <html> lang attribute so CSS :lang(zh)
  // selectors can fire. This is what swaps the splash-label out of the
  // English-italic-serif "art font" (which looks ugly with CJK glyphs)
  // into a normal-weight bold display in Chinese — see TierTerminal.css
  // .splash-label rules. Without this attribute on <html>, every component
  // using .splash-label silently fell through to the italic serif and
  // each component had to inline-style its own CJK workaround.
  useEffect(() => {
    document.documentElement.lang = state.currentLang;
  }, [state.currentLang]);

  // Wallpaper image opacity: expose as CSS variable --wallpaper-opacity
  // (0.0–1.0) for the .launchpad-bg / .tier-terminal-bg / .multi-agent-bg
  // img+video elements. Larger value = more visible image.
  useEffect(() => {
    document.documentElement.style.setProperty('--wallpaper-opacity', String(state.wallpaperOpacity / 100));
    try { localStorage.setItem('cc-wallpaper-opacity', String(state.wallpaperOpacity)); } catch { /* Best-effort operation; failure is non-fatal. */ }
  }, [state.wallpaperOpacity]);

  // Startup: resolve IPC
  useEffect(() => {
    const timer = setTimeout(retryInvoke, 100);
    return () => clearTimeout(timer);
  }, []);

  // OS-external file drops (Finder / File Explorer → our window). Tauri
  // captures these at the window level and emits a single global event —
  // DOM `drop` does NOT fire. payload.position is in physical pixels, so
  // divide by devicePixelRatio for CSS-pixel hit-testing. Intra-app drags
  // (left Explorer → terminal/Gambit) bypass HTML5 drag entirely and use
  // pointer events; see explorer-drag.ts.
  useEffect(() => {
    let unlistenTauri: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      const fn = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return;
        const paths = event.payload.paths;
        if (!paths || paths.length === 0) return;
        const dpr = window.devicePixelRatio || 1;
        routeFileDrop(paths, {
          x: event.payload.position.x / dpr,
          y: event.payload.position.y / dpr,
        });
      });
      if (cancelled) fn();
      else unlistenTauri = fn;
    })().catch(() => {});
    return () => { cancelled = true; unlistenTauri?.(); };
  }, []);

  // No tool-icon preload anymore. v1.1.4–v1.9.x tried to keep the
  // <img>-based Launchpad icons flicker-free by warming the HTTP cache
  // with `new Image()`, then warming the decoded-image cache with
  // `img.decode()`, then adding `decoding="sync"` on the render site —
  // each layer made the flash less common but never eliminated it,
  // because Chromium treats `decoding="sync"` as a hint and WebView2's
  // decoded-image cache evicts under sustained use. The fix that
  // actually works is to never use <img> for these icons: SVG logos
  // ship as inline strings, PNG rasters ship as `?inline` data URIs
  // rendered via CSS background-image. Both flows render synchronously
  // as part of the parent's first paint. See CenterPanel.tsx `bgIcon`
  // and the OPENCODE_SVG comment for the full history.

  // Previously prefetched session history at startup — but that caused a
  // noticeable stutter on cold launch (JSON parse + state fan-out) even
  // though the Rust call itself ran on a blocking thread pool. Removed.
  // HistoryBoard's own useEffect now fetches lazily when the user first
  // opens the History tab, which is the only place the data is consumed.

  // Suppress the default browser right-click menu in production. Desktop
  // apps should not expose "Back / Reload / Save As / Print / Inspect" to
  // end users. File/dir and terminal custom menus use stopPropagation, so
  // their events never reach this document-level handler — no exemption
  // needed for them. The xterm wrap is still whitelisted as a defensive
  // fallback in case a future code path forgets to stopPropagation.
  //
  // In `npm run dev` / `cargo tauri dev` we deliberately skip this handler
  // so the native WebView2 context menu is available — that's the only way
  // to reach "Inspect Element" since Tauri 2 doesn't bind F12 by default.
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.tier-xterm-wrap')) return;
      e.preventDefault();
    };
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, []);

  // History list auto-refresh — install the window-foreground listener +
  // 60s background poll that keep the session-history cache live so users
  // no longer have to restart Coffee CLI to see newly-created sessions
  // (issue: "会话记录列表始终是第一次打开软件时的,要重启才能看到新的").
  // refreshHistory no-ops until the user first opens the History tab
  // (prefetchHistory flips status to 'ready'), so users who never open it
  // pay only the 60s setInterval tick (a function call that early-returns).
  useEffect(() => initHistoryAutoRefresh(), []);

  return (
    <>
      {/* Custom titlebar — drag region + minimize / maximize / close */}
      <TitleBar />

      {/* 3-panel workspace. Titlebar toggles flip leftPanelHidden /
          rightPanelHidden. The OS window itself doesn't resize (same
          model as VS Code / Cursor / Warp) — toggling just collapses
          the panel's width to 0 over a 250ms CSS transition while the
          center column's `flex: 1` smoothly reclaims the freed space.
          Once the slide-out animation completes the panel fully
          UNMOUNTS so Explorer / RightPanel stop firing IPC + event
          subs while hidden; on show, we mount in the collapsed state
          and let CSS animate it back open. */}
      <GitStatusProvider>
        <div className="app-layout">
          {leftPanel.mounted && (
            <>
              <aside
                className={`panel panel-left${leftPanel.collapsed ? ' is-collapsed' : ''}`}
              >
                <Explorer />
              </aside>
              <PanelResizer
                side="left"
                size={panelWidths.left}
                collapsed={leftPanel.collapsed}
                onResize={resizePanel}
                onResizeEnd={finishPanelResize}
                onReset={resetPanelWidth}
              />
            </>
          )}

          {/* Center: always mounted */}
          <main className="panel panel-center">
            <CenterPanel />
          </main>

          {rightPanel.mounted && (
            <>
              <PanelResizer
                side="right"
                size={panelWidths.right}
                collapsed={rightPanel.collapsed}
                onResize={resizePanel}
                onResizeEnd={finishPanelResize}
                onReset={resetPanelWidth}
              />
              <aside
                className={`panel panel-right${rightPanel.collapsed ? ' is-collapsed' : ''}`}
              >
                <RightPanel />
              </aside>
            </>
          )}
        </div>
      </GitStatusProvider>

      {/* App-level overlay — the floating compose window. Rendered here so
          it's isolated from TierTerminal re-renders (xterm output, agent
          status events, etc.) and can be dragged freely across the whole
          app window. Internally reads the active tab's gambit state. */}
      <ActiveGambit />

      {/* Personalization settings — centered modal opened by the titlebar
          gear. App-level overlay (gated on state.settingsOpen) so it floats
          above the whole workspace, like ActiveGambit. */}
      <SettingsModal />

      {/* 8 transparent resize-edge strips (window chrome). Three-platform
          unified — Windows + macOS already get edge cursors via OS shims,
          but the strips fill in Linux's missing cursor + drag behaviour
          for our `decorations: false` borderless window. */}
      <ResizeEdges />
    </>
  );
}
