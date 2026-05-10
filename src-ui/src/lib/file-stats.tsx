// file-stats.tsx — Baseline lifecycle + Explorer-badge derive layer.
//
// Two responsibilities, one slim provider:
//
//   1. Baseline lifecycle (Rust side). Each live, eligible terminal
//      session triggers `start_folder_snapshot` once when its
//      (tool, folder) combo first appears. Rust's global per-file
//      baseline is "first-seen wins" so re-triggering is cheap, but
//      we still skip the no-op call to avoid the Tauri IPC round-trip.
//      Baselines persist for the app's lifetime; DiffPanel's
//      `getBaselineContent(path)` resolves against this map.
//
//   2. Explorer tree badges. The left-side file tree shows "+N −M"
//      next to files the active session's tool has edited. The
//      Context value is now DERIVED from `state.globalChangeLog`
//      filtered to the active session's projectRoot — same source as
//      the right-side ChangesBoard, so both panels stay in sync and
//      reflect the audit-log philosophy ("only what tools running
//      INSIDE Coffee CLI changed").
//
// What was removed (post v2.7.0 hook architecture):
//   - `compute_folder_stats` polling on fs-refresh events
//   - `MERGE_GLOBAL_CHANGES` dispatches from this file
//   - Per-session `latestStats` shadow maps
// All that data now flows from the Rust hook server's
// `tool-file-edit` event → `RECORD_TOOL_FILE_EDIT` reducer
// (subscribed in App.tsx).

import { createContext, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useAppState, resolveDiffContext } from '../store/app-state';
import type { ToolType } from '../store/app-state';
import { commands } from '../tauri';

export type FileStats = { added: number; deleted: number; mtimeMs: number };
type FileStatsMap = Map<string, FileStats>;

const FileStatsContext = createContext<FileStatsMap | null>(null);
export const useFileStats = () => useContext(FileStatsContext);

const normRoot = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

// CWD-agnostic tools don't bind to a local folder; their snapshots are no-ops.
// Mirrors the same set in Explorer.tsx.
const CWD_AGNOSTIC_TOOLS: ReadonlySet<ToolType> = new Set<ToolType>(['openclaw', 'hermes', 'remote']);

// Module-scoped: which (sessionId → folder) combos we've already
// asked Rust to baseline. Survives Provider re-renders. Pruned when
// a tab closes; entries persist for the app's lifetime otherwise so
// DiffPanel can resolve baselines for closed-tab audit entries.
const baselinedFolders = new Map<string, string>();

export function FileStatsProvider({ children }: { children: ReactNode }) {
  const { state } = useAppState();
  const activeSession = state.terminals.find(t => t.id === state.activeTerminalId);
  const diffCtx = resolveDiffContext(activeSession);
  const activeFolderPath = diffCtx?.folderPath ?? null;

  // Ensure a Rust-side baseline exists for every live, eligible
  // session. Combo change (same sid, different folder/tool) issues
  // a fresh `start_folder_snapshot` — Rust's first-seen-wins rule
  // means re-baselining the same folder is harmless to the map.
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
    // Prune dead session bookkeeping. Rust-side baselines aren't
    // dropped (closed tabs may still have audit entries that need
    // baseline content for diff display).
    for (const sid of Array.from(baselinedFolders.keys())) {
      if (!live.has(sid)) baselinedFolders.delete(sid);
    }
  }, [state.terminals]);

  // Derive the active session's FileStats from globalChangeLog. Two
  // filters: (1) projectRoot matches the active session's folder, and
  // (2) the entry was reported by the active session itself (sessionIds
  // contains diffCtx.sessionId). Explorer's tree badges are scoped to
  // "files THIS tab edited" — opening a fresh Claude tab on a folder
  // where OpenCode previously edited shouldn't show OpenCode's edits
  // in the new tab's tree. ChangesBoard stays app-lifecycle scope and
  // continues to show every reporter, see ChangesBoard.tsx.
  const activeSessionId = diffCtx?.sessionId ?? null;
  const activeStats = useMemo<FileStatsMap | null>(() => {
    if (!activeFolderPath || !activeSessionId) return null;
    const targetRoot = normRoot(activeFolderPath);
    const m = new Map<string, FileStats>();
    for (const [absPath, entry] of state.globalChangeLog) {
      if (normRoot(entry.projectRoot) !== targetRoot) continue;
      if (!entry.sessionIds.includes(activeSessionId)) continue;
      m.set(absPath, {
        added: entry.added,
        deleted: entry.deleted,
        mtimeMs: entry.mtimeMs,
      });
    }
    return m;
  }, [state.globalChangeLog, activeFolderPath, activeSessionId]);

  return (
    <FileStatsContext.Provider value={activeStats}>
      {children}
    </FileStatsContext.Provider>
  );
}
