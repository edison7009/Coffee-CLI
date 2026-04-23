// MultiAgentGrid.tsx — independent "four pane" tab content.
//
// This is an INDEPENDENT feature, not an upgrade path on a regular Tab.
// A multi-agent tab lives side-by-side with single-terminal tabs, and all
// four panes are peers: any pane's CLI can use the coffee-cli MCP tools
// (list_panes / send_to_pane / read_pane) to observe and drive the other
// three. There is NO primary / worker distinction.
//
// Design goals that drove this file (learned from the earlier
// "single-tab → grid toggle" attempt that is now deprecated):
//   1. No CSS magic splitting a wrapper between TierTerminal siblings.
//      The whole tab surface IS the grid.
//   2. No pane-0 reuse of the tab id. Every pane has a uniform sessionId
//      `${tabId}::pane-${idx}`. The backend PaneStore doesn't care who
//      owns which id; list_panes just shows whatever the SharedSession
//      has.
//   3. No "primary pane" state. Pane_X sends to pane_Y when the user
//      asks — that's it. Focus is handled by the browser's natural
//      click-to-focus, with the global focus enforcer relaxed in
//      CenterPanel to respect any xterm textarea that has focus.
//   4. Empty panes show a small CLI picker (Claude / Codex / Gemini /
//      OpenCode). v1.0.1 will add per-pane profile selection (model,
//      workdir, extra args).

import { useAppState, type TerminalSession, type ToolType } from '../../store/app-state';
import { TierTerminal } from './TierTerminal';
import { ErrorBoundary } from '../common/ErrorBoundary';
import './MultiAgentGrid.css';

interface Props {
  tab: TerminalSession;
  hasBg: boolean;
  bgUrl: string;
  bgType: 'image' | 'video' | 'none';
}

const PANE_CLI_OPTIONS: Array<{ value: ToolType; label: string }> = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'opencode', label: 'OpenCode' },
];

// Fixed 2×2 layout. Scrolling for panes > 4 is a v1.0.1 extension.
const PANE_COUNT = 4;

export function MultiAgentGrid({ tab, hasBg, bgUrl, bgType }: Props) {
  const { state, dispatch } = useAppState();

  // Read panes from state; fall back to 4 empty if not seeded yet.
  // `toolData` is optional per MultiAgentPane — the fallback omits it.
  const panes = tab.multiAgent?.panes
    ?? (Array.from({ length: PANE_COUNT }, (_, i) => ({
         paneIdx: i,
         tool: null as ToolType,
       })) as Array<{ paneIdx: number; tool: ToolType; toolData?: string }>);

  const onSelectTool = (paneIdx: number, tool: ToolType) => {
    dispatch({ type: 'SET_PANE_TOOL', tabId: tab.id, paneIdx, tool });
  };

  return (
    <div className="multi-agent-grid-standalone">
      {panes.map((pane) => {
        // Uniform sessionId — no pane-0 special case. The backend spawns
        // a fresh PTY for each unique id; PaneStore's list_panes walks
        // SharedSession and finds them all regardless of who created them.
        const paneSessionId = `${tab.id}::pane-${pane.paneIdx}`;
        const isEmpty = pane.tool === null;

        return (
          <div
            key={pane.paneIdx}
            className={`multi-agent-pane pane-slot-${pane.paneIdx}${isEmpty ? ' is-empty' : ''}`}
          >
            <header className="multi-agent-pane-header">
              <span className="pane-label">
                Pane {pane.paneIdx}
                {pane.tool ? ` — ${pane.tool}` : ''}
              </span>
            </header>

            <div className="multi-agent-pane-body">
              {isEmpty ? (
                <EmptyPanePicker
                  paneIdx={pane.paneIdx}
                  onSelect={(tool) => onSelectTool(pane.paneIdx, tool)}
                />
              ) : (
                <ErrorBoundary fallbackLabel="Tier Terminal Error">
                  <TierTerminal
                    key={paneSessionId}
                    sessionId={paneSessionId}
                    tool={pane.tool}
                    toolName={undefined}
                    theme={state.currentTheme}
                    lang={state.currentLang}
                    // Any pane in the active tab can receive keyboard —
                    // the browser decides via click-to-focus, no primary
                    // state needed.
                    isActive={state.activeTerminalId === tab.id}
                    toolData={pane.toolData}
                    folderPath={tab.folderPath}
                    hasBg={hasBg}
                    bgUrl={bgUrl}
                    bgType={bgType}
                    termColorScheme={state.termColorScheme}
                  />
                </ErrorBoundary>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface EmptyPanePickerProps {
  paneIdx: number;
  onSelect: (tool: ToolType) => void;
}

function EmptyPanePicker({ paneIdx, onSelect }: EmptyPanePickerProps) {
  return (
    <div className="empty-pane-picker">
      <div className="empty-pane-title">Pane {paneIdx} — choose a CLI</div>
      <div className="empty-pane-options">
        {PANE_CLI_OPTIONS.map((opt) => (
          <button
            key={String(opt.value)}
            className="empty-pane-option"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(opt.value);
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className="empty-pane-hint">
        Any peer pane can call <code>send_to_pane("{`${paneIdx}`}")</code>
      </div>
    </div>
  );
}
