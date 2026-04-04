// HelpMenu.tsx — Visually rich hotkeys menu for Claude Code
import { useAppState } from '../../store/app-state';
import './ActionMenu.css';

interface Hotkey {
  keys: string;
  desc: string;
}

const HOTKEYS: Hotkey[] = [
  { keys: '!', desc: 'bash mode' },
  { keys: '/', desc: 'commands' },
  { keys: '@', desc: 'file paths' },
  { keys: '&', desc: 'background' },
  { keys: 'Double tap ESC', desc: 'clear input' },
  { keys: 'Shift + Tab', desc: 'auto-accept edits' },
  { keys: 'Ctrl + O', desc: 'verbose output' },
  { keys: 'Ctrl + T', desc: 'toggle tasks' },
  { keys: 'Ctrl + Shift + -', desc: 'undo' },
  { keys: 'Alt + V', desc: 'paste images' },
  { keys: 'Meta + P', desc: 'switch model' },
  { keys: 'Meta + O', desc: 'toggle fast mode' },
  { keys: 'Ctrl + S', desc: 'stash prompt' },
  { keys: 'Ctrl + G', desc: 'edit in $EDITOR' },
];

export function HelpMenu() {
  const { dispatch } = useAppState();

  return (
    <div className="action-menu-container">
      <div className="action-menu-header">
        <span className="action-menu-title">Help & Hotkeys</span>
        <button className="action-menu-close" onClick={() => dispatch({ type: 'SET_RIGHT_PANEL_MODE', mode: 'compiler' })}>✕</button>
      </div>
      <div className="action-hotkeys-grid">
        {HOTKEYS.map((hk, i) => (
          <div key={i} className="hotkey-item">
            <kbd className="hotkey-keys">{hk.keys}</kbd>
            <span className="hotkey-desc">{hk.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
