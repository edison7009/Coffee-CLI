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
//   - Session id format `${tabId}::split-${paneIdx}` — distinct from the
//     multi-agent `::pane-` prefix on purpose. The backend `tier_terminal`
//     spawn path keys off `::pane-` to decide whether to inject hands-free
//     flags (`--dangerously-skip-permissions` / `--full-auto` /
//     `--approval-mode yolo`). Independent split is NOT orchestrated — the
//     user watches each pane and approves tool calls manually — so we want
//     those flags off. Keeping the prefix separate prevents accidental
//     auto-approve leakage. It also keeps FourSplit panes out of any
//     cross-pane sentinel / Gambit addressing that keys off `::pane-`.

import { useEffect, useState } from 'react';
import { useAppState, paneSessionId, type TerminalSession, type ToolType, type MultiAgentPane } from '../../store/app-state';
import { TierTerminal } from './TierTerminal';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { commands } from '../../tauri';
import { setFocusedPane } from '../../lib/pane-focus';
import { getToolDisplayName } from '../../lib/tool-info';
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

const PANE_CLI_OPTIONS: Array<{ value: ToolType; label: string }> = (
  ['claude', 'codex', 'gemini', 'opencode', 'openclaw', 'hermes'] as const
).map((value) => ({ value, label: getToolDisplayName(value) }));

// OpenClaw (persona forge) is directory-agnostic — its primary workflow
// is global persona/skill management, not a project folder. Skip the
// folder picker when a pane picks OpenClaw, matching the Desktop
// launchpad behavior. Hermes Agent IS folder-aware (its splash displays
// the launch cwd) so it gets the picker like the other CLIs.
const CWD_AGNOSTIC_TOOLS: ReadonlySet<ToolType> = new Set<ToolType>(['openclaw']);

export function FourSplitGrid({ tab, hasBg, bgUrl, bgType, paneCount = 4 }: Props) {
  const { state, dispatch } = useAppState();
  // Lives in app-state so FileStatsProvider / ChangesBoard can read which
  // pane to track diffs for. Reducer short-circuits same-value dispatches.
  const focusedPaneIdx = tab.multiAgent?.focusedPaneIdx ?? null;
  const setFocusedPaneIdx = (idx: number | null) => {
    dispatch({ type: 'SET_FOCUSED_PANE', tabId: tab.id, paneIdx: idx });
  };

  // Detect which of the 6 pane-eligible CLIs are actually installed so the
  // picker can grey out the ones the user doesn't have (same visual
  // language as the Desktop launchpad — see .launchpad-card-disabled).
  // Runs once on mount; missing keys default to `true` to avoid a
  // false-negative flash before the IPC resolves.
  const [toolsInstalled, setToolsInstalled] = useState<Record<string, boolean>>({});
  useEffect(() => {
    commands.checkToolsInstalled()
      .then(result => setToolsInstalled(result))
      .catch(() => {});
  }, []);

  const panes: MultiAgentPane[] = tab.multiAgent?.panes
    ?? Array.from({ length: paneCount }, (_, i) => ({
         paneIdx: i + 1,
         tool: null as ToolType,
       }));
  // If an existing tab has more panes than paneCount (shouldn't happen in
  // practice since each tab is locked to one paneCount), slice to avoid
  // overflow. This is defensive.
  const visiblePanes = panes.slice(0, paneCount);

  // Sync the left Explorer to a pane's folder. Explorer's lazy tree
  // (BrowserDirNode + listDirectory) re-reads automatically on folderPath change.
  const syncExplorerToFolder = (path: string) => {
    dispatch({ type: 'SET_FOLDER', path });
  };

  // Folder-picker → SET_PANE_TOOL flow. Each pane picks its own directory
  // before the PTY spawns; that's the whole point of the independent split.
  // - If the user cancels the picker, we do nothing (pane stays empty).
  // - Picker failure is logged but silent in UI — user can just re-click.
  const onSelectTool = async (paneIdx: number, tool: ToolType) => {
    // cwd-agnostic tools (OpenClaw / Hermes Agent) skip the folder picker
    // entirely — they don't bind to a project directory. TierTerminal will
    // fall back to tab.folderPath (or the process cwd) when spawning.
    if (CWD_AGNOSTIC_TOOLS.has(tool)) {
      dispatch({
        type: 'SET_PANE_TOOL',
        tabId: tab.id,
        paneIdx,
        tool,
      });
      return;
    }
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
        const paneSid = paneSessionId(tab.id, pane.paneIdx, 'split');
        const isEmpty = pane.tool === null;
        const isFocused = focusedPaneIdx === pane.paneIdx;
        const isDimmed = focusedPaneIdx !== null && !isFocused;
        // mousedown fires for clicks; focus covers keyboard tab-nav.
        // Empty panes leave Explorer on its current folder (no flash).
        const focusThisPane = () => {
          setFocusedPaneIdx(pane.paneIdx);
          setFocusedPane(tab.id, pane.paneIdx);
          if (pane.folderPath) syncExplorerToFolder(pane.folderPath);
        };

        return (
          <div
            key={pane.paneIdx}
            className={`multi-agent-pane pane-slot-${pane.paneIdx}${isDimmed ? ' is-dimmed' : ''}`}
            onMouseDownCapture={focusThisPane}
            onFocusCapture={focusThisPane}
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
                  commands.tierTerminalKill(paneSid).catch(() => {});
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
                  toolsInstalled={toolsInstalled}
                />
              ) : (
                <ErrorBoundary fallbackLabel="Tier Terminal Error">
                  <TierTerminal
                    key={paneSid}
                    sessionId={paneSid}
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
  toolsInstalled: Record<string, boolean>;
}

function EmptyPanePicker({ paneIdx: _paneIdx, onSelect, toolsInstalled }: EmptyPanePickerProps) {
  return (
    <div className="empty-pane-picker">
      <div className="empty-pane-options">
        {PANE_CLI_OPTIONS.map((opt) => {
          // Default to installed when the detection result hasn't landed
          // yet (keys missing) to avoid a false-negative flash on mount.
          const installed = toolsInstalled[String(opt.value)] !== false;
          return (
            <button
              key={String(opt.value)}
              className="empty-pane-option"
              disabled={!installed}
              onClick={(e) => {
                e.stopPropagation();
                if (!installed) return;
                onSelect(opt.value);
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
