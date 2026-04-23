// App.tsx — 3-panel IDE layout (frameless window)

import { useEffect } from 'react';
import { useAppState, useAppDispatch } from './store/app-state';
import { retryInvoke } from './tauri';
import { subscribeAgentStatus } from './lib/agent-status-bus';
import { TitleBar } from './components/common/TitleBar';
import { Explorer } from './components/left/Explorer';
import { CenterPanel } from './components/center/CenterPanel';
import { ActiveGambit } from './components/center/ActiveGambit';
import { RightPanel } from './components/right/Compiler';
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

  // Apply theme + shape on mount and change — must sync with the inline script in index.html
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', state.currentTheme);
    try { localStorage.setItem('cc-theme', state.currentTheme); } catch {}
  }, [state.currentTheme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-shape', state.currentShape);
    try { localStorage.setItem('cc-shape', state.currentShape); } catch {}
  }, [state.currentShape]);

  // Wallpaper dim: expose as CSS variable --wallpaper-dim (0.0–0.8) for the
  // .launchpad-bg::after / .tier-terminal-bg::after overlay layers.
  useEffect(() => {
    document.documentElement.style.setProperty('--wallpaper-dim', String(state.wallpaperDim / 100));
    try { localStorage.setItem('cc-wallpaper-dim', String(state.wallpaperDim)); } catch {}
  }, [state.wallpaperDim]);

  // Startup: resolve IPC
  useEffect(() => {
    const timer = setTimeout(retryInvoke, 100);
    return () => clearTimeout(timer);
  }, []);

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

      {/* App-level overlay — the floating compose window. Rendered here so
          it's isolated from TierTerminal re-renders (xterm output, agent
          status events, etc.) and can be dragged freely across the whole
          app window. Internally reads the active tab's gambit state. */}
      <ActiveGambit />
    </>
  );
}
