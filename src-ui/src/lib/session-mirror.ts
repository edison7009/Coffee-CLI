// Conversations seen from a browser: the desktop holds every session, the browser only shows
// it and asks the desktop to act.
//
// Desktop: each session store registers a source. While a browser is connected, every change
// is sent as a numbered patch (only the top-level fields that changed; for arrays, only the
// items that changed). A browser that misses a number asks for the whole state again.
//
// Browser: a session store follows one source instead of starting a process, and its actions
// (send, interrupt, answer a request…) run on the desktop through `mirrorCall`.

import { invoke } from '../tauri';
import { onRemoteStatus, remoteRequest } from '../remote/bridge';

/** Conversations by tool, plus `app` for the desktop's settings. */
export type MirrorKind = 'claude' | 'codex' | 'opencode' | 'pi' | 'dsh' | 'app';
type State = Record<string, unknown>;
interface ArrayPatch { len: number; items: Record<number, unknown> }
export interface MirrorPatch { v: number; set?: State; unset?: string[]; arrays?: Record<string, ArrayPatch> }

/** The fields of `next` that differ from `prev`; arrays send only the items that changed. */
export function diffState(prev: State, next: State): Omit<MirrorPatch, 'v'> | null {
  const set: State = {}, arrays: Record<string, ArrayPatch> = {}, unset: string[] = [];
  for (const key of Object.keys(next)) {
    const a = prev[key], b = next[key];
    if (a === b) continue;
    if (Array.isArray(a) && Array.isArray(b)) {
      const items: Record<number, unknown> = {};
      let changed = 0;
      for (let i = 0; i < b.length; i++) if (b[i] !== a[i]) { items[i] = b[i]; changed++; }
      // Worth it whenever some items are unchanged: a streaming reply changes only the last message.
      if (changed < b.length) { arrays[key] = { len: b.length, items }; continue; }
    }
    set[key] = b;
  }
  for (const key of Object.keys(prev)) if (!(key in next)) unset.push(key);
  if (!Object.keys(set).length && !Object.keys(arrays).length && !unset.length) return null;
  return { ...(Object.keys(set).length ? { set } : {}), ...(Object.keys(arrays).length ? { arrays } : {}), ...(unset.length ? { unset } : {}) };
}

export function applyPatch(prev: State, patch: MirrorPatch): State {
  const next: State = { ...prev, ...patch.set };
  for (const key of patch.unset ?? []) delete next[key];
  for (const [key, { len, items }] of Object.entries(patch.arrays ?? {})) {
    const list = (Array.isArray(prev[key]) ? (prev[key] as unknown[]) : []).slice(0, len);
    for (const [index, item] of Object.entries(items)) list[Number(index)] = item;
    next[key] = list;
  }
  return next;
}

// ─── Desktop: sources ────────────────────────────────────────────────────────

interface Source { read: () => unknown; sent: State | null; v: number; timer?: ReturnType<typeof setTimeout> }
const sources = new Map<string, Source>();
const actions = new Map<MirrorKind, Record<string, (...args: never[]) => unknown>>();
let active = false;

const key = (kind: MirrorKind, id: string) => `${kind}\u0000${id}`;

function push(kind: MirrorKind, id: string, source: Source) {
  clearTimeout(source.timer); source.timer = undefined;
  if (!active) return;
  const next = source.read() as State;
  const patch = source.sent ? diffState(source.sent, next) : { set: next };
  if (!patch) return;
  source.sent = next; source.v++;
  void invoke('mobile_rpc_mirror', { kind, id, patch: { v: source.v, ...patch } }).catch(() => {});
}

/** Desktop session stores call this once per session; the returned function goes in its listeners. */
export function mirrorSource(kind: MirrorKind, id: string, read: () => unknown): () => void {
  const source: Source = { read, sent: null, v: 0 };
  sources.set(key(kind, id), source);
  // Stores publish in bursts while a reply streams; one patch per frame is plenty.
  return () => { if (active && !source.timer) source.timer = setTimeout(() => push(kind, id, source), 30); };
}

/** The desktop's actions a browser may ask for, by name. */
export function registerMirrorActions(kind: MirrorKind, fns: Record<string, (...args: never[]) => unknown>) { actions.set(kind, { ...actions.get(kind), ...fns }); }

/** Whether a browser is connected; patches are only worked out while one is. */
export function setMirrorActive(next: boolean) {
  if (next === active) return;
  active = next;
  // A browser that connects starts from a snapshot, so earlier patches do not matter.
  for (const source of sources.values()) { clearTimeout(source.timer); source.timer = undefined; source.sent = null; }
}

/** A browser starting to follow a session: everything sent so far, and the number it ends at. */
export function mirrorSnapshot(kind: MirrorKind, id: string): { v: number; state: unknown } {
  const source = sources.get(key(kind, id));
  if (!source) return { v: 0, state: null };
  if (!active) setMirrorActive(true);
  push(kind, id, source);
  if (!source.sent) { source.sent = source.read() as State; source.v++; }
  return { v: source.v, state: source.sent };
}

export async function runMirrorAction(kind: MirrorKind, name: string, args: unknown[]): Promise<unknown> {
  const fn = actions.get(kind)?.[name];
  if (!fn) throw new Error(`Unsupported ${kind} action`);
  return await (fn as (...args: unknown[]) => unknown)(...args);
}

// ─── Browser: targets ────────────────────────────────────────────────────────

type Patch = { kind: MirrorKind; id: string } & MirrorPatch;
const targets = new Map<string, (patch: Patch) => void>();
let listening: Promise<unknown> | undefined;

function listenPatches() {
  return listening ??= import('@tauri-apps/api/event').then(({ listen }) => listen<Patch>('session-mirror', ({ payload }) => {
    targets.get(key(payload.kind, payload.id))?.(payload);
  }));
}

/** Follows one desktop session; `apply` receives each new state. Returns the stop function. */
export function mirrorTarget(kind: MirrorKind, id: string, apply: (state: unknown) => void): () => void {
  let stopped = false, state: State | null = null, v = 0, loading = false, queued: Patch[] = [];
  const reload = async () => {
    if (loading || stopped) return;
    loading = true; state = null;
    try {
      const snap = await remoteRequest<{ v: number; state: State | null }>('mirror.snapshot', { kind, id });
      if (stopped) return;
      state = snap.state ?? {}; v = snap.v;
      const backlog = queued; queued = [];
      if (snap.state) apply(state);
      for (const patch of backlog) take(patch);
    } catch { /* The connection is down; the next patch or reconnect asks again. */ }
    finally { loading = false; }
  };
  const take = (patch: Patch) => {
    if (stopped) return;
    if (!state) { queued.push(patch); return; }
    if (patch.v <= v) return;
    if (patch.v > v + 1) { queued.push(patch); void reload(); return; }
    state = applyPatch(state, patch); v = patch.v;
    apply(state);
  };
  targets.set(key(kind, id), take);
  void listenPatches().then(reload);
  // Back from a dropped connection: whatever changed meanwhile is only in a new snapshot.
  const stopStatus = onRemoteStatus(status => { if (status === 'connected') void reload(); });
  return () => { stopped = true; stopStatus(); if (targets.get(key(kind, id)) === take) targets.delete(key(kind, id)); };
}

/** Runs one of the desktop's session actions for this browser. */
export function mirrorCall<T>(kind: MirrorKind, name: string, args: unknown[]): Promise<T> {
  return remoteRequest<T>('ui.call', { kind, name, args });
}
