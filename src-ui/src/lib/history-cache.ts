// History cache — app-level singleton for session history list.
//
// Why this exists:
//   - get_native_history parses up to N jsonl/json files; doing it lazily on
//     HistoryBoard mount makes the tab feel frozen on first open.
//   - Instead, App.tsx prefetches on startup and the result is stored here,
//     so switching to the History tab is instantaneous from the user's POV.
//
// The store follows the useSyncExternalStore contract so React subscribers
// re-render automatically when status/sessions change.

import { commands, isTauri } from '../tauri';
import type { SavedSession } from '../tauri';

export type HistoryStatus = 'idle' | 'loading' | 'ready' | 'error';

interface HistoryState {
  sessions: SavedSession[];
  status: HistoryStatus;
}

let state: HistoryState = { sessions: [], status: 'idle' };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function sortByMtime(list: SavedSession[]): SavedSession[] {
  const copy = [...list];
  copy.sort((a, b) => {
    let ams = Date.parse(a.saved_at);
    if (isNaN(ams)) {
      const n = Number(a.saved_at);
      if (!isNaN(n)) ams = n < 1e11 ? n * 1000 : n;
    }
    let bms = Date.parse(b.saved_at);
    if (isNaN(bms)) {
      const n = Number(b.saved_at);
      if (!isNaN(n)) bms = n < 1e11 ? n * 1000 : n;
    }
    return (bms || 0) - (ams || 0);
  });
  return copy;
}

function doFetch(keepPreviousSessions: boolean) {
  state = {
    sessions: keepPreviousSessions ? state.sessions : [],
    status: 'loading',
  };
  emit();

  commands.getNativeHistory()
    .then(sessions => {
      state = { sessions: sortByMtime(sessions || []), status: 'ready' };
      emit();
    })
    .catch(err => {
      console.error('[history-cache] fetch failed:', err);
      state = { ...state, status: 'error' };
      emit();
    });
}

/** Kick off the background fetch. Idempotent — second call while loading or
 *  after ready is a no-op. Safe to call from App mount and from HistoryBoard. */
export function prefetchHistory(): void {
  if (!isTauri) return;
  if (state.status === 'loading' || state.status === 'ready') return;
  doFetch(false);
}

/** Force re-read from disk. Keeps the existing list visible during reload. */
export function refreshHistory(): void {
  if (!isTauri) return;
  doFetch(true);
}

export function subscribeHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getHistorySnapshot(): HistoryState {
  return state;
}
