import { onSharedStorage } from './storage-mirror';
// Hidden sessions - localStorage-backed "soft delete" marker table.
//
// Session data belongs to each CLI tool (Claude / Codex / OpenCode / MiMo …);
// Coffee only reads it for the 会话记录 list, so we never touch the real
// files. Instead we keep a local set of `${tool}:${id}` keys the user has
// hidden, and HistoryBoard filters them out. Reversible: drop the key and the
// session reappears (no recovery UI for now; the marker data stays).
//
// `${tool}:${id}` guards against a uuid colliding across two tools' id spaces.
//
// External-store shape mirrors history-cache.ts so HistoryBoard subscribes via
// useSyncExternalStore and re-renders the instant a hide lands.

const STORAGE_KEY = 'coffee:hidden-sessions';

let hidden: Set<string> = load();
const listeners = new Set<() => void>();

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((k): k is string => typeof k === 'string'));
  } catch {
    return new Set();
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...hidden]));
  } catch {
    // quota exceeded / localStorage disabled - hide stays in-memory for this session
  }
}

function emit(): void {
  for (const l of listeners) l();
}

// Hidden on the other side (desktop or a browser following it).
onSharedStorage(STORAGE_KEY, () => { hidden = load(); emit(); });

function key(tool: string, id: string): string {
  return `${tool}:${id}`;
}

export function hideSession(tool: string, id: string): void {
  const k = key(tool, id);
  if (hidden.has(k)) return;
  const next = new Set(hidden);
  next.add(k);
  hidden = next;
  persist();
  emit();
}

export function unhideSession(tool: string, id: string): void {
  const k = key(tool, id);
  if (!hidden.has(k)) return;
  const next = new Set(hidden);
  next.delete(k);
  hidden = next;
  persist();
  emit();
}

/** useSyncExternalStore subscribe. */
export function subscribeHidden(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** useSyncExternalStore getSnapshot. Returns a stable Set reference that only
 *  swaps when a hide/unhide lands (immutable update), so React doesn't loop. */
export function getHiddenSnapshot(): Set<string> {
  return hidden;
}
