// MultiAgentGrid.tsx — renders worker panes 1..N as siblings of the
// primary pane's TierTerminal.
//
// IMPORTANT: Pane 0 is NOT rendered here. The Tab's original TierTerminal
// stays mounted in CenterPanel; the `.terminal-wrapper.is-multi-agent`
// CSS grid places it in cell (1,1) automatically. MultiAgentGrid only
// renders the other 3 panes as direct children of the same wrapper, so
// CSS grid arranges them into (2,1)(1,2)(2,2). This keeps the primary
// CLI's PTY alive across the single↔multi-agent toggle.
//
// Each non-primary pane gets its own PTY session
// (sessionId = `${tabId}::pane-${idx}`), so the Rust MCP server sees N
// independent terminals and the primary LLM can send_to_pane / read_pane
// without any cross-talk.
//
// v1.0 day 5 scope:
//   - 2×2 visible grid; panes > 3 scroll via the wrapper.
//   - Empty-pane placeholder with a simple CLI picker (Claude / Codex /
//     Gemini / OpenCode). Full dropdown with model/profile
//     selection is deferred to v1.0.1.
//
// Out of scope for day 5:
//   - Idle-status badge (day 6 will drive it from agent-status events).
//   - Drag-resize of the grid lines.
//   - Per-pane CLI auth / model picker (goes with the dropdown in v1.0.1).

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

// MVP picker — matches docs/MULTI-AGENT-ARCHITECTURE.md §7.1 primary-CLI
// list. Shell is an explicit fallback for worker-only uses (bash / pwsh).
// Day 5 keeps the picker minimal; v1.0.1 will add per-entry config (model,
// starting directory, extra args).
const PANE_CLI_OPTIONS: Array<{ value: ToolType; label: string }> = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'opencode', label: 'OpenCode' },
  { value: null, label: '— empty —' },
];

export function MultiAgentGrid({ tab, hasBg, bgUrl, bgType }: Props) {
  const { state, dispatch } = useAppState();

  const multi = tab.multiAgent;
  if (!multi) return null;

  const onSelectTool = (paneIdx: number, tool: ToolType) => {
    dispatch({ type: 'SET_PANE_TOOL', tabId: tab.id, paneIdx, tool });
  };

  const onMakePrimary = (paneIdx: number) => {
    dispatch({ type: 'SET_PRIMARY_PANE', tabId: tab.id, paneIdx });
  };

  // Render only panes 1..N. Pane 0 is the Tab's existing TierTerminal
  // kept mounted in CenterPanel; see MultiAgentGrid.tsx doc comment above.
  const workerPanes = multi.panes.filter((p) => p.paneIdx !== 0);

  return (
    <>
      {workerPanes.map((pane) => {
        // Worker panes get fresh PTY sessions with suffixed ids so the
        // Rust MCP server sees them as independent targets.
        const paneSessionId = `${tab.id}::pane-${pane.paneIdx}`;
        const isPrimary = pane.paneIdx === multi.primaryPaneIdx;
        const isEmpty = pane.tool === null;

        return (
          <div
            key={pane.paneIdx}
            className={[
              'multi-agent-pane',
              `pane-slot-${pane.paneIdx}`,
              isPrimary ? 'is-primary' : '',
              isEmpty ? 'is-empty' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => !isPrimary && !isEmpty && onMakePrimary(pane.paneIdx)}
          >
            <header className="multi-agent-pane-header">
              <span className="pane-label">
                {isPrimary && '◉ '}
                Pane {pane.paneIdx} {pane.tool ? `— ${pane.tool}` : ''}
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
                    isActive={isPrimary && state.activeTerminalId === tab.id}
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
    </>
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
        {PANE_CLI_OPTIONS.filter((o) => o.value !== null).map((opt) => (
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
        Primary pane can then call <code>send_to_pane("{`${paneIdx}`}")</code>
      </div>
    </div>
  );
}
