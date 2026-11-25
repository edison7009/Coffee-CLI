import type { IBuffer, Terminal } from '@xterm/xterm';
import {
  flushSession,
  getSessionMetrics,
  type TerminalFlushState,
  type TerminalOutputMetrics,
} from './terminal-output-scheduler';

export interface TerminalObservedLine {
  row: number;
  bufferRow: number;
  text: string;
  isWrapped: boolean;
}

export interface TerminalFreshness extends TerminalOutputMetrics {
  schedulerAvailable: boolean;
  flushState: TerminalFlushState;
}

export interface TerminalScreenSnapshot {
  sessionId: string;
  generation: string;
  screenRevision: number;
  capturedAt: number;
  view: 'live' | 'viewport';
  bufferType: 'normal' | 'alternate';
  cols: number;
  rows: number;
  baseY: number;
  viewportY: number;
  startRow: number;
  cursor: { x: number; y: number; bufferRow: number };
  lines: TerminalObservedLine[];
  freshness: TerminalFreshness;
}

export interface TerminalScrollbackSnapshot {
  sessionId: string;
  generation: string;
  screenRevision: number;
  capturedAt: number;
  bufferType: 'normal';
  activeBufferType: 'normal' | 'alternate';
  cols: number;
  startRow: number;
  endRow: number;
  availableRows: number;
  hasMore: boolean;
  lines: TerminalObservedLine[];
  freshness: TerminalFreshness;
}

export interface TerminalObserver {
  sessionId: string;
  generation: string;
  readScreen: (view?: 'live' | 'viewport') => Promise<TerminalScreenSnapshot>;
  /** Normal-buffer history only; defaults to the latest 200 retained rows. */
  readScrollback: (startRow?: number, limit?: number) => Promise<TerminalScrollbackSnapshot>;
}

interface ObserverEntry {
  api: TerminalObserver;
  term: Terminal;
  revision: number;
  lastParsedAt: number | null;
  dispose: () => void;
}

const observers = new Map<string, ObserverEntry>();
const generationPrefix = crypto.randomUUID();
let nextGeneration = 0;

function readLines(buffer: IBuffer, start: number, count: number, cols: number): TerminalObservedLine[] {
  return Array.from({ length: count }, (_, row) => {
    const line = buffer.getLine(start + row);
    return {
      row,
      bufferRow: start + row,
      // Preserve physical rows and leading spaces. Limit by terminal cells,
      // not string indices, so resized buffers and wide glyphs read correctly.
      text: line?.translateToString(true, 0, cols) ?? '',
      isWrapped: line?.isWrapped ?? false,
    };
  });
}

function freshness(entry: ObserverEntry, flushState: TerminalFlushState): TerminalFreshness {
  const metrics = getSessionMetrics(entry.api.sessionId, entry.term);
  return {
    pendingChars: metrics?.pendingChars ?? 0,
    inFlightChars: metrics?.inFlightChars ?? 0,
    receivedSequence: metrics?.receivedSequence ?? 0,
    parsedRevision: metrics?.parsedRevision ?? 0,
    lastReceivedAt: metrics?.lastReceivedAt ?? null,
    lastParsedAt: entry.lastParsedAt ?? metrics?.lastParsedAt ?? null,
    gap: metrics?.gap ?? false,
    failed: metrics?.failed ?? false,
    schedulerAvailable: metrics !== null,
    flushState,
  };
}

function revision(entry: ObserverEntry): number {
  return entry.revision + (getSessionMetrics(entry.api.sessionId, entry.term)?.parsedRevision ?? 0);
}

/** Every CLI gets the same observation path; no tool-specific status parser is required. */
export function registerTerminalObserver(sessionId: string, term: Terminal): () => void {
  observers.get(sessionId)?.dispose();
  const generation = `${generationPrefix}:${++nextGeneration}`;
  const ensureCurrent = () => {
    if (observers.get(sessionId) !== entry) {
      throw new Error(`Terminal observer is no longer active: ${sessionId}`);
    }
  };
  const flush = async () => {
    ensureCurrent();
    const state = await flushSession(sessionId, term);
    ensureCurrent();
    return state;
  };
  const entry: ObserverEntry = {
    api: {
      sessionId,
      generation,
      readScreen: async (view = 'live') => {
        const state = await flush();
        const buffer = term.buffer.active;
        const startRow = view === 'viewport' ? buffer.viewportY : buffer.baseY;
        return {
          sessionId, generation, screenRevision: revision(entry), capturedAt: Date.now(),
          view, bufferType: buffer.type, cols: term.cols, rows: term.rows,
          baseY: buffer.baseY, viewportY: buffer.viewportY, startRow,
          cursor: { x: buffer.cursorX, y: buffer.cursorY, bufferRow: buffer.baseY + buffer.cursorY },
          lines: readLines(buffer, startRow, term.rows, term.cols),
          freshness: freshness(entry, state),
        };
      },
      readScrollback: async (startRow, limit = 200) => {
        const state = await flush();
        const buffer = term.buffer.normal;
        const availableRows = buffer.baseY;
        const count = Math.max(0, Math.min(5000, Number.isFinite(limit) ? Math.floor(limit) : 200));
        const start = Math.max(0, Math.min(availableRows, startRow === undefined
          ? availableRows - count
          : Number.isFinite(startRow) ? Math.floor(startRow) : 0));
        const end = Math.min(availableRows, start + count);
        return {
          sessionId, generation, screenRevision: revision(entry), capturedAt: Date.now(),
          bufferType: 'normal', activeBufferType: term.buffer.active.type, cols: term.cols,
          startRow: start, endRow: end, availableRows, hasMore: end < availableRows,
          lines: readLines(buffer, start, end - start, term.cols),
          freshness: freshness(entry, state),
        };
      },
    },
    term,
    revision: 0,
    lastParsedAt: null,
    dispose: () => {
      subscriptions.forEach(subscription => subscription.dispose());
      if (observers.get(sessionId) === entry) observers.delete(sessionId);
    },
  };
  const changed = () => { entry.revision += 1; };
  const subscriptions = [
    term.onWriteParsed(() => { changed(); entry.lastParsedAt = Date.now(); }),
    term.onResize(changed),
    term.onScroll(changed),
    term.buffer.onBufferChange(changed),
  ];
  observers.set(sessionId, entry);
  return entry.dispose;
}

export function getTerminalObserver(sessionId: string): TerminalObserver | undefined {
  return observers.get(sessionId)?.api;
}

export function listTerminalObservers(): Array<{
  sessionId: string;
  generation: string;
  screenRevision: number;
  cols: number;
  rows: number;
  bufferType: 'normal' | 'alternate';
}> {
  return [...observers.values()].map(entry => ({
    sessionId: entry.api.sessionId,
    generation: entry.api.generation,
    screenRevision: revision(entry),
    cols: entry.term.cols,
    rows: entry.term.rows,
    bufferType: entry.term.buffer.active.type,
  }));
}
