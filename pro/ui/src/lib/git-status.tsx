// git-status.tsx — Per-tab git working-tree changes provider.
//
// `git_changes` spawns several git subprocesses per call (~400ms on Windows),
// so polling it constantly — on every fs-refresh while an agent edits files,
// regardless of whether the panel was even on screen — was the v2.8.7 perf
// regression (UI lag during heavy agent activity). This provider now:
//   • polls ONLY while the changes panel is visible (ChangesBoard registers
//     via useGitPollingGate; hidden tabs deactivate their subscription),
//   • debounces bursts at 800ms,
//   • skips the re-render when a poll returns identical data,
//   • derives a dirty-dirs Set so the Explorer tree's "has a changed
//     descendant?" test is O(1) instead of scanning the whole change list.
//
// Consumers: useGitStatus() (ChangesBoard) · useFileStats() (Explorer badges)
// · useDirtyDirs() (Explorer folder tinting).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAppState, resolveDiffContext } from '../store/app-state';
import type { ToolType } from '../store/app-state';
import { commands, type GitChanges as NativeGitChanges, type GitFileEntry } from '../tauri';

type GitChanges = NativeGitChanges | { state: 'error' };

export type FileStats = { added: number; deleted: number; mtimeMs: number };
type FileStatsMap = Map<string, FileStats>;

const GitStatusContext = createContext<GitChanges | null>(null);
const FileStatsContext = createContext<FileStatsMap | null>(null);
const DirtyDirsContext = createContext<Set<string>>(new Set());
const PollGateContext = createContext<(active: boolean) => void>(() => {});

/** Active tab's git working-tree status (no_git / not_repo / ok). */
export const useGitStatus = () => useContext(GitStatusContext);
/** Flat path→{added,deleted} map for the Explorer tree badges (git-derived). */
export const useFileStats = () => useContext(FileStatsContext);
/** Set of dirs (abs, normalized) containing a changed file — O(1) "has a dirty
 *  descendant?" lookup for the Explorer tree, instead of scanning every change
 *  per folder node. */
export const useDirtyDirs = () => useContext(DirtyDirsContext);
/** Called by ChangesBoard while it is mounted (i.e. its tab is visible) so the
 *  expensive git poll only runs when the user is actually looking at it. */
export function useGitPollingGate(active = true) {
  const gate = useContext(PollGateContext);
  useEffect(() => {
    if (!active) return;
    gate(true);
    return () => gate(false);
  }, [gate, active]);
}

const CWD_AGNOSTIC_TOOLS: ReadonlySet<ToolType> = new Set<ToolType>([
  'openclaw', 'hermes', 'remote',
]);

// 800ms (was 300): coalesces an agent's file-edit burst into one git query.
const REFRESH_DEBOUNCE_MS = 800;

function deriveFileStatsMap(changes: GitChanges | null): FileStatsMap {
  const m: FileStatsMap = new Map();
  if (!changes || changes.state !== 'ok') return m;
  const add = (e: GitFileEntry) => {
    const prev = m.get(e.path);
    if (prev) m.set(e.path, { added: prev.added + e.added, deleted: prev.deleted + e.deleted, mtimeMs: 0 });
    else m.set(e.path, { added: e.added, deleted: e.deleted, mtimeMs: 0 });
  };
  changes.uncommitted.forEach(add);
  changes.untracked.forEach(add);
  return m;
}

// Every ancestor directory of every changed file. Lets a folder node test
// `dirtyDirs.has(dir)` in O(1) rather than scanning all change keys per node
// (the old O(open-folders × changes) main-thread cost on each poll).
function deriveDirtyDirs(map: FileStatsMap): Set<string> {
  const dirs = new Set<string>();
  for (const path of map.keys()) {
    let slash = path.lastIndexOf('/');
    while (slash > 0) {
      const dir = path.slice(0, slash);
      if (dirs.has(dir)) break; // this dir + its ancestors are already in
      dirs.add(dir);
      slash = dir.lastIndexOf('/');
    }
  }
  return dirs;
}

// Cheap signature to skip a re-render when a poll returns identical data
// (e.g. a refresh event fired but nothing on disk actually changed).
function changesSignature(c: GitChanges | null): string {
  if (!c || c.state !== 'ok') return c?.state ?? 'null';
  const f = (e: GitFileEntry) => `${e.rel}\x01${e.status}\x01${e.added}\x01${e.deleted}`;
  const g = (m: { hash: string }) => m.hash;
  return [c.branch, c.uncommitted.map(f).join(','), c.untracked.map(f).join(','), c.session_commits.map(g).join(',')].join('\x02');
}

export function GitStatusProvider({ children }: { children: ReactNode }) {
  const { state } = useAppState();
  const activeSession = state.terminals.find(t => t.id === state.activeTerminalId);
  const diffCtx = resolveDiffContext(activeSession);
  const activeFolderPath = diffCtx?.folderPath ?? null;
  const activeSessionId = diffCtx?.sessionId ?? null;
  const activeTool = diffCtx?.tool ?? null;
  const cwdAgnostic = !!(activeTool && CWD_AGNOSTIC_TOOLS.has(activeTool));

  const [tabChanges, setTabChanges] = useState<Map<string, GitChanges>>(new Map());

  // Poll gate — ChangesBoard (mounted only while its tab is on screen) bumps
  // this; a counter so React StrictMode's double-mount nets out correctly.
  const [pollSubscribers, setPollSubscribers] = useState(0);
  const setPollGate = useCallback((active: boolean) => {
    setPollSubscribers(n => Math.max(0, n + (active ? 1 : -1)));
  }, []);
  const pollEnabled = pollSubscribers > 0;

  // Capture the session baseline (current HEAD) for the active folder —
  // cheap (one rev-parse), NOT poll-gated, so it runs at app launch + on tab
  // switch regardless of whether the 修改记录 tab is open. Scopes the
  // session-commits list to commits made this window (reset on app close).
  useEffect(() => {
    if (!activeFolderPath) return;
    commands.gitCaptureBaseline(activeFolderPath).catch(() => {});
  }, [activeFolderPath]);

  const debounceRef = useRef<number | null>(null);
  const lastSigRef = useRef<string>('');
  useEffect(() => {
    if (!activeSessionId) lastSigRef.current = '';
    if (!pollEnabled || !activeFolderPath || !activeSessionId || !activeTool || cwdAgnostic) return;
    const folder = activeFolderPath;
    const sid = activeSessionId;

    // NEVER run two git_changes at once. On a large repo (tens of thousands
    // of files) `git status` takes seconds; without this guard a burst of
    // fs-refresh during agent activity starts a fresh multi-second query every
    // debounce tick, so several run concurrently on the Tauri thread pool and
    // peg the backend (the "panel-open keeps lagging" report, issue #40).
    // While one is in flight, later triggers set `pending`; a single follow-up
    // fires when it returns (coalesce).
    let inFlight = false;
    let pending = false;
    const fetchChanges = () => {
      if (inFlight) { pending = true; return; }
      inFlight = true;
      commands.gitChanges(folder).then(changes => {
        if (cancelled) return;
        const sig = sid + '\x00' + changesSignature(changes);
        if (sig === lastSigRef.current) return; // unchanged → skip the re-render
        lastSigRef.current = sig;
        setTabChanges(prev => {
          const next = new Map(prev);
          next.set(sid, changes);
          return next;
        });
      }).catch(() => {
        if (!cancelled) setTabChanges(previous => new Map(previous).set(sid, { state: 'error' }));
        lastSigRef.current = '';
      }).finally(() => {
        inFlight = false;
        if (pending && !cancelled) { pending = false; schedule(); }
      });
    };
    const schedule = () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(fetchChanges, REFRESH_DEBOUNCE_MS);
    };

    fetchChanges(); // immediate fetch when the panel opens (no debounce lag)

    // Periodic poll — a `git commit` modifies `.git/` (refs/heads, index),
    // which the fs-watcher classifies as Meaningful + should emit fs-refresh
    // for, but in practice the panel wasn't reliably swapping 未提交 → 已提交
    // after a commit while it stayed open (user had to re-open the tab to see
    // the new commit). This 8s backstop catches any git-state change (commit,
    // branch switch, reset) regardless of whether the fs-watcher chain
    // delivered the event. Only runs while the panel is visible (poll gate).
    const pollInterval = window.setInterval(schedule, 8_000);

    let unlistenTauri: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const fn = await listen('fs-refresh', schedule);
      if (cancelled) fn();
      else unlistenTauri = fn;
    })().catch(() => {});

    const onWindowRefresh = () => schedule();
    window.addEventListener('fs-refresh', onWindowRefresh);
    return () => {
      cancelled = true;
      window.clearInterval(pollInterval);
      window.removeEventListener('fs-refresh', onWindowRefresh);
      unlistenTauri?.();
      if (debounceRef.current != null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [pollEnabled, activeFolderPath, activeSessionId, activeTool, cwdAgnostic]);

  // Drop entries for sessions no longer alive so the Map can't grow unbounded.
  useEffect(() => {
    const live = new Set(
      state.terminals
        .map(t => resolveDiffContext(t)?.sessionId)
        .filter((s): s is string => !!s),
    );
    setTabChanges(prev => {
      let changed = false;
      const next = new Map(prev);
      for (const sid of Array.from(next.keys())) {
        if (!live.has(sid)) { next.delete(sid); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [state.terminals]);

  const activeChanges: GitChanges | null = activeSessionId
    ? tabChanges.get(activeSessionId) ?? null
    : null;
  const fileStats = useMemo(() => deriveFileStatsMap(activeChanges), [activeChanges]);
  const dirtyDirs = useMemo(() => deriveDirtyDirs(fileStats), [fileStats]);

  return (
    <PollGateContext.Provider value={setPollGate}>
      <GitStatusContext.Provider value={activeChanges}>
        <FileStatsContext.Provider value={fileStats}>
          <DirtyDirsContext.Provider value={dirtyDirs}>
            {children}
          </DirtyDirsContext.Provider>
        </FileStatsContext.Provider>
      </GitStatusContext.Provider>
    </PollGateContext.Provider>
  );
}
