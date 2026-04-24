// FourSplitGrid.tsx — Independent Split (N = 2 / 3 / 4).
//
// Same pane grid shape as MultiAgentGrid but with ZERO coordination:
//   - No MCP server injection into the user's CLI configs
//   - No `.multi-agent/` meta directory written to the workspace
//   - No CLAUDE.md / AGENTS.md / GEMINI.md thin-pointers
//   - Each pane is a plain independent PTY session; each pane can also
//     point at its own folder (see onSelectTool → folder picker below).
//
// `paneCount` prop controls 2 / 3 / 4:
//   - 4: respects state.multiAgentLayout → 2×2 (grid) or 1×4 (columns)
//   - 2 / 3: forced side-by-side columns layout, no 2×2 option
//     (so the TitleBar layout toggle should be hidden by the caller).
//
// Kept verbatim from MultiAgentGrid:
//   - PANE_CLI_OPTIONS restricted to Claude / Codex / Gemini (same 3 CLIs)
//   - Focus dimming, pane number badge with hover-× close, CSS classes
//     (reuses .multi-agent-grid-standalone styling — pure visual parity)
//   - Session id format `${tabId}::pane-${paneIdx}` (tabId is globally
//     unique so there's no collision with multi-agent panes)

import { useState } from 'react';
import { useAppState, type TerminalSession, type ToolType, type MultiAgentPane } from '../../store/app-state';
import { TierTerminal } from './TierTerminal';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { commands } from '../../tauri';
import { setFocusedPane } from '../../lib/pane-focus';
import './MultiAgentGrid.css';

interface Props {
  tab: TerminalSession;
  hasBg: boolean;
  bgUrl: string;
  bgType: 'image' | 'video' | 'none';
  /**
   * Number of panes the grid should render. 4 respects the user's
   * multiAgentLayout (2×2 vs 1×4); 2 and 3 always render side-by-side.
   * Defaults to 4 so legacy call sites keep working.
   */
  paneCount?: 2 | 3 | 4;
}

const PANE_CLI_OPTIONS: Array<{ value: ToolType; label: string }> = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'opencode', label: 'OpenCode' },
];

export function FourSplitGrid({ tab, hasBg, bgUrl, bgType, paneCount = 4 }: Props) {
  const { state, dispatch } = useAppState();
  const [focusedPaneIdx, setFocusedPaneIdx] = useState<number | null>(null);

  const panes: MultiAgentPane[] = tab.multiAgent?.panes
    ?? Array.from({ length: paneCount }, (_, i) => ({
         paneIdx: i + 1,
         tool: null as ToolType,
       }));
  // If an existing tab has more panes than paneCount (shouldn't happen in
  // practice since each tab is locked to one paneCount), slice to avoid
  // overflow. This is defensive.
  const visiblePanes = panes.slice(0, paneCount);

  // Sync the left Explorer to a pane's folder: update the tab's folderPath
  // so the path text changes, AND trigger a scanFolder → SET_SCAN so the
  // actual file tree contents refresh. Without the scan, Explorer would
  // show the previous pane's files under the new path (the bug the user
  // reported — "path swaps but list doesn't").
  const syncExplorerToFolder = (path: string) => {
    dispatch({ type: 'SET_FOLDER', path });
    commands.scanFolder(path)
      .then(data => dispatch({ type: 'SET_SCAN', data }))
      .catch(err => console.warn('[FourSplitGrid] scanFolder failed:', err));
  };

  // Folder-picker → SET_PANE_TOOL flow. Each pane picks its own directory
  // before the PTY spawns; that's the whole point of the independent split.
  // - If the user cancels the picker, we do nothing (pane stays empty).
  // - Picker failure is logged but silent in UI — user can just re-click.
  const onSelectTool = async (paneIdx: number, tool: ToolType) => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true });
      if (!selected || typeof selected !== 'string') return;
      dispatch({
        type: 'SET_PANE_TOOL',
        tabId: tab.id,
        paneIdx,
        tool,
        folderPath: selected,
      });
      // Sync left Explorer (path + file list) to this pane's new folder.
      syncExplorerToFolder(selected);
    } catch (err) {
      console.error('[FourSplitGrid] Folder picker failed:', err);
    }
  };

  // Layout rules:
  //   - 4 panes: honor state.multiAgentLayout (2×2 vs 1×4, CSS classes)
  //   - 2 or 3 panes: forced side-by-side columns, applied via inline
  //     grid-template-columns (no CSS class needed — avoids bloating the
  //     stylesheet with N-specific rules).
  const layoutMod = paneCount === 4
    ? (state.multiAgentLayout === 'columns' ? ' multi-agent-grid--columns' : ' multi-agent-grid--grid')
    : '';
  const gridStyle = paneCount === 4
    ? undefined
    : {
        gridTemplateColumns: `repeat(${paneCount}, 1fr)`,
        gridTemplateRows: '1fr',
      };

  return (
    <div
      className={`multi-agent-grid-standalone${layoutMod}${hasBg && bgUrl ? ' multi-agent-has-bg' : ''}`}
      style={gridStyle}
    >
      {hasBg && bgUrl && (
        <div className="multi-agent-bg">
          {bgType === 'video'
            ? <video src={bgUrl} autoPlay loop muted playsInline />
            : <img src={bgUrl} alt="" draggable={false} />}
        </div>
      )}
      {visiblePanes.map((pane) => {
        const paneSessionId = `${tab.id}::pane-${pane.paneIdx}`;
        const isEmpty = pane.tool === null;
        const isFocused = focusedPaneIdx === pane.paneIdx;
        const isDimmed = focusedPaneIdx !== null && !isFocused;

        return (
          <div
            key={pane.paneIdx}
            className={`multi-agent-pane pane-slot-${pane.paneIdx}${isDimmed ? ' is-dimmed' : ''}`}
            onMouseDownCapture={() => {
              setFocusedPaneIdx(pane.paneIdx);
              setFocusedPane(tab.id, pane.paneIdx);
              // Switch left Explorer to this pane's folder (path + list).
              // Empty panes have no folder yet — leave Explorer on whatever
              // it was showing (better than flashing to nothing).
              if (pane.folderPath) syncExplorerToFolder(pane.folderPath);
            }}
            onFocusCapture={() => {
              setFocusedPaneIdx(pane.paneIdx);
              setFocusedPane(tab.id, pane.paneIdx);
              if (pane.folderPath) syncExplorerToFolder(pane.folderPath);
            }}
          >
            {isEmpty ? (
              <div className="pane-number-badge">{pane.paneIdx}</div>
            ) : (
              <button
                type="button"
                className="pane-number-badge pane-number-badge--closable"
                aria-label={`Close pane ${pane.paneIdx}`}
                onClick={(e) => {
                  e.stopPropagation();
                  commands.tierTerminalKill(paneSessionId).catch(() => {});
                  if (focusedPaneIdx === pane.paneIdx) {
                    setFocusedPaneIdx(null);
                    setFocusedPane(tab.id, null);
                  }
                  dispatch({
                    type: 'SET_PANE_TOOL',
                    tabId: tab.id,
                    paneIdx: pane.paneIdx,
                    tool: null,
                  });
                }}
              >
                <span className="pane-badge-num">{pane.paneIdx}</span>
                <span className="pane-badge-x" aria-hidden="true">×</span>
              </button>
            )}

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
                    // Per-pane folder is the core of the independent split. Fall back to
                    // tab.folderPath only if somehow a pane got filled
                    // without going through onSelectTool (defensive).
                    folderPath={pane.folderPath ?? tab.folderPath}
                    hasBg={hasBg}
                    bgUrl=""
                    bgType="none"
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
