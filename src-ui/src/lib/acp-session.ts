import { useSyncExternalStore } from 'react';
import { invoke } from '../tauri';
import { REMOTE } from '../remote/bridge';
import { dropMirrorSource, mirrorCall, mirrorSource, mirrorTarget, registerMirrorActions } from './session-mirror';
import { markPromptSubmitted } from './notify-prompts';
import { recordSessionReply } from './session-replies';
import { emptyAcpState, initializeAcp, reduceAcpEvent, settleAcp, obj, type AcpState, type Json } from './acp-protocol';

interface Client { state: AcpState; tool: string; generation: string; listeners: Set<() => void>; owners: number; starting?: Promise<void>; configuring?: Promise<void>; closeTimer?: ReturnType<typeof setTimeout>; publishTimer?: ReturnType<typeof setTimeout>; pendingTurns: number; observed?: boolean; cancelPending?: boolean; cancelSent?: boolean; earlyCancelSent?: boolean; exited?: boolean }
const clients = new Map<string, Client>(), EMPTY = emptyAcpState();
let listening: Promise<unknown> | undefined;
function client(id: string): Client {
  let c = clients.get(id);
  if (!c) { c = { state: emptyAcpState(), tool: '', generation: crypto.randomUUID(), listeners: new Set(), owners: 0, pendingTurns: 0 }; clients.set(id, c); if (!REMOTE) { const own = c; c.listeners.add(mirrorSource('acp', id, () => own.state)); } }
  return c;
}
function publish(c: Client, immediate = false) {
  if (immediate) { clearTimeout(c.publishTimer); c.publishTimer = undefined; c.listeners.forEach(fn => fn()); }
  else if (!c.publishTimer) c.publishTimer = setTimeout(() => { c.publishTimer = undefined; c.listeners.forEach(fn => fn()); }, 40);
}
function current(id: string, c: Client) { return clients.get(id) === c; }
function request(id: string, method: string, params: Json = {}) {
  const c = clients.get(id);
  if (!c) return Promise.reject(new Error('This desktop session is not running'));
  return invoke<Json>('acp_session_request', { id, generation: c.generation, method, params });
}
function listen() {
  return listening ??= import('@tauri-apps/api/event').then(({ listen }) => listen<{ id: string; generation: string; event: Json }>('acp-session-event', ({ payload }) => {
    const c = clients.get(payload.id); if (!c || c.generation !== payload.generation) return;
    c.state = reduceAcpEvent(c.state, payload.event); publish(c);
    if (payload.event.type === 'coffee_exit') c.exited = true;
    // ACP has no prompt-accepted reply: its response arrives only when the turn ends.
    // Cancelling before the server creates the turn is ignored by agy 1.5.16.
    const update = obj(obj(payload.event.params).update);
    if (c.pendingTurns && (payload.event.method === 'session/request_permission' || ['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(String(update.sessionUpdate)))) {
      c.observed = true;
      if (c.cancelPending) void abortAcp(payload.id);
    }
  })).catch(error => { listening = undefined; throw error; });
}
export function useAcpSession(id: string): AcpState;
export function useAcpSession<T>(id: string, select: (s: AcpState) => T): T;
export function useAcpSession(id: string, select: (s: AcpState) => unknown = s => s) {
  return useSyncExternalStore(fn => { const c = client(id); c.listeners.add(fn); return () => { c.listeners.delete(fn); }; }, () => select(clients.get(id)?.state ?? EMPTY), () => select(EMPTY));
}
export function getAcpConnection(id: string) {
  const c = clients.get(id); return c && c.owners > 0 ? { generation: c.generation, state: c.state, ready: c.state.ready, inputBusy: c.state.busy } : undefined;
}
/** `tool`: which ACP tool this tab runs (lib/acp-tools.ts). */
export function retainAcpSession(id: string, tool: string, cwd: string | null, resumeToken?: string): () => void {
  const c = client(id); clearTimeout(c.closeTimer); c.owners++; c.tool = tool;
  if (REMOTE) { const stop = mirrorTarget('acp', id, state => { c.state = state as AcpState; publish(c, true); }); return () => { stop(); if (!--c.owners) clients.delete(id); }; }
  c.starting ??= (async () => {
    try {
      await listen();
      const result = await invoke<Json>('acp_session_start', { id, generation: c.generation, tool, cwd, resumeToken: resumeToken ?? null });
      if (current(id, c) && !c.exited) { c.state = initializeAcp(c.state, result); publish(c, true); }
    } catch (error) { if (current(id, c)) { c.state = { ...c.state, ready: false, error: String(error) }; publish(c, true); } }
  })();
  return () => {
    if (--c.owners) return;
    c.closeTimer = setTimeout(() => {
      if (c.owners) return;
      // Startup may still be loading history. Close both now and after it settles.
      void invoke('acp_session_close', { id, generation: c.generation }).catch(() => {});
      void c.starting?.finally(() => invoke('acp_session_close', { id, generation: c.generation })).catch(() => {});
      clearTimeout(c.publishTimer); clients.delete(id); dropMirrorSource('acp', id);
    }, 300);
  };
}
export async function sendAcpMessage(id: string, prompt: string): Promise<boolean> {
  if (REMOTE) return mirrorCall('acp', 'sendAcpMessage', [id, prompt]);
  const c = clients.get(id), message = prompt.trim(); if (!c?.state.ready || !c.owners || !message || c.state.requests.length) return false;
  while (c.configuring) {
    const pending = c.configuring;
    await pending;
    if (!current(id, c) || !c.owners || !c.state.ready || c.exited || c.state.requests.length || c.state.error) return false;
    if (c.configuring === pending) break;
  }
  const started = !c.state.busy;
  if (started) { c.observed = false; c.cancelPending = false; c.cancelSent = false; c.earlyCancelSent = false; }
  c.pendingTurns++;
  c.state = { ...c.state, busy: true, interrupted: false, error: undefined, current: undefined,
    ...(started ? { startedAt: Date.now(), endedAt: undefined, turnStart: c.state.messages.length } : {}),
    messages: [...c.state.messages, { id: crypto.randomUUID(), role: 'user', content: message, timestamp: Date.now() }] };
  publish(c, true); markPromptSubmitted(id);
  // ACP prompt resolves at end-of-turn, not acceptance. Sending must remain available for steering.
  void request(id, 'session/prompt', { prompt: [{ type: 'text', text: message }] }).then(result => {
    c.pendingTurns--;
    if (!current(id, c) || c.exited || c.pendingTurns) return;
    c.state = settleAcp(c.state, obj(result)); publish(c, true);
    if (result.stopReason !== 'cancelled') recordSessionReply(id, c.tool, c.state.sessionId);
  }, error => {
    c.pendingTurns--;
    if (!current(id, c) || c.exited) return;
    c.state = c.pendingTurns ? { ...c.state, error: String(error) } : settleAcp(c.state, {}, String(error)); publish(c, true);
  });
  return true;
}
export async function abortAcp(id: string) {
  if (REMOTE) return mirrorCall('acp', 'abortAcp', [id]);
  const c = clients.get(id); if (!c?.state.busy) return;
  c.cancelPending = true;
  if (c.observed ? c.cancelSent : c.earlyCancelSent) return;
  // Try immediately, including when the model/network has not produced output.
  // If agy ignored a pre-start cancellation, reassert it at the first native activity.
  if (c.observed) c.cancelSent = true; else c.earlyCancelSent = true;
  try { await request(id, 'session/cancel'); } catch (error) { if (current(id, c) && !c.exited) { c.cancelSent = false; c.earlyCancelSent = false; c.state = { ...c.state, error: String(error) }; publish(c, true); } }
}
export async function setAcpConfig(id: string, configId: string, value: string) {
  if (REMOTE) return mirrorCall('acp', 'setAcpConfig', [id, configId, value]);
  const c = clients.get(id); if (!c?.state.ready) return;
  // One native readback finishes before the next model/mode/effort change starts.
  const apply = async () => {
    if (!current(id, c) || !c.state.ready || c.exited) return;
    try {
      const result = await request(id, 'session/set_config_option', { configId, value });
      if (current(id, c) && !c.exited) { c.state = { ...reduceAcpEvent(c.state, { method: 'session/update', params: { update: { sessionUpdate: 'config_option_update', configOptions: result.configOptions } } }), error: undefined }; publish(c, true); }
    } catch (error) { if (current(id, c) && !c.exited) { c.state = { ...c.state, error: String(error) }; publish(c, true); } }
  };
  const pending = (c.configuring ?? Promise.resolve()).then(apply);
  c.configuring = pending;
  await pending;
  if (c.configuring === pending) c.configuring = undefined;
}
export async function respondAcp(id: string, requestId: string, optionId: string | null) {
  if (REMOTE) return mirrorCall('acp', 'respondAcp', [id, requestId, optionId]);
  const c = clients.get(id); if (!c) throw new Error('This desktop session is not running');
  await invoke('acp_session_respond', { id, generation: c.generation, requestId, optionId });
  if (current(id, c)) { c.state = { ...c.state, requests: c.state.requests.filter(r => r.id !== requestId) }; publish(c, true); }
}
registerMirrorActions('acp', { sendAcpMessage, abortAcp, setAcpConfig, respondAcp });
