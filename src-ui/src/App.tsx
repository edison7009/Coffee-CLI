// App.tsx — 3-panel IDE layout (frameless window)

import { useEffect, useRef, useState } from 'react';
import { useAppState, useAppDispatch } from './store/app-state';
import { retryInvoke } from './tauri';
import { subscribeAgentStatus } from './lib/agent-status-bus';
import { routeFileDrop } from './lib/file-drop';
import { TitleBar } from './components/common/TitleBar';
import { ResizeEdges } from './components/common/ResizeEdges';
import { Explorer } from './components/left/Explorer';
import { CenterPanel } from './components/center/CenterPanel';
import { ActiveGambit } from './components/center/ActiveGambit';
import { RightPanel } from './components/right/Compiler';
import { FileStatsProvider } from './lib/file-stats';
import './styles/global.css';

// CSS transition duration on .panel-left / .panel-right in global.css.
// Bumping this here = bump the matching --panel-slide-ms variable too,
// otherwise React unmounts mid-animation and the panel snaps.
const PANEL_SLIDE_MS = 250;

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

  return { mounted, collapsed };
}

export function App() {
  const { state } = useAppState();
  const dispatch = useAppDispatch();

  const leftPanel = useSlidingPanel(state.leftPanelHidden);
  const rightPanel = useSlidingPanel(state.rightPanelHidden);

  // Subscribe to hook-driven agent status events from each AI CLI.
  // The Rust hook server emits these as they arrive from the per-tool
  // forwarder script (Python for Claude / Codex, JS for OpenCode).
  // File-edit attribution per tool was removed in v2.7.x — ChangesBoard
  // now reads `compute_folder_stats` (tool-agnostic snapshot diff)
  // inside FileStatsProvider, so this subscription is purely for tab
  // status indicators.
  useEffect(() => {
    return subscribeAgentStatus((payload) => {
      dispatch({ type: 'SET_AGENT_STATUS', id: payload.tab_id, status: payload.status });
    });
  }, [dispatch]);

  // Apply theme + shape on mount and change — must sync with the inline script in index.html
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', state.currentTheme);
    try { localStorage.setItem('cc-theme', state.currentTheme); } catch {}
  }, [state.currentTheme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-shape', state.currentShape);
    try { localStorage.setItem('cc-shape', state.currentShape); } catch {}
  }, [state.currentShape]);

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
    try { localStorage.setItem('cc-wallpaper-opacity', String(state.wallpaperOpacity)); } catch {}
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
      <FileStatsProvider>
        <div className="app-layout">
          {leftPanel.mounted && (
            <aside
              className={`panel panel-left${leftPanel.collapsed ? ' is-collapsed' : ''}`}
            >
              <Explorer />
            </aside>
          )}

          {/* Center: always mounted */}
          <main className="panel panel-center">
            <CenterPanel />
          </main>

          {rightPanel.mounted && (
            <aside
              className={`panel panel-right${rightPanel.collapsed ? ' is-collapsed' : ''}`}
            >
              <RightPanel />
            </aside>
          )}
        </div>
      </FileStatsProvider>

      {/* App-level overlay — the floating compose window. Rendered here so
          it's isolated from TierTerminal re-renders (xterm output, agent
          status events, etc.) and can be dragged freely across the whole
          app window. Internally reads the active tab's gambit state. */}
      <ActiveGambit />

      {/* 8 transparent resize-edge strips (window chrome). Three-platform
          unified — Windows + macOS already get edge cursors via OS shims,
          but the strips fill in Linux's missing cursor + drag behaviour
          for our `decorations: false` borderless window. */}
      <ResizeEdges />
    </>
  );
}
