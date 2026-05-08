// file-stats.tsx — App-level provider for per-tab "+N -M since session start"
// diff stats. Both Explorer (left) and ChangesBoard (right) consume the same
// snapshot so the right-side tab keeps showing modified files even when the
// left panel is collapsed.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAppState, resolveDiffContext } from '../store/app-state';
import type { ToolType } from '../store/app-state';
import { commands } from '../tauri';

export type FileStats = { added: number; deleted: number };
type FileStatsMap = Map<string, FileStats>;

const FileStatsContext = createContext<FileStatsMap | null>(null);
export const useFileStats = () => useContext(FileStatsContext);

const normPath = (p: string) => p.replace(/\\/g, '/');

// CWD-agnostic tools don't bind to a local folder; their snapshots are no-ops.
// Mirrors the same set in Explorer.tsx.
const CWD_AGNOSTIC_TOOLS: ReadonlySet<ToolType> = new Set<ToolType>(['openclaw', 'hermes', 'remote']);

// Module-level: which sessionId currently has a backend snapshot, and for what
// (tool, folder) combo. App-process scoped — survives panel toggles.
const baselinedSessions = new Map<string, string>();

export function FileStatsProvider({ children }: { children: ReactNode }) {
  const { state } = useAppState();
  const activeSession = state.terminals.find(t => t.id === state.activeTerminalId);
  const diffCtx = resolveDiffContext(activeSession);
  const folderPath = diffCtx?.folderPath ?? null;
  const sessionId = diffCtx?.sessionId ?? null;
  const sessionTool = diffCtx?.tool ?? null;

  const [fileStats, setFileStats] = useState<FileStatsMap>(() => new Map());
  const snapshotReady = useRef<Promise<unknown> | null>(null);

  const refreshFileStats = useCallback(async (sid: string, folder: string) => {
    try {
      if (snapshotReady.current) await snapshotReady.current;
      const raw = await commands.computeFolderStats(sid, folder);
      const m = new Map<string, FileStats>();
      for (const [k, v] of Object.entries(raw)) m.set(normPath(k), v);
      setFileStats(m);
    } catch {
      setFileStats(new Map());
    }
  }, []);

  useEffect(() => {
    if (!folderPath || !sessionId) {
      setFileStats(new Map());
      snapshotReady.current = null;
      return;
    }
    if (sessionTool && CWD_AGNOSTIC_TOOLS.has(sessionTool)) {
      setFileStats(new Map());
      return;
    }
    const combo = `${sessionTool ?? ''}::${folderPath}`;
    const prior = baselinedSessions.get(sessionId);
    if (prior !== combo) {
      baselinedSessions.set(sessionId, combo);
      setFileStats(new Map());
      snapshotReady.current = commands.startFolderSnapshot(sessionId, folderPath).catch(() => {});
    } else {
      snapshotReady.current = null;
      void refreshFileStats(sessionId, folderPath);
    }
  }, [folderPath, sessionId, sessionTool, refreshFileStats]);

  // Drop snapshots for closed tabs.
  const liveSessionIds = useMemo(
    () => new Set(state.terminals.map(t => t.id)),
    [state.terminals],
  );
  useEffect(() => {
    const dead: string[] = [];
    for (const sid of baselinedSessions.keys()) {
      if (!liveSessionIds.has(sid)) dead.push(sid);
    }
    for (const sid of dead) {
      baselinedSessions.delete(sid);
      commands.dropSessionSnapshot(sid).catch(() => {});
    }
  }, [liveSessionIds]);

  // Refresh on fs-refresh events emitted by Explorer mutations / external
  // editors / the agent. Single 300ms debounce shared across the workspace.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!folderPath || !sessionId) return;
    if (sessionTool && CWD_AGNOSTIC_TOOLS.has(sessionTool)) return;
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const target = norm(folderPath);
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ dirPath: string }>;
      const dir = norm(ev.detail.dirPath);
      if (dir === target || dir.startsWith(target + '/')) {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(() => refreshFileStats(sessionId, folderPath), 300);
      }
    };
    window.addEventListener('fs-refresh', handler as EventListener);
    return () => {
      window.removeEventListener('fs-refresh', handler as EventListener);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [folderPath, sessionId, sessionTool, refreshFileStats]);

  return (
    <FileStatsContext.Provider value={fileStats}>
      {children}
    </FileStatsContext.Provider>
  );
}
