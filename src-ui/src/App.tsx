// App.tsx — 3-panel IDE layout (frameless window)

import { useEffect } from 'react';
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

export function App() {
  const { state } = useAppState();
  const dispatch = useAppDispatch();

  // Subscribe to hook-driven agent status events from Claude Code / Qwen Code.
  // The Rust hook server emits these as they arrive from the Python forwarder.
  useEffect(() => {
    return subscribeAgentStatus((payload) => {
      dispatch({ type: 'SET_AGENT_STATUS', id: payload.tab_id, status: payload.status });
    });
  }, [dispatch]);

  // Subscribe to hook-driven file-edit events. The Rust hook server emits
  // one `tool-file-edit` event per file an in-Coffee-CLI tool just edited
  // (Claude PostToolUse / OpenCode tool.execute / Codex turn-snapshot
  // diff). Diff stats are pre-computed in Rust against the global baseline
  // — frontend just looks up the tab's projectRoot and updates
  // globalChangeLog. Tools without hook integration (Gemini / Qwen /
  // OpenClaw / Hermes) never emit these, so their files don't appear in
  // the audit log — by design, see src/tools/<id>.rs FileEditAttribution.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const fn = await listen<{
        tab_id: string;
        tool: string;
        path: string;
        action: 'edit' | 'create' | 'delete';
        added: number;
        deleted: number;
        mtime_ms: number;
      }>('tool-file-edit', (event) => {
        // Resolve projectRoot from the tab's folderPath. Drop the event
        // if the tab no longer exists (e.g., closed mid-flight) — the
        // hook is fire-and-forget and may straggle.
        const tab = state.terminals.find(t => t.id === event.payload.tab_id);
        if (!tab?.folderPath) return;
        dispatch({
          type: 'RECORD_TOOL_FILE_EDIT',
          tool: event.payload.tool,
          path: event.payload.path,
          action: event.payload.action,
          added: event.payload.added,
          deleted: event.payload.deleted,
          mtimeMs: event.payload.mtime_ms,
          projectRoot: tab.folderPath,
        });
      });
      if (cancelled) fn();
      else unlisten = fn;
    })().catch(() => {});
    return () => { cancelled = true; unlisten?.(); };
    // state.terminals is referenced inside the listener closure; we
    // refresh the listener whenever it changes so closed-tab events
    // get filtered out. The unlisten/relisten cycle is cheap.
  }, [dispatch, state.terminals]);

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

      {/* 3-panel workspace. The titlebar toggle buttons write to
          leftPanelHidden / rightPanelHidden. We now conditionally UNMOUNT
          the hidden panel instead of CSS-hiding it, so users who keep
          a side collapsed pay ZERO cost for that side: no IPC, no scan,
          no event subscriptions, no React reconciliation. When the user
          shows the panel, it mounts fresh (Explorer re-scans from the
          active tab's cwd, TaskBoard reloads tasks — both are cheap). */}
      <FileStatsProvider>
        <div className={`app-layout${state.leftPanelHidden ? ' app-layout--left-hidden' : ''}${state.rightPanelHidden ? ' app-layout--right-hidden' : ''}`}>
          {!state.leftPanelHidden && (
            <aside className="panel panel-left">
              <Explorer />
            </aside>
          )}

          {/* Center: always mounted */}
          <main className="panel panel-center">
            <CenterPanel />
          </main>

          {!state.rightPanelHidden && (
            <aside className="panel panel-right">
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
