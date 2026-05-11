// file-stats.tsx — Per-tab folder-diff stats provider.
//
// Two responsibilities, one provider:
//
//   1. Rust baseline lifecycle. Each live, eligible terminal session
//      triggers `start_folder_snapshot` once when its (tool, folder)
//      combo first appears. Rust's global per-file baseline is
//      "first-seen wins" so re-triggering is cheap, but we skip the
//      no-op call to avoid the Tauri IPC round-trip. Baselines persist
//      for the app's lifetime; DiffPanel's `getBaselineContent(path)`
//      resolves against this map.
//
//   2. Snapshot-diff polling for the active session. We re-run
//      `compute_folder_stats(activeFolderPath)` whenever:
//        - the active session/folder changes
//        - any `agent-status` event arrives (an AI just did something)
//        - any `fs-refresh` event arrives (the Rust fs-watcher or a
//          local context-menu op signaled the tree changed)
//      All three converge into one debounced (300 ms) re-fetch so a
//      burst of file events doesn't fan out into N re-walks.
//
// Tool-agnostic by design: the stats are folder-state-vs-baseline, so
// any modification (Claude, Codex, OpenCode, an external editor,
// `git pull`, `npm install`) appears in the same audit list.
// Per-tool hook attribution was removed in v2.7.x.

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAppState, resolveDiffContext } from '../store/app-state';
import type { ToolType } from '../store/app-state';
import { commands } from '../tauri';
import { subscribeAgentStatus } from './agent-status-bus';

export type FileStats = { added: number; deleted: number; mtimeMs: number };
type FileStatsMap = Map<string, FileStats>;

const FileStatsContext = createContext<FileStatsMap | null>(null);
export const useFileStats = () => useContext(FileStatsContext);

// CWD-agnostic tabs don't bind to a local workspace folder, so any
// folder-diff work for them is wasted. `openclaw` / `hermes` / `remote`
// genuinely have no local CWD; `history` and `installer` happen to
// carry a folderPath but the user is just browsing sessions / running
// an installer — not editing files we should audit.
const CWD_AGNOSTIC_TOOLS: ReadonlySet<ToolType> = new Set<ToolType>([
  'openclaw', 'hermes', 'remote', 'history', 'installer',
]);

// Module-scoped: which (sessionId → folder) combos we've already
// asked Rust to baseline. Survives Provider re-renders. Pruned when
// a tab closes; entries persist for the app's lifetime otherwise so
// DiffPanel can resolve baselines for closed-tab audit entries.
const baselinedFolders = new Map<string, string>();

// Debounce window for re-fetching stats. 300 ms swallows the typical
// editor-save event burst (notify-debouncer-full upstream already
// coalesces at 200 ms; this is an extra cushion on top so a chain of
// agent-status + fs-refresh + tab-activation lands as one walk).
const REFRESH_DEBOUNCE_MS = 300;

export function FileStatsProvider({ children }: { children: ReactNode }) {
  const { state } = useAppState();
  const activeSession = state.terminals.find(t => t.id === state.activeTerminalId);
  const diffCtx = resolveDiffContext(activeSession);
  // `activeTool` gate is what stops a launchpad tab (the one the user
  // is currently choosing a tool on) from showing audit data. The
  // REMOVE_TERMINAL reducer inherits the closed tab's `folderPath`
  // onto its replacement launchpad tab, so without this gate the
  // freshly-opened picker would inherit the prior tab's diff view —
  // confusing because the user has not yet started any AI work in
  // the new tab. No tool = no work in progress = no audit.
  const activeFolderPath = diffCtx?.folderPath ?? null;
  const activeSessionId = diffCtx?.sessionId ?? null;
  const activeTool = diffCtx?.tool ?? null;

  // Stats keyed by sessionId. Survives session-switch so flipping
  // back to a previous tab shows its last-known stats instantly
  // (next refresh tick reconciles). Cleared per-tab on REMOVE_TERMINAL
  // would be ideal but the cost of stale entries is negligible (just
  // GC pressure) and clearing complicates the lifecycle.
  const [tabStats, setTabStats] = useState<Map<string, FileStatsMap>>(new Map());

  // 1. Rust baseline lifecycle. One start_folder_snapshot per
  //    (sessionId, combo) — Rust's first-seen-wins makes repeats
  //    harmless, but we still avoid the IPC.
  useEffect(() => {
    const live = new Set<string>();
    for (const term of state.terminals) {
      const ctx = resolveDiffContext(term);
      if (!ctx?.sessionId || !ctx?.folderPath) continue;
      if (ctx.tool && CWD_AGNOSTIC_TOOLS.has(ctx.tool)) continue;
      live.add(ctx.sessionId);

      const combo = `${ctx.tool ?? ''}::${ctx.folderPath}`;
      if (baselinedFolders.get(ctx.sessionId) !== combo) {
        baselinedFolders.set(ctx.sessionId, combo);
        commands.startFolderSnapshot(ctx.folderPath).catch(() => {});
      }
    }
    for (const sid of Array.from(baselinedFolders.keys())) {
      if (!live.has(sid)) baselinedFolders.delete(sid);
    }
    // Drop tabStats entries for sessions no longer alive. Without
    // this, a closed tab's stats linger in the Map and re-surface if
    // the user happens to switch to a launchpad tab that inherited
    // the closed tab's sessionId (which can't happen today because
    // ids are crypto.randomUUID, but the cleanup keeps the Map from
    // growing unboundedly across long sessions either way).
    setTabStats(prev => {
      let changed = false;
      const next = new Map(prev);
      for (const sid of Array.from(next.keys())) {
        if (!live.has(sid)) {
          next.delete(sid);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [state.terminals]);

  // 2. Snapshot-diff polling. Re-fetch active session's stats on
  //    every trigger, debounced. Gated on `activeTool` — a launchpad
  //    tab (tool=null) is not a workspace, so we don't poll it.
  const debounceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!activeFolderPath || !activeSessionId || !activeTool) return;
    const folder = activeFolderPath;
    const sid = activeSessionId;

    const fetchStats = () => {
      commands.computeFolderStats(folder).then(rows => {
        const m: FileStatsMap = new Map();
        for (const r of rows) {
          m.set(r.path, { added: r.added, deleted: r.deleted, mtimeMs: r.mtime_ms });
        }
        setTabStats(prev => {
          const next = new Map(prev);
          next.set(sid, m);
          return next;
        });
      }).catch(() => {});
    };

    const schedule = () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(fetchStats, REFRESH_DEBOUNCE_MS);
    };

    // Initial fetch on (folder, session) change.
    schedule();

    // Tauri fs-refresh — Rust fs-watcher signals OS-level changes.
    let unlistenTauri: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const fn = await listen('fs-refresh', schedule);
      if (cancelled) fn();
      else unlistenTauri = fn;
    })().catch(() => {});

    // DOM fs-refresh — Explorer's local context-menu ops dispatch this
    // on the window for synthetic refreshes that bypass the watcher
    // (rename within Coffee CLI, paste, etc.).
    const onWindowRefresh = () => schedule();
    window.addEventListener('fs-refresh', onWindowRefresh);

    // agent-status — any AI tool state change is a strong hint
    // something changed on disk. Catches edits the fs-watcher might
    // miss (e.g., atomic-rename writes on Windows) and ensures a
    // refresh fires within seconds of an agent turn completing.
    const unsubStatus = subscribeAgentStatus(schedule);

    return () => {
      cancelled = true;
      window.removeEventListener('fs-refresh', onWindowRefresh);
      unlistenTauri?.();
      unsubStatus();
      if (debounceRef.current != null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [activeFolderPath, activeSessionId, activeTool]);

  const activeStats: FileStatsMap | null = activeSessionId
    ? tabStats.get(activeSessionId) ?? null
    : null;

  return (
    <FileStatsContext.Provider value={activeStats}>
      {children}
    </FileStatsContext.Provider>
  );
}
