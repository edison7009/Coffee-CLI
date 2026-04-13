// pty-event-bus.ts — Singleton Tauri event router for PTY events.
//
// Before this existed, every TierTerminal instance called listen() for each
// PTY event type. Tauri multicasts events to every subscription, so with N
// tabs open, every PTY chunk triggered N callbacks — (N-1) of them just did
// an ID check and early-returned.
//
// This module registers exactly ONE listener per event type at the process
// level, keeps a Map<sessionId, handler>, and routes incoming events to the
// right handler by ID. N-tab fan-out collapses to O(1) map lookup per event.
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

interface OutputEventPayload { id: string; data: string; }
interface StatusEventPayload { id: string; running: boolean; exit_code: number | null; }
interface CwdEventPayload { id: string; cwd: string; }

export type OutputHandler = (data: string) => void;
export type StatusHandler = (running: boolean, exitCode: number | null) => void;
export type CwdHandler = (cwd: string) => void;

export interface TerminalEventHandlers {
  onOutput?: OutputHandler;
  onStatus?: StatusHandler;
  onCwd?: CwdHandler;
}

const outputHandlers = new Map<string, OutputHandler>();
const statusHandlers = new Map<string, StatusHandler>();
const cwdHandlers = new Map<string, CwdHandler>();

let globalUnlisteners: UnlistenFn[] | null = null;
let initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (globalUnlisteners !== null) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const unOutput = await listen<OutputEventPayload>('tier-terminal-output', (event) => {
      const handler = outputHandlers.get(event.payload.id);
      if (handler) handler(event.payload.data);
    });
    const unStatus = await listen<StatusEventPayload>('tier-terminal-status', (event) => {
      const handler = statusHandlers.get(event.payload.id);
      if (handler) handler(event.payload.running, event.payload.exit_code);
    });
    const unCwd = await listen<CwdEventPayload>('tier-terminal-cwd', (event) => {
      const handler = cwdHandlers.get(event.payload.id);
      if (handler) handler(event.payload.cwd);
    });
    globalUnlisteners = [unOutput, unStatus, unCwd];
  })();

  return initPromise;
}

/**
 * Subscribe to PTY events for a specific session.
 * Returns an unsubscribe function. Safe to call before or after the global
 * Tauri listeners are initialized — initialization is lazy and shared.
 *
 * Only one handler per (session, event type) is supported. Calling subscribe
 * again for the same session overwrites previous handlers for that session.
 */
export async function subscribeTerminalEvents(
  sessionId: string,
  handlers: TerminalEventHandlers,
): Promise<() => void> {
  await ensureInit();

  if (handlers.onOutput) outputHandlers.set(sessionId, handlers.onOutput);
  if (handlers.onStatus) statusHandlers.set(sessionId, handlers.onStatus);
  if (handlers.onCwd) cwdHandlers.set(sessionId, handlers.onCwd);

  return () => {
    outputHandlers.delete(sessionId);
    statusHandlers.delete(sessionId);
    cwdHandlers.delete(sessionId);
  };
}
