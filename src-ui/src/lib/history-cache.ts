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
//
// Refresh strategy (issue: "会话记录列表始终是第一次打开软件时的,要重启才能看到新的"):
//   `prefetchHistory` is idempotent (no-ops after the first load) — it does NOT
//   re-fetch. `refreshHistory` is the non-idempotent counterpart: debounced +
//   throttled + inFlight-guarded, it silently swaps in fresh data without
//   flipping to the loading skeleton (no flicker). Triggers wired up across
//   the app:
//     • Explorer — clicking the 会话记录 tab (re-entering the History view).
//     • App.tsx `initHistoryAutoRefresh` — window-foreground (alt-tab back) +
//       a 60s background poll while foregrounded.
//   `refreshHistory` no-ops until the initial prefetch has run (status ===
//   'idle'), so users who never open the History tab pay zero polling cost.

import { commands, isTauri } from '../tauri';
import type { SavedSession } from '../tauri';
import { onWindowForeground, onWindowBackground } from './window-focus-filter';

type HistoryStatus = 'idle' | 'loading' | 'ready' | 'error';

interface HistoryState {
  sessions: SavedSession[];
  status: HistoryStatus;
}

let state: HistoryState = { sessions: [], status: 'idle' };
const listeners = new Set<() => void>();

/** Structural fingerprint of a history list. The backend caches each file's
 *  parse result by (mtime, size), so a poll where nothing on disk moved comes
 *  back identical — but doFetch still built a fresh array and emitted, which
 *  re-rendered every HistoryBoard subscriber once a minute for nothing. An
 *  unchanged poll now ends without touching the store. */
function sessionsSignature(list: SavedSession[]): string {
  return JSON.stringify(list.map(s => [
    s.id, s.name, s.tool, s.cwd, s.session_token, s.saved_at,
    s.created_at, s.file_path, s.turn_count,
  ]));
}
let lastSig = '';

// Refresh plumbing — see refreshHistory / doFetch.
let inFlight = false;
let lastFetchAt = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
/** A refresh that arrives while one is in flight, or inside the throttle
 *  window, is remembered here and replayed rather than dropped. Both guards
 *  used to `return` outright, which silently discarded the trigger: on a scan
 *  that took seconds, the 60s poll, the alt-tab-back refresh and the
 *  History-tab click all landed inside the same in-flight window, so a session
 *  created during it never appeared until some later trigger happened to land
 *  outside it — the "会话记录经常不刷新" report. Mirrors the `pending`
 *  coalescing git-status.tsx already uses for the same failure mode. */
let pendingRefresh = false;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
/** Skip a refresh within this window of the last fetch — multiple triggers
 *  (tab click + foreground + poll) routinely fire within a second of each
 *  other and one fetch is enough. */
const REFRESH_THROTTLE_MS = 2000;
/** Coalesce rapid triggers into a single fetch. */
const REFRESH_DEBOUNCE_MS = 400;
/** Background poll interval while the window is foregrounded. */
const POLL_INTERVAL_MS = 60_000;

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

/// Arm the single replay timer for a throttle-blocked refresh. Idempotent —
/// the first blocked trigger sets the deadline and later ones join it, so a
/// burst produces one replay instead of one per trigger.
function armPendingReplay(delayMs: number) {
  if (pendingTimer !== null) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (!pendingRefresh) return;
    pendingRefresh = false;
    doFetch(true);
  }, delayMs);
}

/// Perform a fetch. `isRefresh = false` is the initial prefetch (show loading +
/// clear the list so the skeleton reads as "loading"). `isRefresh = true`
/// keeps the previous sessions + `ready` status visible and swaps silently
/// when the fetch lands — no flicker. Guarded by `inFlight` (no concurrent
/// fetches) and a throttle (no re-fetch within REFRESH_THROTTLE_MS of the
/// last one); a refresh turned away by either guard is queued in
/// `pendingRefresh` and replayed, never dropped. Refresh is a no-op until the
/// first prefetch has run.
function doFetch(isRefresh: boolean) {
  if (isRefresh && state.status === 'idle') return; // never opened History
  if (inFlight) {
    if (isRefresh) pendingRefresh = true;
    return;
  }
  if (isRefresh) {
    const wait = REFRESH_THROTTLE_MS - (Date.now() - lastFetchAt);
    if (wait > 0) {
      // Still inside the throttle window — defer to when it opens instead of
      // discarding the trigger.
      pendingRefresh = true;
      armPendingReplay(wait);
      return;
    }
  }
  pendingRefresh = false;
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  inFlight = true;
  lastFetchAt = Date.now();
  if (!isRefresh) {
    state = { sessions: [], status: 'loading' };
    emit();
  }
  // A queued refresh must reach the per-file scan even within the backend's
  // five-second result TTL, otherwise it simply republishes the old list.
  commands.getNativeHistory(isRefresh)
    .then(sessions => {
      const sorted = sortByMtime(sessions || []);
      const sig = sessionsSignature(sorted);
      // Identical to what is already published → no store write, no re-render.
      // The initial prefetch always publishes (its status is still 'loading',
      // and an empty first result is a legitimate empty list to show).
      if (sig === lastSig && state.status === 'ready') return;
      lastSig = sig;
      state = { sessions: sorted, status: 'ready' };
      emit();
    })
    .catch(err => {
      console.error('[history-cache] fetch failed:', err);
      if (!isRefresh) {
        // Initial load failed — surface the error (skeleton → error state).
        state = { ...state, status: 'error' };
        emit();
      }
      // Refresh failed — keep the previous data visible (silent).
    })
    .finally(() => {
      inFlight = false;
      // Replay a refresh that was turned away while this one was running.
      // Calling doFetch directly is safe: if the throttle is still warm it
      // re-queues and arms the replay timer rather than looping.
      if (pendingRefresh) {
        pendingRefresh = false;
        doFetch(true);
      }
    });
}

/** Kick off the background fetch. Idempotent — second call while loading or
 *  after ready is a no-op. Safe to call from App mount and from HistoryBoard. */
export function prefetchHistory(): void {
  if (!isTauri) return;
  if (state.status === 'loading' || state.status === 'ready') return;
  doFetch(false);
}

/** Force a re-fetch of the history list (non-idempotent). Debounced so a
 *  burst of triggers (tab click + foreground + poll landing together)
 *  collapses into one fetch; throttled so we don't re-fetch more often than
 *  every REFRESH_THROTTLE_MS. No-op until the initial prefetch has run, so
 *  users who never open the History tab aren't polled. Safe to call from
 *  Explorer's tab onClick and from the window-foreground / poll listeners. */
export function refreshHistory(): void {
  if (!isTauri) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    doFetch(true);
  }, REFRESH_DEBOUNCE_MS);
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

/// Wire up the background auto-refresh triggers. Call once from a
/// always-mounted component (App.tsx). Returns a cleanup that tears down
/// the listeners + interval. refreshHistory no-ops until the initial
/// prefetch has run, so this is safe to install unconditionally — users who
/// never open the History tab pay only the 60s setInterval tick (a function
/// call that early-returns).
export function initHistoryAutoRefresh(): () => void {
  if (!isTauri) return () => {};
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const startPoll = () => {
    if (pollTimer) return;
    pollTimer = setInterval(() => refreshHistory(), POLL_INTERVAL_MS);
  };
  const stopPoll = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };
  startPoll();
  // Alt-tab back: refresh immediately (user may have run sessions in another
  // window / external terminal while we were hidden) AND resume the poll.
  const unsubFg = onWindowForeground(() => {
    refreshHistory();
    startPoll();
  });
  // Window hidden: pause the poll (no point scanning for a window nobody is
  // looking at). onWindowBackground fires after the SETTLE_MS gate, so the
  // spurious start_dragging blur+focus pair on Windows doesn't flap it.
  const unsubBg = onWindowBackground(stopPoll);
  return () => {
    unsubFg();
    unsubBg();
    stopPoll();
  };
}
