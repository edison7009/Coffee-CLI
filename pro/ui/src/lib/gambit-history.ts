import { onSharedStorage } from './storage-mirror';
// Gambit prompt history — app-level singleton for ↑/↓ input recall.
//
// This is the Gambit composer's counterpart to a shell's `.bash_history`: a
// global, localStorage-persisted list of the prompts the user has sent, so
// pressing ↑ in the textarea refills the box with an earlier prompt and ↓
// walks back toward the present.
//
// Why a module-level singleton (not component state):
//   - It must survive tab switches. Each tab's Gambit unmounts when the user
//     switches tabs, so a useState/useRef inside the component would be lost
//     on every switch — the recalled history would reset. A module singleton
//     stays loaded for the app's lifetime, so history is genuinely shared
//     across every tab (matches the shell mental model: prompts are reusable
//     across projects, not scoped per-terminal).
//   - It mirrors the established lib/history-cache.ts pattern (subscribe +
//     getSnapshot + useSyncExternalStore), so React subscribers re-render
//     when a new prompt is pushed from any tab.
//
// What gets stored: the user's RAW trimmed draft - exactly what they typed.
//
// Dedupe: consecutive duplicates collapse (shells call this `ignoredups`) so
//     re-sending the same prompt three times doesn't clutter recall. A hard
//     cap (MAX_ENTRIES) trims the oldest entries to keep localStorage bounded.

const LS_KEY = 'cc-gambit-history';
const MAX_ENTRIES = 200;

let entries: string[] = load();
const listeners = new Set<() => void>();

function load(): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === 'string')
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded (rare — 200 prompts shouldn't approach the ~5MB cap).
    // Silently drop the persist; the in-memory list still works for the
    // session, we just stop persisting new entries until something frees up.
  }
}

function emit(): void {
  for (const l of listeners) l();
}

// Prompts sent on the other side (desktop or a browser following it).
onSharedStorage(LS_KEY, () => { entries = load(); emit(); });

export function subscribeGambitHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Snapshot for useSyncExternalStore. The returned array reference is stable
 *  between pushes (we reassign `entries` to a new array only on push), so the
 *  hook won't thrash re-renders on unrelated state changes. */
export function getGambitHistorySnapshot(): string[] {
  return entries;
}

/** Append a prompt to history. Empty / whitespace-only input is ignored
 *  Consecutive
 *  duplicates collapse. Trims to MAX_ENTRIES, evicting the oldest. */
export function pushGambitHistory(text: string): void {
  const t = text.trim();
  if (!t) return;
  if (entries[entries.length - 1] === t) return; // dedupe consecutive
  const next = entries.concat(t);
  if (next.length > MAX_ENTRIES) next.splice(0, next.length - MAX_ENTRIES);
  entries = next;
  persist();
  emit();
}
