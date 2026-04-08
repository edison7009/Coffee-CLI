// App.tsx — 3-panel IDE layout (frameless window)

import { useEffect } from 'react';
import { useAppState } from './store/app-state';
import { isTauri, retryInvoke, commands } from './tauri';
import { TitleBar } from './components/common/TitleBar';
import { Explorer } from './components/left/Explorer';
import { CenterPanel } from './components/center/CenterPanel';
import { RightPanel } from './components/right/Compiler';
import './styles/global.css';

export function App() {
  const { state, dispatch } = useAppState();

  // Apply theme on mount and change — must sync with the inline script in index.html
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', state.currentTheme);
    try { localStorage.setItem('cc-theme', state.currentTheme); } catch {}
  }, [state.currentTheme]);

  // Startup: resolve IPC, load model config, auto-scan last folder
  useEffect(() => {
    const timer = setTimeout(async () => {
      retryInvoke();

      try {
        const model = await commands.loadModel();
        dispatch({ type: 'SET_MODEL', model });
      } catch (e) {
        console.warn('[CC] loadModel failed:', e);
      }

      const activeTerminal = state.terminals.find(t => t.id === state.activeTerminalId);
      if (activeTerminal?.folderPath && isTauri) {
        try {
          const data = await commands.scanFolder(activeTerminal.folderPath);
          dispatch({ type: 'SET_SCAN', data });
        } catch (e) {
          console.warn('[CC] Auto-scan failed:', e);
        }
      }
    }, 100);
    return () => clearTimeout(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
