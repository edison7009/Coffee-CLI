// App.tsx — 3-panel IDE layout (frameless window)

import { useEffect } from 'react';
import { useAppState, useAppDispatch } from './store/app-state';
import { retryInvoke } from './tauri';
import { subscribeAgentStatus } from './lib/agent-status-bus';
import { TitleBar } from './components/common/TitleBar';
import { Explorer } from './components/left/Explorer';
import { CenterPanel } from './components/center/CenterPanel';
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

  // Startup: resolve IPC
  useEffect(() => {
    const timer = setTimeout(retryInvoke, 100);
    return () => clearTimeout(timer);
  }, []);

  // Suppress the default browser right-click menu. Desktop apps should not
  // expose "Back / Reload / Save As / Print / Inspect" to end users.
  // The left Explorer panel is exempt — it has its own custom file context menu.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Allow custom context menu inside the Explorer panel and terminal
      if (target.closest('.panel-left')) return;
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

      {/* 3-panel workspace */}
      <div className="app-layout">
        {/* Left: File Explorer (contains brand + controls in its header) */}
        <aside className="panel panel-left">
          <Explorer />
        </aside>

        {/* Center: Tab content area */}
        <main className="panel panel-center">
          <CenterPanel />
        </main>

        {/* Right: Task Board + Tool Controls */}
        <aside className="panel panel-right">
          <RightPanel />
        </aside>
      </div>
    </>
  );
}
