// pty-event-bus.ts — Singleton Tauri event router for PTY events.
//
// Before this existed, every TierTerminal instance called listen() for each
// PTY event type. Tauri multicasts events to every subscription, so with N
// tabs open, every PTY chunk triggered N callbacks — (N-1) of them just did
// an ID check and early-returned.
//
// This module registers exactly ONE listener per event type at the process
// level, keeps a Map<sessionId, Set<handler>>, and routes incoming events to
// subscribers for that session. N-tab fan-out collapses to O(1) map lookup;
// the Set also lets lightweight observers coexist with the xterm renderer.
//
// Usage:
//   const unsub = await subscribeTerminalEvents(sessionId, {
//     onOutput: (data) => { ... },
//     onStatus: (running, exit_code) => { ... },
//     onCwd:    (cwd) => { ... },
//   });
//   // later, on unmount:
//   unsub();

import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** `start`/`end` number the chunk by byte offset; only browsers mirroring a desktop terminal get them. */
interface OutputEventPayload { id: string; data: string; start?: number; end?: number }
interface StatusEventPayload { id: string; running: boolean; exit_code: number | null; }
interface CwdEventPayload { id: string; cwd: string; }
interface ExitEventPayload { id: string; exit_code: number; }
interface TokenEventPayload { id: string; token: string; }

type OutputHandler = (data: string, range?: { start: number; end: number }) => void;
type StatusHandler = (running: boolean, exitCode: number | null) => void;
type CwdHandler = (cwd: string) => void;
type ExitHandler = (exitCode: number) => void;

interface TerminalEventHandlers {
  onOutput?: OutputHandler;
  onStatus?: StatusHandler;
  onCwd?: CwdHandler;
  onToken?: (token: string) => void;
  /** Fires when the Rust child-watcher thread detects the spawned process has
   *  actually died (via child.wait()). Distinct from onStatus which fires
   *  after the reader thread sees EOF — onExit may arrive earlier, and with
   *  the real exit code instead of the hardcoded 0 in the status event. */
  onExit?: ExitHandler;
}

const outputHandlers = new Map<string, Set<OutputHandler>>();
const statusHandlers = new Map<string, Set<StatusHandler>>();
const cwdHandlers = new Map<string, Set<CwdHandler>>();
const exitHandlers = new Map<string, Set<ExitHandler>>();
const tokenHandlers = new Map<string, Set<(token: string) => void>>();

let globalUnlisteners: UnlistenFn[] | null = null;
let initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (globalUnlisteners !== null) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const registered: UnlistenFn[] = [];
    try {
      registered.push(await listen<OutputEventPayload>('tier-terminal-output', (event) => {
        const { data, start, end } = event.payload;
        const range = typeof start === 'number' && typeof end === 'number' ? { start, end } : undefined;
        outputHandlers.get(event.payload.id)?.forEach(handler => handler(data, range));
      }));
      registered.push(await listen<StatusEventPayload>('tier-terminal-status', (event) => {
        statusHandlers.get(event.payload.id)?.forEach(handler => handler(event.payload.running, event.payload.exit_code));
      }));
      registered.push(await listen<CwdEventPayload>('tier-terminal-cwd', (event) => {
        cwdHandlers.get(event.payload.id)?.forEach(handler => handler(event.payload.cwd));
      }));
      registered.push(await listen<ExitEventPayload>('tier-terminal-exit', (event) => {
        exitHandlers.get(event.payload.id)?.forEach(handler => handler(event.payload.exit_code));
      }));
      registered.push(await listen<TokenEventPayload>('tier-terminal-token', (event) => {
        tokenHandlers.get(event.payload.id)?.forEach(handler => handler(event.payload.token));
      }));
      globalUnlisteners = registered;
    } catch (error) {
      // A partial Tauri-listener setup must not leak process-wide listeners or
      // poison every later subscription with the same rejected promise.
      registered.forEach(unlisten => unlisten());
      throw error;
    }
  })();

  try {
    await initPromise;
  } catch (error) {
    initPromise = null;
    throw error;
  }
}

/**
 * Subscribe to PTY events for a specific session.
 * Returns an unsubscribe function. Safe to call before or after the global
 * Tauri listeners are initialized — initialization is lazy and shared.
 *
 * Multiple subscribers per (session, event type) are supported. This keeps
 * the hot Tauri listener singular while allowing independent UI projections
 * of the same PTY session.
 */
export async function subscribeTerminalEvents(
  sessionId: string,
  handlers: TerminalEventHandlers,
): Promise<() => void> {
  await ensureInit();

  // Capture references to the handlers we just registered. Cleanup removes
  // only these exact functions, so Strict Mode remounts remain safe.
  const myOutput = handlers.onOutput;
  const myStatus = handlers.onStatus;
  const myCwd = handlers.onCwd;
  const myExit = handlers.onExit;
  const myToken = handlers.onToken;

  const add = <T,>(map: Map<string, Set<T>>, handler: T | undefined) => {
    if (!handler) return;
    let registered = map.get(sessionId);
    if (!registered) {
      registered = new Set<T>();
      map.set(sessionId, registered);
    }
    registered.add(handler);
  };
  add(outputHandlers, myOutput);
  add(statusHandlers, myStatus);
  add(cwdHandlers, myCwd);
  add(exitHandlers, myExit);
  add(tokenHandlers, myToken);

  return () => {
    const remove = <T,>(map: Map<string, Set<T>>, handler: T | undefined) => {
      if (!handler) return;
      const registered = map.get(sessionId);
      if (!registered) return;
      registered.delete(handler);
      if (registered.size === 0) map.delete(sessionId);
    };
    remove(outputHandlers, myOutput);
    remove(statusHandlers, myStatus);
    remove(cwdHandlers, myCwd);
    remove(exitHandlers, myExit);
    remove(tokenHandlers, myToken);
  };
}
