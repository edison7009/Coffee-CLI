// MultiAgentGrid.tsx — independent "four pane" tab content.
//
// Design (user spec 2026-04-23):
//   Four paper slices. No borders, no card backgrounds, no paddings, no
//   header strips. Each pane renders identically to a single-terminal
//   tab. Only visual differentiation between panes is:
//     (a) a 1/2/3/4 number badge in the top-right, tinted by the theme
//         accent;
//     (b) when any pane has keyboard focus, the other three dim to 0.35
//         opacity so the user's eye follows the cursor.
//
//   All four panes are peers — no primary/worker distinction. Every
//   pane has its own PTY session `${tabId}::pane-${idx}`; the backend
//   PaneStore / MCP tools treat them uniformly.
//
// Implementation notes:
//   - focused pane detection uses onFocus (capture, because the event
//     fires on the nested xterm textarea and we want to catch it on the
//     pane wrapper). Initial state is null → all panes full brightness
//     until the first click; this keeps the first-paint visually calm.
//   - `requiresCwd: false` was set in CenterPanel's Launchpad entry, so
//     tab.folderPath may be null. TierTerminal handles that by falling
//     back to the user's home directory inside terminal::spawn.

import { useState } from 'react';
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

const PANE_COUNT = 4;

export function MultiAgentGrid({ tab, hasBg, bgUrl, bgType }: Props) {
  const { state, dispatch } = useAppState();
  const [focusedPaneIdx, setFocusedPaneIdx] = useState<number | null>(null);

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
        const paneSessionId = `${tab.id}::pane-${pane.paneIdx}`;
        const isEmpty = pane.tool === null;
        const isFocused = focusedPaneIdx === pane.paneIdx;
        const isDimmed = focusedPaneIdx !== null && !isFocused;

        return (
          <div
            key={pane.paneIdx}
            className={`multi-agent-pane pane-slot-${pane.paneIdx}${isDimmed ? ' is-dimmed' : ''}`}
            onFocusCapture={() => setFocusedPaneIdx(pane.paneIdx)}
          >
            {/* Theme-tinted pane number badge; 1-indexed per user request. */}
            <div className="pane-number-badge">{pane.paneIdx + 1}</div>

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
                    isActive={isFocused}
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

function EmptyPanePicker({ paneIdx: _paneIdx, onSelect }: EmptyPanePickerProps) {
  return (
    <div className="empty-pane-picker">
      <div className="empty-pane-title">Choose a CLI</div>
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
    </div>
  );
}
