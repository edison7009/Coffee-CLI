import { useSyncExternalStore } from 'react';
import { directoryFailure } from './session-directory';
import { recordSessionReply } from './session-replies';
import { markPromptSubmitted } from './notify-prompts';
import { invoke } from '../tauri';
import { REMOTE } from '../remote/bridge';
import { mirrorCall, mirrorSource, mirrorTarget, registerMirrorActions } from './session-mirror';
import { arr, emptyPiState, obj, piModel, piStats, reducePiEvent, restorePiMessages, str, type Json, type PiModel, type PiState } from './pi-protocol';

interface Client { state: PiState; generation: string; listeners: Set<() => void>; owners: number; cwd: string | null; starting?: Promise<void>; closeTimer?: ReturnType<typeof setTimeout>; publishTimer?: ReturnType<typeof setTimeout> }
const clients = new Map<string, Client>();
const EMPTY = emptyPiState();
let listening: Promise<unknown> | undefined;

function client(id: string): Client {
  let c = clients.get(id);
  if (!c) { c = { state: emptyPiState(), generation: crypto.randomUUID(), listeners: new Set(), owners: 0, cwd: null }; clients.set(id, c); if (!REMOTE) { const own = c; own.listeners.add(mirrorSource('pi', id, () => own.state)); } }
  return c;
}
function publish(c: Client, immediate = false) {
  if (immediate) { clearTimeout(c.publishTimer); c.publishTimer = undefined; c.listeners.forEach(fn => fn()); }
  else if (!c.publishTimer) c.publishTimer = setTimeout(() => { c.publishTimer = undefined; c.listeners.forEach(fn => fn()); }, 40);
}
function request(id: string, command: Json): Promise<Json> {
  const c = clients.get(id);
  if (!c) return Promise.reject(new Error('Pi session is not running'));
  return invoke<Json>('pi_session_request', { id, generation: c.generation, command });
}
/** Context and token totals come from Pi's own statistics after each run. */
async function refreshStats(id: string, c: Client) {
  try { const data = await invoke<Json>('pi_session_request', { id, generation: c.generation, command: { type: 'get_session_stats' } }); c.state = { ...c.state, stats: piStats(obj(data), c.state.stats) }; publish(c, true); }
  catch { /* Statistics are informational. */ }
}
function listen() {
  return listening ??= import('@tauri-apps/api/event').then(({ listen }) => listen<{ id: string; generation: string; event: Json }>('pi-session-event', ({ payload }) => {
    const c = clients.get(payload.id); if (!c || c.generation !== payload.generation) return;
    const type = str(payload.event.type);
    c.state = reducePiEvent(c.state, payload.event);
    if (type === 'agent_settled') {
      if (payload.event.aborted !== true) recordSessionReply(payload.id, 'pi', c.state.sessionId);
      void refreshStats(payload.id, c);
    }
    if (type === 'compaction_end') void refreshStats(payload.id, c);
    publish(c, !['message_update', 'tool_execution_update'].includes(type));
  }));
}
export function usePiSession(id: string): PiState;
export function usePiSession<T>(id: string, select: (state: PiState) => T): T;
export function usePiSession(id: string, select: (state: PiState) => unknown = state => state) {
  return useSyncExternalStore(fn => { const c = client(id); c.listeners.add(fn); return () => { c.listeners.delete(fn); }; }, () => select(clients.get(id)?.state ?? EMPTY), () => select(EMPTY));
}
export function getPiConnection(id: string) {
  const c = clients.get(id);
  return c && c.owners > 0 ? { generation: c.generation, state: c.state, ready: c.state.ready, inputBusy: c.state.busy } : undefined;
}

async function connect(id: string, c: Client, resumeToken: string | undefined) {
  await listen();
  const result = await invoke<Json>('pi_session_start', { id, generation: c.generation, cwd: c.cwd, resumeToken: resumeToken ?? null });
  const state = obj(result.state);
  const models = arr(result.models).map(piModel).filter((m): m is PiModel => !!m);
  let next: PiState = { ...c.state, ready: true, error: undefined, sessionId: str(result.sessionId), title: str(state.sessionName) || c.state.title, model: piModel(state.model), thinkingLevel: str(state.thinkingLevel) || 'off', models, busy: state.isStreaming === true };
  if (resumeToken) next = restorePiMessages(arr(result.messages), next);
  c.state = next; publish(c, true);
  if (resumeToken) void refreshStats(id, c);
}

export function retainPiSession(id: string, cwd: string | null, resumeToken?: string): () => void {
  // In the browser the desktop runs the session; this only follows it.
  if (REMOTE) {
    const c = client(id); c.owners++;
    const stop = mirrorTarget('pi', id, state => { c.state = state as PiState; publish(c, true); });
    return () => { stop(); if (!--c.owners) clients.delete(id); };
  }
  const c = client(id); clearTimeout(c.closeTimer); c.owners++; c.cwd = cwd;
  c.starting ??= (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await connect(id, c, resumeToken); return; }
      catch (error) {
        if (directoryFailure(error) || attempt === 1 || /not installed/i.test(String(error))) { c.state = { ...c.state, ready: false, error: String(error) }; publish(c, true); return; }
        const generation = c.generation; c.generation = crypto.randomUUID();
        await invoke('pi_session_close', { id, generation }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (!c.owners) return;
      }
    }
  })();
  return () => {
    if (--c.owners) return;
    c.closeTimer = setTimeout(() => {
      if (c.owners) return;
      void (c.starting ?? Promise.resolve()).finally(() => invoke('pi_session_close', { id, generation: c.generation })).catch(() => {});
      clearTimeout(c.publishTimer); clients.delete(id);
    }, 300);
  };
}

/** A message typed during a run steers it, as in Pi's own editor. */
export async function sendPiMessage(id: string, prompt: string): Promise<boolean> {
  if (REMOTE) return mirrorCall('pi', 'sendPiMessage', [id, prompt]);
  const c = clients.get(id); const message = prompt.trim();
  if (!c?.state.ready || !message) return false;
  if (!c.state.model) { c.state = { ...c.state, error: 'no-model' }; publish(c, true); return false; }
  const steer = c.state.busy;
  // Pi's status is not native to the chime, which waits for a prompt the user sent before announcing a finished run.
  markPromptSubmitted(id);
  if (!steer) { c.state = { ...c.state, busy: true, startedAt: Date.now(), endedAt: undefined, interrupted: false, error: undefined }; publish(c, true); }
  try {
    await request(id, steer ? { type: 'steer', message } : { type: 'prompt', message });
    return true;
  } catch (error) {
    c.state = { ...c.state, busy: steer, error: String(error) }; publish(c, true);
    return false;
  }
}
export async function abortPi(id: string) {
  if (REMOTE) return mirrorCall('pi', 'abortPi', [id]);
  const c = clients.get(id); if (!c?.state.busy) return;
  await request(id, { type: 'abort' }).catch(() => {});
}
export async function setPiModel(id: string, model: PiModel) {
  if (REMOTE) return mirrorCall('pi', 'setPiModel', [id, model]);
  const c = clients.get(id); if (!c) return;
  try {
    const data = await request(id, { type: 'set_model', provider: model.provider, modelId: model.id });
    c.state = { ...c.state, model: piModel(data) ?? model, error: undefined };
    // A model without reasoning turns thinking off; read back what Pi applied.
    const state = await request(id, { type: 'get_state' }).catch(() => undefined);
    if (state) c.state = { ...c.state, thinkingLevel: str(state.thinkingLevel) || c.state.thinkingLevel };
    publish(c, true); void refreshStats(id, c);
  } catch (error) { c.state = { ...c.state, error: String(error) }; publish(c, true); }
}
export async function getPiThinkingLevels(id: string): Promise<string[]> {
  if (REMOTE) return mirrorCall('pi', 'getPiThinkingLevels', [id]);
  const data = await request(id, { type: 'get_available_thinking_levels' }).catch(() => ({} as Json));
  return arr(data.levels).map(str).filter(Boolean);
}
export async function setPiThinkingLevel(id: string, level: string) {
  if (REMOTE) return mirrorCall('pi', 'setPiThinkingLevel', [id, level]);
  const c = clients.get(id); if (!c) return;
  try { await request(id, { type: 'set_thinking_level', level }); c.state = { ...c.state, thinkingLevel: level }; publish(c, true); }
  catch (error) { c.state = { ...c.state, error: String(error) }; publish(c, true); }
}
export async function compactPi(id: string) {
  if (REMOTE) return mirrorCall('pi', 'compactPi', [id]);
  const c = clients.get(id); if (!c?.state.ready || c.state.busy) return;
  try { await request(id, { type: 'compact' }); } catch (error) { c.state = { ...c.state, error: String(error) }; publish(c, true); }
}
export async function respondPi(id: string, requestId: string, response: Json): Promise<void> {
  if (REMOTE) return mirrorCall('pi', 'respondPi', [id, requestId, response]);
  const c = clients.get(id); if (!c) return;
  await invoke('pi_session_respond', { id, generation: c.generation, requestId, response });
  c.state = { ...c.state, requests: c.state.requests.filter(r => r.id !== requestId) }; publish(c, true);
}

// What a browser may ask the desktop to do in a pi conversation.
registerMirrorActions('pi', { compactPi, setPiThinkingLevel, getPiThinkingLevels, setPiModel, abortPi, sendPiMessage, respondPi });
