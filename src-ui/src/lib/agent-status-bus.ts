// Agent Status Bus
//
// Listens to the `agent-status` Tauri event emitted by the Rust hook server
// (which in turn receives forwarded events from Claude Code / Qwen Code via
// the Python hook script). Each payload carries a tab_id and a status that
// is dispatched straight into AppState's agentStatus slot for that tab.

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AgentStatus } from '../store/app-state';

export interface AgentStatusPayload {
  tab_id: string;
  tool: string;
  status: AgentStatus;
  event: string;
}

export function subscribeAgentStatus(
  onPayload: (payload: AgentStatusPayload) => void,
): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;

  listen<AgentStatusPayload>('agent-status', (evt) => {
    onPayload(evt.payload);
  }).then((fn) => {
    if (cancelled) {
      fn();
    } else {
      unlisten = fn;
    }
  });

  return () => {
    cancelled = true;
    if (unlisten) unlisten();
  };
}
