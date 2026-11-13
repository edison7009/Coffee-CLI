import { onSharedStorage } from './storage-mirror';
// Pinned sessions - localStorage-backed "置顶" marker table.
//
// Mirror of hidden-sessions.ts: Coffee only reads each CLI tool's session
// data for the 会话记录 list, so "pinning" is a local per-device marker,
// not a write to the tool's own store. We keep a set of `${tool}:${id}`
// keys the user has pinned; HistoryBoard sorts pinned sessions to the top
// and shows a pushpin marker on their cards. Pin/unpin happens via the
// session card's right-click context menu.
//
// `${tool}:${id}` guards against a uuid colliding across two tools' id
// spaces (same key scheme as hidden-sessions).
//
// External-store shape mirrors hidden-sessions.ts so HistoryBoard
// subscribes via useSyncExternalStore and re-renders the instant a pin
// lands.

const STORAGE_KEY = 'coffee:pinned-sessions';

let pinned: Set<string> = load();
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...pinned]));
  } catch {
    // quota exceeded / localStorage disabled - pin stays in-memory for this session
  }
}

function emit(): void {
  for (const l of listeners) l();
}

// Pinned on the other side (desktop or a browser following it).
onSharedStorage(STORAGE_KEY, () => { pinned = load(); emit(); });

function key(tool: string, id: string): string {
  return `${tool}:${id}`;
}

export function pinSession(tool: string, id: string): void {
  const k = key(tool, id);
  if (pinned.has(k)) return;
  const next = new Set(pinned);
  next.add(k);
  pinned = next;
  persist();
  emit();
}

export function unpinSession(tool: string, id: string): void {
  const k = key(tool, id);
  if (!pinned.has(k)) return;
  const next = new Set(pinned);
  next.delete(k);
  pinned = next;
  persist();
  emit();
}

export function togglePin(tool: string, id: string): void {
  const k = key(tool, id);
  if (pinned.has(k)) unpinSession(tool, id);
  else pinSession(tool, id);
}

export function isPinned(tool: string, id: string): boolean {
  return pinned.has(key(tool, id));
}

/** useSyncExternalStore subscribe. */
export function subscribePinned(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** useSyncExternalStore getSnapshot. Returns a stable Set reference that only
 *  swaps when a pin/unpin lands (immutable update), so React doesn't loop. */
export function getPinnedSnapshot(): Set<string> {
  return pinned;
}
