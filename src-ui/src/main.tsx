// main.tsx — Entry point

import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppProvider } from './store/app-state';
import { App } from './App';
import { invoke } from './tauri';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>
);

// Window starts with `visible: false` (see tauri.conf.json) to hide the
// Windows-default chrome flash. Reveal it only after the first paint so
// the first frame the user sees is the final themed UI.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    invoke('show_main_window').catch(() => {});
  });
});

// Suppress the WebView's built-in context menu (返回/刷新/另存为/打印/检查…).
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
