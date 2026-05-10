// file-stats.tsx — Multi-session diff stats provider.
//
// Tracks every live tab's session-folder pair so:
//   • The right-side ChangesBoard's global change log gets fed by ALL
//     tabs in real time — Claude editing files in tab1 while the user
//     is on tab2 immediately appears in the global list.
//   • The left-side Explorer's tree badges (consumed via useFileStats)
//     reflect the currently active tab's stats only.
//
// Baselines are stored in Rust as a single global path-keyed map
// (server.rs::snapshots) so reopening / closing tabs doesn't disturb
// the audit trail. Full reset on Coffee CLI restart only.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAppDispatch, useAppState, resolveDiffContext } from '../store/app-state';
import type { ToolType } from '../store/app-state';
import { commands } from '../tauri';

export type FileStats = { added: number; deleted: number; mtimeMs: number };
type FileStatsMap = Map<string, FileStats>;

const FileStatsContext = createContext<FileStatsMap | null>(null);
export const useFileStats = () => useContext(FileStatsContext);

const normPath = (p: string) => p.replace(/\\/g, '/');
const normRoot = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

// CWD-agnostic tools don't bind to a local folder; their snapshots are no-ops.
// Mirrors the same set in Explorer.tsx.
const CWD_AGNOSTIC_TOOLS: ReadonlySet<ToolType> = new Set<ToolType>(['openclaw', 'hermes', 'remote']);

// Per-session state. Module-scoped so it survives Provider re-renders /
// panel toggles. Closed tabs leave entries in this map until either the
// app exits or another tab opens with the same sessionId — neither
// realistic, so in practice it's "sticky" for the app's lifetime,
// matching the global change log's app-lifecycle scope.
type SessionState = {
  folderPath: string;
  tool: ToolType | null;
  /** Resolves once `startFolderSnapshot` returns — refresh requests
   *  for this session await this before calling computeFolderStats so
   *  the baseline is guaranteed to exist. */
  baselineReady: Promise<unknown>;
};
const sessionStates = new Map<string, SessionState>();

export function FileStatsProvider({ children }: { children: ReactNode }) {
  const { state } = useAppState();
  const dispatch = useAppDispatch();
  const activeSession = state.terminals.find(t => t.id === state.activeTerminalId);
  const diffCtx = resolveDiffContext(activeSession);
  const activeSessionId = diffCtx?.sessionId ?? null;

  const [activeStats, setActiveStats] = useState<FileStatsMap | null>(null);
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  // Refresh one session against its baseline → push entries to the
  // global change log → if it's the currently-active session, also
  // bump the Context value so left-side badges update.
  const refreshSession = useCallback(async (sid: string) => {
    const s = sessionStates.get(sid);
    if (!s) return;
    try {
      await s.baselineReady;
      const raw = await commands.computeFolderStats(s.folderPath);
      const m = new Map<string, FileStats>();
      const entries: { path: string; added: number; deleted: number; mtimeMs: number }[] = [];
      for (const [k, v] of Object.entries(raw)) {
        const p = normPath(k);
        m.set(p, v);
        entries.push({ path: p, added: v.added, deleted: v.deleted, mtimeMs: v.mtimeMs });
      }
      dispatch({ type: 'MERGE_GLOBAL_CHANGES', tool: s.tool, projectRoot: s.folderPath, entries });
      if (sid === activeSessionIdRef.current) {
        setActiveStats(m);
      }
    } catch {
      // Swallow — keep last-known stats; a future event will retry.
    }
  }, [dispatch]);

  // Sync sessionStates with live terminals: ensure baseline is started
  // for every eligible (folder + non-CWD-agnostic tool) live session.
  // Combo change (same sid, different folder/tool) → restart baseline
  // (a no-op on Rust side since first-seen wins, but the frontend bookkeeping
  // tracks the new combo). Closed tabs: prune from sessionStates so the
  // fs-refresh handler stops pinging dead sessions.
  useEffect(() => {
    const live = new Set<string>();
    for (const term of state.terminals) {
      const ctx = resolveDiffContext(term);
      if (!ctx?.sessionId || !ctx?.folderPath) continue;
      if (ctx.tool && CWD_AGNOSTIC_TOOLS.has(ctx.tool)) continue;
      live.add(ctx.sessionId);

      const existing = sessionStates.get(ctx.sessionId);
      const sameCombo =
        existing?.folderPath === ctx.folderPath && existing?.tool === (ctx.tool ?? null);
      if (!existing || !sameCombo) {
        const baselineReady = commands.startFolderSnapshot(ctx.folderPath).catch(() => {});
        sessionStates.set(ctx.sessionId, {
          folderPath: ctx.folderPath,
          tool: ctx.tool ?? null,
          baselineReady,
        });
        void baselineReady.then(() => refreshSession(ctx.sessionId));
      }
    }
    // Prune dead session entries (frontend-only bookkeeping)
    for (const sid of Array.from(sessionStates.keys())) {
      if (!live.has(sid)) sessionStates.delete(sid);
    }
  }, [state.terminals, refreshSession]);

  // When the user switches active tab, immediately blank Explorer's
  // badges and kick a refresh so they reflect the new tab's project
  // without waiting for the next fs-refresh event.
  useEffect(() => {
    if (!activeSessionId || !sessionStates.has(activeSessionId)) {
      setActiveStats(null);
      return;
    }
    setActiveStats(new Map());
    void refreshSession(activeSessionId);
  }, [activeSessionId, refreshSession]);

  // fs-refresh: file system mutation observed somewhere → fan out to
  // every live session whose folder contains the changed dir. Per-
  // session debounce prevents a burst of events from queuing N
  // refreshes for the same session.
  useEffect(() => {
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ dirPath: string }>;
      const dir = normRoot(ev.detail.dirPath);
      for (const [sid, s] of sessionStates) {
        const target = normRoot(s.folderPath);
        if (dir === target || dir.startsWith(target + '/')) {
          const existing = debounceTimers.get(sid);
          if (existing) clearTimeout(existing);
          debounceTimers.set(sid, setTimeout(() => {
            debounceTimers.delete(sid);
            void refreshSession(sid);
          }, 300));
        }
      }
    };
    window.addEventListener('fs-refresh', handler as EventListener);
    return () => {
      window.removeEventListener('fs-refresh', handler as EventListener);
      for (const t of debounceTimers.values()) clearTimeout(t);
    };
  }, [refreshSession]);

  return (
    <FileStatsContext.Provider value={activeStats}>
      {children}
    </FileStatsContext.Provider>
  );
}
