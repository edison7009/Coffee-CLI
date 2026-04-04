// SlashMenu.tsx — Visually rich command palette for Claude Code
import { useAppState } from '../../store/app-state';
import { commands } from '../../tauri';
import './ActionMenu.css';

interface Command {
  key: string;
  command: string;
  title: string;
  desc: string;
  icon: string;
}

const SLASH_COMMANDS: Command[] = [
  { key: 'c', command: '/compact', title: 'Compact Context', desc: 'Summarizes and compresses conversation history', icon: '🧹' },
  { key: 'x', command: '/clear', title: 'Clear Chat', desc: 'Start a fresh conversation', icon: '🗑️' },
  { key: 'b', command: '/bug', title: 'Report Bug', desc: 'Send feedback to anthropic', icon: '🐞' },
  { key: 'i', command: '/init', title: 'Initialize Project', desc: 'Create CLAUDE.md guidelines', icon: '📝' },
  { key: 'l', command: '/login', title: 'Login', desc: 'Authenticate with Anthropic', icon: '🔑' },
  { key: 'h', command: '/help', title: 'Help Instructions', desc: 'Show full CLI documentation', icon: '💡' },
];

export function SlashMenu() {
  const { state, dispatch } = useAppState();

  const handleCommand = (cmd: string) => {
    if (state.activeTerminalId) {
      // Send the command and press enter
      commands.tierTerminalInput(state.activeTerminalId, cmd + '\r').catch(() => {});
    }
    dispatch({ type: 'SET_RIGHT_PANEL_MODE', mode: 'compiler' });
  };

  return (
    <div className="action-menu-container">
      <div className="action-menu-header">
        <span className="action-menu-title">Slash Commands</span>
        <button className="action-menu-close" onClick={() => dispatch({ type: 'SET_RIGHT_PANEL_MODE', mode: 'compiler' })}>✕</button>
      </div>
      <div className="action-menu-list">
        {SLASH_COMMANDS.map(cmd => (
          <button key={cmd.key} className="action-menu-item" onClick={() => handleCommand(cmd.command)}>
            <span className="action-icon">{cmd.icon}</span>
            <div className="action-text">
              <span className="action-title">{cmd.title} <span className="action-cmd">{cmd.command}</span></span>
              <span className="action-desc">{cmd.desc}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
