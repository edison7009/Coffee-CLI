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

/** ms to wait after PreToolUse before assuming a permission prompt is shown */
const WAIT_INPUT_DELAY_MS = 1500;

/** Per-tab timer that fires wait_input when no PostToolUse arrives in time */
const pendingTimers = new Map<string, number>();

export function subscribeAgentStatus(
  onPayload: (payload: AgentStatusPayload) => void,
): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;

  listen<AgentStatusPayload>('agent-status', (evt) => {
    const p = evt.payload;

    // Cancel any pending wait_input timer for this tab
    const existing = pendingTimers.get(p.tab_id);
    if (existing) {
      clearTimeout(existing);
      pendingTimers.delete(p.tab_id);
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
    // Clean up any outstanding timers
    for (const timer of pendingTimers.values()) clearTimeout(timer);
    pendingTimers.clear();
    if (unlisten) unlisten();
  };
}
