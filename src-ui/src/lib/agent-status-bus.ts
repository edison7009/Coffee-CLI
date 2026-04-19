// Agent Status Bus
//
// Listens to the `agent-status` Tauri event emitted by the Rust hook server
// (which in turn receives forwarded events from Claude Code / Qwen Code via
// the Python hook script). Each payload carries a tab_id and a status that
// is dispatched straight into AppState's agentStatus slot for that tab.
//
// Permission-prompt detection: after PreToolUse fires, if no PostToolUse
// arrives within WAIT_INPUT_DELAY_MS we assume a permission prompt is
// showing and promote the tab to "wait_input" (blue ripple).

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AgentStatus } from '../store/app-state';

export interface AgentStatusPayload {
  tab_id: string;
  tool: string;
  status: AgentStatus;
  event: string;
}

/** ms to wait after PreToolUse before assuming a permission prompt is shown.
 *  Was 1500 — Claude tool calls routinely run 2-3 s (grep / file read /
 *  mcp call), which made "still executing" flash blue as if waiting for
 *  permission. 3500 matches real-world tool-call latency more honestly. */
const WAIT_INPUT_DELAY_MS = 3500;

/** Fallback timer: any non-idle status that's gone this long without a
 *  follow-up event is assumed stale. Protects against hook drops and the
 *  "Claude finished but forgot to emit Stop" case that leaves the dot blue. */
const AUTO_IDLE_MS = 30_000;

/** Per-tab timer that fires wait_input when no PostToolUse arrives in time */
const pendingTimers = new Map<string, number>();

/** Per-tab auto-idle timers (one per non-idle status) */
const idleTimers = new Map<string, number>();

/** Most recent emit function from the active subscription. Lets
 *  notifyUserInputSubmitted() route into the same pipeline as real
 *  hook events. Null before subscribe / after unsubscribe. */
let activeEmit: ((p: AgentStatusPayload) => void) | null = null;

function clearTabTimers(tabId: string) {
  const pt = pendingTimers.get(tabId);
  if (pt) { clearTimeout(pt); pendingTimers.delete(tabId); }
  const it = idleTimers.get(tabId);
  if (it) { clearTimeout(it); idleTimers.delete(tabId); }
}

/** Start / reset the auto-idle fallback for a given tab. */
function armAutoIdle(tabId: string, tool: string) {
  const existing = idleTimers.get(tabId);
  if (existing) clearTimeout(existing);
  const timer = window.setTimeout(() => {
    idleTimers.delete(tabId);
    if (activeEmit) {
      activeEmit({ tab_id: tabId, tool, status: 'idle', event: 'AutoIdleFallback' });
    }
  }, AUTO_IDLE_MS);
  idleTimers.set(tabId, timer);
}

/** Optimistic-update hook: call when the user presses Enter in a tab's
 *  terminal. The CLI hasn't acknowledged yet, but the user's intent is
 *  unambiguous: the LLM is about to start thinking. Emit 'thinking'
 *  (not 'executing') because no tool call has been initiated yet — that
 *  only happens when a real PreToolUse event arrives and the bus promotes
 *  the tab to 'executing'. */
export function notifyUserInputSubmitted(tabId: string, tool: string) {
  if (!activeEmit) return;
  // Cancel any pending wait_input — user just interacted, so whatever
  // permission prompt was showing is presumably resolved.
  const pt = pendingTimers.get(tabId);
  if (pt) { clearTimeout(pt); pendingTimers.delete(tabId); }
  activeEmit({ tab_id: tabId, tool, status: 'thinking', event: 'UserSubmitted' });
  armAutoIdle(tabId, tool);
}

export function subscribeAgentStatus(
  onPayload: (payload: AgentStatusPayload) => void,
): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  activeEmit = onPayload;

  listen<AgentStatusPayload>('agent-status', (evt) => {
    const p = evt.payload;

    // Cancel any pending wait_input timer for this tab
    const existing = pendingTimers.get(p.tab_id);
    if (existing) {
      clearTimeout(existing);
      pendingTimers.delete(p.tab_id);
    }

    // Any real event resets the auto-idle clock; an `idle` status clears it.
    if (p.status === 'idle') {
      const it = idleTimers.get(p.tab_id);
      if (it) { clearTimeout(it); idleTimers.delete(p.tab_id); }
    } else {
      armAutoIdle(p.tab_id, p.tool);
    }

    // If the hook already resolved wait_input (PermissionRequest /
    // Notification.permission_prompt actually fired), pass it straight through.
    if (p.status === 'wait_input') {
      onPayload(p);
      return;
    }

    if (p.event === 'PreToolUse') {
      // Pass "executing" through immediately …
      onPayload(p);
      // … but start a timer: if PostToolUse doesn't arrive soon, the agent
      // is probably blocked on a permission prompt → switch to wait_input.
      const timer = window.setTimeout(() => {
        pendingTimers.delete(p.tab_id);
        onPayload({ ...p, status: 'wait_input', event: 'PermissionInferred' });
      }, WAIT_INPUT_DELAY_MS);
      pendingTimers.set(p.tab_id, timer);
    } else {
      onPayload(p);
    }
  }).then((fn) => {
    if (cancelled) {
      fn();
    } else {
      unlisten = fn;
    }
  });

  return () => {
    cancelled = true;
    activeEmit = null;
    // Clean up every tab's timers on unsubscribe.
    for (const timer of pendingTimers.values()) clearTimeout(timer);
    pendingTimers.clear();
    for (const timer of idleTimers.values()) clearTimeout(timer);
    idleTimers.clear();
    if (unlisten) unlisten();
  };
}

// Re-exposed so unit tests / future callers can pre-clear state.
export { clearTabTimers };
