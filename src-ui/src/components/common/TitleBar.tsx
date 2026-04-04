// TitleBar.tsx — Custom draggable titlebar (replaces native OS window chrome)
// Tauri requires this for frameless windows with decorations: false

import { commands, isTauri } from '../../tauri';
import './TitleBar.css';

export function TitleBar() {
  const minimize = () => isTauri && commands.windowMinimize().catch(() => {});
  const maximize = () => isTauri && commands.windowMaximize().catch(() => {});
  const close    = () => isTauri && commands.windowClose().catch(() => {});

  return (
    // data-tauri-drag-region tells WebView2 this div is draggable
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-controls" data-tauri-drag-region="false">
        <button className="titlebar-btn" onClick={minimize} id="t-min">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="1" y="4.5" width="8" height="1" fill="currentColor"/>
          </svg>
        </button>
        <button className="titlebar-btn" onClick={maximize} id="t-max">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1"/>
          </svg>
        </button>
        <button className="titlebar-btn close" onClick={close} id="t-close">
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1.5 1.5 l7 7 M1.5 8.5 l7 -7" fill="none" stroke="currentColor" strokeWidth="1"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
