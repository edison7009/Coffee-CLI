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
import { useAppState, type TerminalSession, type ToolType, type MultiAgentPane } from '../../store/app-state';
import { TierTerminal } from './TierTerminal';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { commands } from '../../tauri';
import { setFocusedPane } from '../../lib/pane-focus';
import { useT } from '../../i18n/useT';
import './MultiAgentGrid.css';

interface Props {
  tab: TerminalSession;
  hasBg: boolean;
  bgUrl: string;
  bgType: 'image' | 'video' | 'none';
  paneCount?: 2 | 3 | 4;
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

export function MultiAgentGrid({ tab, hasBg, bgUrl, bgType, paneCount = 4 }: Props) {
  const { state, dispatch } = useAppState();
  const [focusedPaneIdx, setFocusedPaneIdx] = useState<number | null>(null);

  // Detect which of the 3 coordination-eligible CLIs are actually installed
  // so the picker greys out the ones the user doesn't have (same visual
  // language as the Desktop launchpad — see .launchpad-card-disabled).
  // Runs once on mount; missing keys default to `true` so we don't flash
  // a false "disabled" state before the IPC resolves.
  const [toolsInstalled, setToolsInstalled] = useState<Record<string, boolean>>({});
  useEffect(() => {
    commands.checkToolsInstalled()
      .then(result => setToolsInstalled(result))
      .catch(() => {});
  }, []);

  // paneIdx is 1-indexed to match the user-visible badge numbering and
  // the MCP session id (`::pane-1` .. `::pane-4`). See the header comment.
  const panes: MultiAgentPane[] = (tab.multiAgent?.panes
    ?? Array.from({ length: paneCount }, (_, i) => ({
         paneIdx: i + 1,
         tool: null as ToolType,
       }))).slice(0, paneCount);

  // ─── Multi-agent mode handshake ─────────────────────────────────────
  //
  // Post-v1.5 the backend wires each pane's MCP server and CLI
  // artifacts lazily inside `tier_terminal_start` (per-pane temp dir
  // under `<temp>/coffee-cli/panes/`, plus a per-pane stub in
  // `~/.gemini/extensions/` for the Gemini extension loader).
  // Workspaces stay pristine — no CLAUDE.md / AGENTS.md / GEMINI.md /
  // .multi-agent/ ever gets written, no global ~/.codex / ~/.gemini
  // mcp_servers entries get touched.
  //
  // We still call enable/disable here so the backend has a structured
  // place to surface preflight warnings, and so future cross-cutting
  // logic (telemetry, license gating, …) has the obvious hook.
  const installedSigRef = useRef<string>('');
  const activeTools: string[] = Array.from(
    new Set(panes.map(p => p.tool).filter((t): t is NonNullable<ToolType> => !!t))
  ).map(String).sort();
  const sig = `${tab.folderPath ?? ''}|${activeTools.join(',')}`;
  useEffect(() => {
    if (!tab.folderPath) return;
    if (activeTools.length === 0) return;
    if (installedSigRef.current === sig) return;
    installedSigRef.current = sig;

    commands
      .enableMultiAgentMode(tab.folderPath, activeTools)
      .then((r) => {
        if (r.warnings?.length) {
          console.warn('[multi-agent] enable warnings:', r.warnings);
        }
      })
      .catch((e) => {
        console.warn('[multi-agent] enable_multi_agent_mode failed (UI still usable):', e);
      });
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup on unmount: notify the backend so it can run any future
  // cross-cutting teardown. Currently a no-op on the Rust side because
  // per-pane MCP servers and temp artifacts are pruned only at next
  // app launch via `mcp_injector::prune_pane_artifacts`.
  const cleanupPathRef = useRef<string | null>(null);
  cleanupPathRef.current = tab.folderPath ?? null;
  useEffect(() => {
    return () => {
      const ws = cleanupPathRef.current;
      if (!ws) return;
      if (!installedSigRef.current) return;
      commands
        .disableMultiAgentMode(ws)
        .catch((e) => console.warn('[multi-agent] disable on unmount failed:', e));
    };
  }, []);

  const onSelectTool = (paneIdx: number, tool: ToolType) => {
    dispatch({ type: 'SET_PANE_TOOL', tabId: tab.id, paneIdx, tool });
  };

  // 2-pane and 3-pane coordination always render as side-by-side columns — the 2×2
  // grid mode is only meaningful for 4 panes. The user's columns/grid
  // toggle in multi-agent settings therefore only applies when paneCount === 4.
  const isColumns = paneCount !== 4 || state.multiAgentLayout === 'columns';
  const layoutMod = isColumns
    ? ` multi-agent-grid--columns multi-agent-grid--columns-${paneCount}`
    : ' multi-agent-grid--grid';

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
            {(() => {
              // Green dot if sentinel detected a [COFFEE-DONE:paneN] marker
              // within the last 30 minutes. Past that we assume the pane has
              // started a new turn and the "done" signal is stale.
              const showDot = pane.sentinelEnabled && pane.completionTs
                && Date.now() - pane.completionTs < 30 * 60 * 1000;
              return isEmpty ? (
                <div className="pane-number-badge">
                  {pane.paneIdx}
                  {showDot && <span className="pane-completion-dot" aria-hidden="true" />}
                </div>
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
                  {showDot && <span className="pane-completion-dot" aria-hidden="true" />}
                </button>
              );
            })()}

            <div className="multi-agent-pane-body">
              {isEmpty ? (
                <EmptyPanePicker
                  paneIdx={pane.paneIdx}
                  onSelect={(tool) => onSelectTool(pane.paneIdx, tool)}
                  sentinelEnabled={!!pane.sentinelEnabled}
                  onToggleSentinel={() => dispatch({
                    type: 'SET_PANE_SENTINEL',
                    tabId: tab.id,
                    paneIdx: pane.paneIdx,
                    enabled: !pane.sentinelEnabled,
                  })}
                  toolsInstalled={toolsInstalled}
                />
              ) : (
                <ErrorBoundary fallbackLabel="Tier Terminal Error">
                  {/* Pass hasBg through so xterm stays transparent when
                      the user has a wallpaper set — this lets the single
                      grid-level .multi-agent-bg show through all panes.
                      bgUrl is intentionally empty so TierTerminal never
                      renders its own per-pane .tier-terminal-bg layer;
                      the shared grid wallpaper handles that instead. */}
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
  sentinelEnabled: boolean;
  onToggleSentinel: () => void;
  toolsInstalled: Record<string, boolean>;
}

// Per-CLI setup hints removed per user request: the paper-slice
// aesthetic calls for a completely clean empty pane — just the three
// CLI buttons, nothing else. Auth friction (Codex login, Gemini
// /auth) surfaces naturally once the user clicks; no need to
// pre-announce it. The skip-permissions auto-accept still lives in
// server.rs for Claude, so users don't see a speed bump there.
function EmptyPanePicker({ paneIdx: _paneIdx, onSelect, sentinelEnabled, onToggleSentinel, toolsInstalled }: EmptyPanePickerProps) {
  const t = useT();
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
      <div className="sentinel-toggle-row">
        <div
          className="sentinel-toggle-head"
          role="button"
          tabIndex={0}
          aria-pressed={sentinelEnabled}
          aria-label="Toggle sentinel protocol"
          onClick={(e) => { e.stopPropagation(); onToggleSentinel(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggleSentinel();
            }
          }}
        >
          <span className="sentinel-toggle-label">{t('sentinel.protocol' as any)}</span>
          <span
            className={`sentinel-switch${sentinelEnabled ? ' is-on' : ''}`}
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
}
