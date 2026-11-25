// Shared scheduling for visible panes and hidden terminals. Timing write() alone
// does not bound xterm's deferred parsing. Keep one bounded write in flight per
// session, and rotate sessions between tasks to leave room for input and paint.
// Hidden terminals must still parse: onWriteParsed drives agent interactions.

import type { Terminal } from '@xterm/xterm';

// Counts are UTF-16 code units (String.length), not memory or UTF-8 bytes.
const MAX_BG_QUEUE = 2 * 1024 * 1024;
const WRITE_CHUNK_CHARS = 64 * 1024;
const BG_DRAIN_INTERVAL_MS = 16;
const MAX_WRITES_PER_DRAIN = 2;
const DRAIN_BUDGET_MS = 8;

// Retain the existing lossy background-display policy; never pause the PTY.
const DROP_WARNING =
  '\r\n\x1b[33m[Coffee CLI: 后台输出积压超过 2MB,已丢弃部分历史输出。切回此 tab 查看实时输出,完整对话见 session 文件]\x1b[0m\r\n';

interface SessionQueue {
  id: string;
  term: Terminal;
  chunks: string[];
  head: number;
  offset: number;
  queuedChars: number;
  inFlight: { chars: number } | null;
  dropped: boolean;
  isActive: boolean;
  failed: boolean;
  receivedSequence: number;
  enqueuedChars: number;
  parsedChars: number;
  parsedRevision: number;
  lastReceivedAt: number | null;
  lastParsedAt: number | null;
  waiters: Set<{ target: number; finish: (state: TerminalFlushState) => void }>;
}

export type TerminalFlushState = 'flushed' | 'timeout' | 'unavailable';

export interface TerminalOutputMetrics {
  pendingChars: number;
  inFlightChars: number;
  receivedSequence: number;
  parsedRevision: number;
  lastReceivedAt: number | null;
  lastParsedAt: number | null;
  gap: boolean;
  failed: boolean;
}

// Reinsert a served session at the end for round-robin within each priority.
const sessions = new Map<string, SessionQueue>();
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let drainAt = 0;
let nextBackgroundAt = performance.now() + BG_DRAIN_INTERVAL_MS;

export function registerSession(id: string, term: Terminal): void {
  const previous = sessions.get(id);
  if (previous) finishWaiters(previous, 'unavailable');
  sessions.set(id, {
    id, term, chunks: [], head: 0, offset: 0, queuedChars: 0,
    inFlight: null, dropped: false, isActive: true, failed: false,
    receivedSequence: 0, enqueuedChars: 0, parsedChars: 0, parsedRevision: 0,
    lastReceivedAt: null, lastParsedAt: null, waiters: new Set(),
  });
  scheduleDrain();
}

export function unregisterSession(id: string): void {
  const q = sessions.get(id);
  if (q) finishWaiters(q, 'unavailable');
  sessions.delete(id);
  scheduleDrain();
}

export function enqueue(id: string, data: string): void {
  const q = sessions.get(id);
  if (!q || q.failed || data.length === 0) return;
  q.receivedSequence += 1;
  q.lastReceivedAt = Date.now();
  if (!q.isActive && q.queuedChars + (q.inFlight?.chars ?? 0) + data.length > MAX_BG_QUEUE) {
    if (!q.dropped) {
      q.dropped = true;
      q.chunks.push(DROP_WARNING);
      q.queuedChars += DROP_WARNING.length;
      q.enqueuedChars += DROP_WARNING.length;
    }
    scheduleDrain();
    return;
  }
  const idle = q.queuedChars === 0 && q.inFlight === null;
  q.chunks.push(data);
  q.queuedChars += data.length;
  q.enqueuedChars += data.length;
  // Preserve immediate echo on an idle visible terminal, including split panes.
  // Remaining slices yield even when xterm invokes the callback synchronously.
  if (q.isActive && idle) writeNext(q);
  scheduleDrain();
}

export function setActive(id: string, active: boolean): void {
  const q = sessions.get(id);
  if (!q) return;
  q.isActive = active;
  // Activation changes priority, not FIFO or the in-flight allowance.
  scheduleDrain();
}

export function getSessionMetrics(id: string, term: Terminal): TerminalOutputMetrics | null {
  const q = sessions.get(id);
  if (!q || q.term !== term) return null;
  return {
    pendingChars: q.queuedChars + (q.inFlight?.chars ?? 0),
    inFlightChars: q.inFlight?.chars ?? 0,
    receivedSequence: q.receivedSequence,
    parsedRevision: q.parsedRevision,
    lastReceivedAt: q.lastReceivedAt,
    lastParsedAt: q.lastParsedAt,
    gap: q.dropped,
    failed: q.failed,
  };
}

/** Wait only for output accepted before this call, not a continuously growing queue. */
export function flushSession(id: string, term: Terminal, timeoutMs = 250): Promise<TerminalFlushState> {
  const q = sessions.get(id);
  if (!q || q.term !== term || q.failed) return Promise.resolve('unavailable');
  const target = q.enqueuedChars;
  if (q.parsedChars >= target) return Promise.resolve('flushed');
  return new Promise(resolve => {
    const waiter = {
      target,
      finish: (state: TerminalFlushState) => {
        clearTimeout(timer);
        q.waiters.delete(waiter);
        resolve(state);
      },
    };
    const timer = setTimeout(() => waiter.finish('timeout'), timeoutMs);
    q.waiters.add(waiter);
  });
}

function finishWaiters(q: SessionQueue, state?: TerminalFlushState): void {
  for (const waiter of q.waiters) {
    if (state || q.parsedChars >= waiter.target) waiter.finish(state ?? 'flushed');
  }
}

function nextReady(active: boolean): SessionQueue | undefined {
  for (const q of sessions.values()) {
    if (q.isActive === active && !q.failed && !q.inFlight && q.queuedChars > 0) return q;
  }
}

function scheduleDrain(): void {
  const visible = nextReady(true);
  const background = nextReady(false);
  if (!visible && !background) {
    if (drainTimer !== null) clearTimeout(drainTimer);
    drainTimer = null;
    return;
  }
  const now = performance.now();
  const at = visible ? now : Math.max(now, nextBackgroundAt);
  if (drainTimer !== null) {
    if (drainAt <= at) return;
    clearTimeout(drainTimer); // Visible output must not wait for a background tick.
  }
  drainAt = at;
  drainTimer = setTimeout(drain, Math.max(0, at - now));
}

function drain(): void {
  drainTimer = null;
  const started = performance.now();
  const backgroundDue = started >= nextBackgroundAt;
  let wroteBackground = false;
  for (let writes = 0; writes < MAX_WRITES_PER_DRAIN; writes++) {
    const visible = nextReady(true);
    const background = backgroundDue ? nextReady(false) : undefined;
    // Serve due background work first: a synchronous visible parse may consume
    // the whole submission budget and otherwise starve every hidden terminal.
    const q = writes === 0 ? background ?? visible : visible ?? background;
    if (!q) break;
    wroteBackground ||= !q.isActive;
    writeNext(q);
    // Submission time only: the chunk/in-flight limits bound deferred work.
    // This is not a promise about total parse or render CPU time.
    if (performance.now() - started >= DRAIN_BUDGET_MS) break;
  }
  if (wroteBackground) nextBackgroundAt = performance.now() + BG_DRAIN_INTERVAL_MS;
  scheduleDrain();
}

function takeChunk(q: SessionQueue): string {
  const parts: string[] = [];
  let remaining = WRITE_CHUNK_CHARS;
  while (remaining > 0 && q.head < q.chunks.length) {
    const chunk = q.chunks[q.head];
    let end = Math.min(chunk.length, q.offset + remaining);
    // Avoid introducing a split inside a surrogate pair. xterm already handles
    // original PTY chunk boundaries and split ANSI sequences as a stream.
    if (end < chunk.length && end > q.offset) {
      const last = chunk.charCodeAt(end - 1);
      const next = chunk.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    }
    if (end === q.offset) break;
    parts.push(chunk.slice(q.offset, end));
    const consumed = end - q.offset;
    q.queuedChars -= consumed;
    remaining -= consumed;
    q.offset = end;
    if (end === chunk.length) {
      q.chunks[q.head++] = ''; // Release strings without repeated O(n) shifts.
      q.offset = 0;
    }
  }
  if (q.head === q.chunks.length) {
    q.chunks = [];
    q.head = 0;
  } else if (q.head > 128 && q.head > q.chunks.length / 2) {
    q.chunks = q.chunks.slice(q.head);
    q.head = 0;
  }
  return parts.join('');
}

function writeNext(q: SessionQueue): void {
  const data = takeChunk(q);
  const pending = { chars: data.length };
  q.inFlight = pending;
  sessions.delete(q.id);
  sessions.set(q.id, q);
  try {
    q.term.write(data, () => {
      // Disposed terminals may acknowledge late or never. Object identity also
      // isolates a replacement with the same id and duplicate callbacks.
      if (sessions.get(q.id) !== q || q.inFlight !== pending) return;
      q.inFlight = null;
      q.parsedChars += pending.chars;
      q.parsedRevision += 1;
      q.lastParsedAt = Date.now();
      finishWaiters(q);
      scheduleDrain(); // Never recurse into xterm from its own parse callback.
    });
  } catch {
    // A rejected write cannot be replayed safely. Isolate it until remount.
    q.failed = true;
    q.dropped = true;
    q.inFlight = null;
    q.chunks = [];
    q.head = q.offset = q.queuedChars = 0;
    finishWaiters(q, 'unavailable');
  }
}
