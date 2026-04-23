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
//   pane has its own PTY session `${tabId}::pane-${idx}` where idx is
//   1..4 matching the UI badge; the backend PaneStore / MCP tools see
//   the same id, so when the user says "pane 2" the CLI's MCP call
//   targets the exact same slot.
//
// Implementation notes:
//   - focused pane detection uses onFocus (capture, because the event
//     fires on the nested xterm textarea and we want to catch it on the
//     pane wrapper). Initial state is null → all panes full brightness
//     until the first click; this keeps the first-paint visually calm.
//   - `requiresCwd: false` was set in CenterPanel's Launchpad entry, so
//     tab.folderPath may be null. TierTerminal handles that by falling
//     back to the user's home directory inside terminal::spawn.

import { useEffect, useRef, useState } from 'react';
import { useAppState, type TerminalSession, type ToolType } from '../../store/app-state';
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
}

// v1.0 primary CLIs = Claude Code / Codex / Gemini only. OpenCode was
// evaluated but dropped — its MCP config shape ('mcp' vs 'mcpServers')
// and workspace-local `opencode.json` expectation diverge enough from
// the other three that it deserves a v1.1 pass of its own rather than
// a half-baked slot here. Users who want OpenCode in a quadrant can
// still launch it manually via the single-terminal path and wire it
// into the coffee-cli MCP endpoint by hand.
const PANE_CLI_OPTIONS: Array<{ value: ToolType; label: string }> = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'gemini', label: 'Gemini' },
];

const PANE_COUNT = 4;

export function MultiAgentGrid({ tab, hasBg, bgUrl, bgType }: Props) {
  const { state, dispatch } = useAppState();
  const [focusedPaneIdx, setFocusedPaneIdx] = useState<number | null>(null);

  // ─── Auto-enable multi-agent mode on first mount with a workspace ──
  // When this tab opens with `tool='multi-agent'` AND a valid
  // folderPath, tell the Rust backend to install the thin-pointer
  // CLAUDE.md / AGENTS.md / GEMINI.md in the workspace root AND the
  // `.multi-agent/` meta directory, and merge the coffee-cli MCP
  // endpoint into each detected primary CLI's config.
  //
  // This is fail-soft: if the backend call errors (permissions, MCP
  // server not ready, etc.) we log a warning but keep the UI usable so
  // the user can still launch pure PTY CLIs in the panes.
  //
  // Ref is keyed by workspace path so switching the tab's folder
  // re-triggers the install against the new workspace; same-path
  // re-renders don't re-run (idempotent on the backend anyway, but
  // saves the round-trip).
  const enabledForWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!tab.folderPath) return;
    if (enabledForWorkspaceRef.current === tab.folderPath) return;
    enabledForWorkspaceRef.current = tab.folderPath;

    commands
      .enableMultiAgentMode(tab.folderPath)
      .then((r) => {
        if (r.warnings?.length) {
          console.warn('[multi-agent] enable warnings:', r.warnings);
        }
        console.log('[multi-agent] ready at', r.mcp_url,
          '— touched', (r.touched_config_files?.length ?? 0)
            + (r.touched_md_files?.length ?? 0), 'files');
      })
      .catch((e) => {
        console.warn('[multi-agent] enable_multi_agent_mode failed (UI still usable):', e);
      });
  }, [tab.folderPath]);

  // paneIdx is 1-indexed to match the user-visible badge numbering and
  // the MCP session id (`::pane-1` .. `::pane-4`). See the header comment.
  const panes = tab.multiAgent?.panes
    ?? (Array.from({ length: PANE_COUNT }, (_, i) => ({
         paneIdx: i + 1,
         tool: null as ToolType,
       })) as Array<{ paneIdx: number; tool: ToolType; toolData?: string }>);

  const onSelectTool = (paneIdx: number, tool: ToolType) => {
    dispatch({ type: 'SET_PANE_TOOL', tabId: tab.id, paneIdx, tool });
  };

  const layoutMod = state.multiAgentLayout === 'columns' ? ' multi-agent-grid--columns' : ' multi-agent-grid--grid';

  return (
    <div className={`multi-agent-grid-standalone${layoutMod}${hasBg && bgUrl ? ' multi-agent-has-bg' : ''}`}>
      {/* Grid-level wallpaper. Sits behind all four panes so empty
          panes (CLI picker state) and any gaps show the user's bg
          just like single-terminal tabs do. Filled panes also get
          their TierTerminal's own .tier-terminal-bg layer — harmless
          redundancy, but guarantees xterm-transparent composition
          stays correct regardless of grid-level state. Mirrors the
          .launchpad-bg pattern in CenterPanel so the wallpaper-dim
          overlay (--wallpaper-dim on :root) works the same way. */}
      {hasBg && bgUrl && (
        <div className="multi-agent-bg">
          {bgType === 'video'
            ? <video src={bgUrl} autoPlay loop muted playsInline />
            : <img src={bgUrl} alt="" draggable={false} />}
        </div>
      )}
      {panes.map((pane) => {
        const paneSessionId = `${tab.id}::pane-${pane.paneIdx}`;
        const isEmpty = pane.tool === null;
        const isFocused = focusedPaneIdx === pane.paneIdx;
        const isDimmed = focusedPaneIdx !== null && !isFocused;

        return (
          <div
            key={pane.paneIdx}
            className={`multi-agent-pane pane-slot-${pane.paneIdx}${isDimmed ? ' is-dimmed' : ''}`}
            // Capture-phase so we win the focus-intent announcement even
            // when the click lands on inert background (empty pane body,
            // padding around the CLI picker, gap between xterm canvas
            // and pane edges). onFocusCapture alone only fires when the
            // click actually hits a focusable element, which misses all
            // the "dead" pixels users expect to be clickable.
            onMouseDownCapture={() => {
              setFocusedPaneIdx(pane.paneIdx);
              // Mirror to a module-level registry so ActiveGambit (which
              // lives at App-level, outside this component) can route its
              // Send to the pane the user last clicked.
              setFocusedPane(tab.id, pane.paneIdx);
            }}
            onFocusCapture={() => {
              setFocusedPaneIdx(pane.paneIdx);
              setFocusedPane(tab.id, pane.paneIdx);
            }}
          >
            {/* Theme-tinted pane number badge.
                - Empty pane: plain numeric label (nothing to close here).
                - Active pane: button that shows the number by default and
                  swaps to × on hover. Clicking kills this pane's PTY and
                  resets its tool to null — the pane re-renders as the
                  3-button CLI picker without disturbing the other panes
                  or closing the whole Tab. */}
            {isEmpty ? (
              <div className="pane-number-badge">{pane.paneIdx}</div>
            ) : (
              <button
                type="button"
                className="pane-number-badge pane-number-badge--closable"
                aria-label={`Close pane ${pane.paneIdx}`}
                onClick={(e) => {
                  e.stopPropagation();
                  // Best-effort kill. If the PTY is already gone the
                  // backend logs a warning; surfacing it to the user
                  // would be noise since the UI result is the same.
                  commands.tierTerminalKill(paneSessionId).catch(() => {});
                  // If the pane being closed had focus, clear it so
                  // Gambit doesn't keep routing to a non-existent pane.
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

// Per-CLI setup hints removed per user request: the paper-slice
// aesthetic calls for a completely clean empty pane — just the three
// CLI buttons, nothing else. Auth friction (Codex login, Gemini
// /auth) surfaces naturally once the user clicks; no need to
// pre-announce it. The skip-permissions auto-accept still lives in
// server.rs for Claude, so users don't see a speed bump there.
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
