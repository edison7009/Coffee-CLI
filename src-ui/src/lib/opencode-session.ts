import { useSyncExternalStore } from 'react';
import { readLaunchControls, setSessionControls, clearSessionControls } from './session-controls';
import { directoryFailure } from './session-directory';
import { recordSessionReply } from './session-replies';
import { markPromptSubmitted } from './notify-prompts';
import { invoke } from '../tauri';
import { REMOTE } from '../remote/bridge';
import { mirrorCall, mirrorSource, mirrorTarget, registerMirrorActions } from './session-mirror';
import { gambitAttachments } from './gambit-attachments';
import { arr, obj, str, num, emptyOpenCodeState, lastContextTokens, reduceOpenCodeEvent, type Json, type OpenCodeAgent, type OpenCodeCommand, type OpenCodeModel, type OpenCodeModelRef, type OpenCodeState } from './opencode-protocol';

interface Client { state: OpenCodeState; generation: string; listeners: Set<() => void>; owners: number; starting?: Promise<void>; closeTimer?: ReturnType<typeof setTimeout>; publishTimer?: ReturnType<typeof setTimeout>; sending: boolean; exited?: boolean; connecting?: boolean; startupExit?: string; autoApprove?: boolean; approving?: Set<string> }
const clients = new Map<string, Client>();
const EMPTY = emptyOpenCodeState();
let listening: Promise<unknown> | undefined;
function client(id: string): Client {
  let c = clients.get(id);
  if (!c) { c = { state: emptyOpenCodeState(), generation: crypto.randomUUID(), listeners: new Set(), owners: 0, sending: false }; clients.set(id, c); if (!REMOTE) { const own = c; own.listeners.add(mirrorSource('opencode', id, () => own.state)); } }
  return c;
}
function publish(c: Client, immediate = false) {
  if (immediate) { clearTimeout(c.publishTimer); c.publishTimer = undefined; c.listeners.forEach(fn => fn()); }
  else if (!c.publishTimer) c.publishTimer = setTimeout(() => { c.publishTimer = undefined; c.listeners.forEach(fn => fn()); }, 40);
}
const IMMEDIATE = new Set(['session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'permission.asked', 'permission.replied', 'form.created', 'form.replied', 'form.cancelled', 'coffee.exit']);
function listen() {
  return listening ??= import('@tauri-apps/api/event').then(({ listen }) => listen<{ id: string; generation: string; event: Json }>('opencode-session-event', ({ payload }) => {
    const c = clients.get(payload.id); if (!c || c.generation !== payload.generation) return;
    const type = str(payload.event.type);
    if (type === 'coffee.exit') { c.exited = true; clearSessionControls(payload.id, c.generation); }
    if (c.connecting && !c.state.ready && type === 'coffee.exit') { c.startupExit = str(obj(payload.event.data).detail) || 'OpenCode process exited'; return; }
    // A new conversation's session is created by its first prompt; take it before that prompt's events arrive.
    if (type === 'coffee.session') {
      const session = obj(obj(payload.event.data).session);
      c.state = { ...c.state, nativeId: str(session.id), title: str(session.title) || c.state.title, model: modelRef(session.model) ?? c.state.model, agent: str(session.agent) || c.state.agent };
      publish(c, true); return;
    }
    const wasBusy = c.state.busy;
    c.state = reduceOpenCodeEvent(c.state, payload.event);
    if (wasBusy && !c.state.busy && type === 'session.execution.succeeded') recordSessionReply(payload.id, 'opencode', c.state.nativeId);
    publish(c, IMMEDIATE.has(type));
    approvePending(payload.id, c);
  }));
}
/** The `--auto` command preset, applied the way OpenCode's own client does: every request is allowed once. */
function approvePending(id: string, c: Client) {
  if (!c.autoApprove) return;
  const approving = c.approving ??= new Set();
  for (const permission of c.state.permissions) {
    const requestID = str(permission.id);
    if (approving.has(requestID)) continue;
    approving.add(requestID);
    void replyOpenCodePermission(id, requestID, 'once').catch(() => { approving.delete(requestID); });
  }
}
export function useOpenCodeSession(id: string): OpenCodeState;
export function useOpenCodeSession<T>(id: string, select: (state: OpenCodeState) => T): T;
export function useOpenCodeSession(id: string, select: (state: OpenCodeState) => unknown = state => state) {
  return useSyncExternalStore(fn => { const c = client(id); c.listeners.add(fn); return () => { c.listeners.delete(fn); }; }, () => select(clients.get(id)?.state ?? EMPTY), () => select(EMPTY));
}
export function getOpenCodeConnection(id: string) {
  const c = clients.get(id);
  return c && c.owners > 0 ? { generation: c.generation, state: c.state, ready: c.state.ready && !c.connecting, inputBusy: c.state.busy || c.sending } : undefined;
}
export function openCodeRequests(state: OpenCodeState): { id: string; kind: string }[] {
  return [...state.permissions.map(p => ({ id: str(p.id), kind: `permission:${str(p.action)}` })), ...state.forms.map(f => ({ id: str(f.id), kind: 'form' }))];
}
function request(c: Client, id: string, op: string, params: Json = {}): Promise<Json> {
  return invoke<Json>('opencode_session_request', { id, generation: c.generation, op, params });
}
const modelRef = (value: unknown): OpenCodeModelRef | null => { const m = obj(value); return m.id ? { id: str(m.id), providerID: str(m.providerID), ...(m.variant && m.variant !== 'default' ? { variant: str(m.variant) } : {}) } : null; };

export function retainOpenCodeSession(id: string, cwd: string | null, resumeToken?: string): () => void {
  // In the browser the desktop runs the session; this only follows it.
  if (REMOTE) {
    const c = client(id); c.owners++;
    const stop = mirrorTarget('opencode', id, state => { c.state = state as OpenCodeState; publish(c, true); });
    return () => { stop(); if (!--c.owners) clients.delete(id); };
  }
  const c = client(id); clearTimeout(c.closeTimer); c.owners++;
  c.starting ??= (async () => {
    c.connecting = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await listen();
        clearSessionControls(id, c.generation);
        // Computer and browser control are MCP servers in OpenCode's own config, read when the server starts.
        const controls = readLaunchControls('opencode'), generation = c.generation;
        const result = await invoke<Json>('opencode_session_start', { id, generation: c.generation, cwd, resumeToken: resumeToken ?? null });
        if (c.exited) throw new Error(c.startupExit || 'OpenCode process exited');
        const session = obj(result.session), history = arr(result.messages).map(obj).reverse();
        const liveIds = new Set(c.state.native.map(m => m.id));
        const native = [...history.filter(m => !liveIds.has(m.id)), ...c.state.native];
        c.state = {
          ...c.state, ready: true, error: undefined, nativeId: str(session.id), title: str(session.title),
          native, cursor: str(result.cursor) || null,
          models: arr(result.models).map(obj) as unknown as OpenCodeModel[],
          agents: arr(result.agents).map(obj) as unknown as OpenCodeAgent[],
          commands: arr(result.commands).map(obj) as unknown as OpenCodeCommand[],
          model: modelRef(session.model) ?? modelRef(result.defaultModel), agent: str(session.agent) || c.state.agent,
          permissions: arr(result.permissions).map(obj), forms: arr(result.forms).map(obj).filter(f => !f.state || obj(f.state).status === 'pending'),
          contextTokens: lastContextTokens(native), totalTokens: (() => { const t = obj(session.tokens), cache = obj(t.cache); return num(t.input) + num(t.output) + num(t.reasoning) + num(cache.read) + num(cache.write); })(),
          busy: result.running === true || c.state.busy,
        };
        c.autoApprove = result.autoApprove === true;
        approvePending(id, c);
        void controls.then(value => {
          if (clients.get(id) === c && c.owners && c.generation === generation && c.state.ready) setSessionControls(id, generation, value);
        });
        publish(c, true);
        return;
      } catch (error) {
        if (directoryFailure(error) || attempt === 2 || /not installed|version|2\.0/.test(String(error))) { c.state = { ...c.state, ready: false, error: String(error) }; publish(c, true); return; }
        const generation = c.generation;
        clearSessionControls(id, generation);
        c.generation = crypto.randomUUID();
        await invoke('opencode_session_close', { id, generation }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        if (!c.owners) return;
        c.exited = false; c.startupExit = undefined;
        c.state = { ...c.state, ready: false, error: undefined };
      }
    }
  })().finally(() => { c.connecting = false; });
  return () => {
    if (--c.owners) return;
    c.closeTimer = setTimeout(() => {
      if (c.owners) return;
      void (c.starting ?? Promise.resolve()).finally(() => invoke('opencode_session_close', { id, generation: c.generation })).catch(() => {});
      clearTimeout(c.publishTimer); clearSessionControls(id, c.generation); clients.delete(id);
    }, 300);
  };
}

/** Prompts sent during a turn are steered into it, as in OpenCode's own clients. */
export async function sendOpenCodeMessage(id: string, prompt: string): Promise<boolean> {
  if (REMOTE) return mirrorCall('opencode', 'sendOpenCodeMessage', [id, prompt]);
  const c = client(id); if (!c.state.ready || c.sending || !prompt.trim()) return false;
  // OpenCode's status is not native to the chime, which waits for a prompt the user sent.
  markPromptSubmitted(id);
  c.sending = true;
  c.state = { ...c.state, busy: true, startedAt: c.state.startedAt ?? Date.now(), error: undefined }; publish(c, true);
  try {
    const paths = [...new Set(gambitAttachments(prompt).filter(a => a.image).map(a => a.path))];
    const result = await request(c, id, 'prompt', { text: prompt, paths, requestId: crypto.randomUUID() });
    // The admitted prompt echoes back as an inbox event; showing it here too keeps a slow event stream from hiding it.
    const item = obj(result.data);
    if (item.id && !c.state.native.some(m => m.id === item.id)) c.state = { ...c.state, native: [...c.state.native, { id: item.id, type: 'user', ...obj(item.payload), time: obj(item.time), pending: c.state.busy && c.state.native.some(m => m.type === 'assistant' && !obj(m.time).completed) }] };
    return true;
  } catch (error) { c.state = { ...c.state, busy: c.state.native.some(m => m.type === 'assistant' && !obj(m.time).completed), error: String(error) }; return false; }
  finally { c.sending = false; publish(c, true); }
}
export async function interruptOpenCode(id: string): Promise<void> {
  if (REMOTE) return mirrorCall('opencode', 'interruptOpenCode', [id]);
  const c = client(id); if (!c.state.busy || c.state.interrupting) return;
  c.state = { ...c.state, interrupting: true }; publish(c, true);
  try { await request(c, id, 'interrupt'); }
  catch (error) { c.state = { ...c.state, interrupting: false, error: String(error) }; publish(c, true); }
}
export async function replyOpenCodePermission(id: string, requestID: string, decision: 'once' | 'always' | 'reject'): Promise<void> {
  if (REMOTE) return mirrorCall('opencode', 'replyOpenCodePermission', [id, requestID, decision]);
  const c = client(id);
  const asker = c.state.permissions.find(p => p.id === requestID);
  await request(c, id, 'permission.reply', { requestID, decision, ...(asker?.sessionID ? { sessionID: asker.sessionID } : {}) });
  c.state = { ...c.state, permissions: c.state.permissions.filter(p => p.id !== requestID) }; publish(c, true);
}
export async function replyOpenCodeForm(id: string, formID: string, answer: Json | null): Promise<void> {
  if (REMOTE) return mirrorCall('opencode', 'replyOpenCodeForm', [id, formID, answer]);
  const c = client(id);
  const asker = c.state.forms.find(f => f.id === formID), sessionID = asker?.sessionID ? { sessionID: asker.sessionID } : {};
  await request(c, id, answer ? 'form.reply' : 'form.cancel', answer ? { formID, answer, ...sessionID } : { formID, ...sessionID });
  c.state = { ...c.state, forms: c.state.forms.filter(f => f.id !== formID) }; publish(c, true);
}
/** Model, variant and agent switches apply to the session's next provider turn. */
export async function configureOpenCode(id: string, patch: { model?: OpenCodeModelRef; agent?: string }): Promise<void> {
  if (REMOTE) return mirrorCall('opencode', 'configureOpenCode', [id, patch]);
  const c = client(id); if (!c.state.ready) return;
  const previous = { model: c.state.model, agent: c.state.agent };
  // A new choice replaces any error left by the last one.
  c.state = { ...c.state, error: undefined, ...(patch.model ? { model: patch.model } : {}), ...(patch.agent ? { agent: patch.agent } : {}) }; publish(c, true);
  try {
    if (patch.model) await request(c, id, 'model', { id: patch.model.id, providerID: patch.model.providerID, ...(patch.model.variant ? { variant: patch.model.variant } : {}) });
    if (patch.agent) await request(c, id, 'agent', { agent: patch.agent });
  } catch (error) { c.state = { ...c.state, ...previous, error: String(error) }; publish(c, true); }
}
export async function runOpenCodeCommand(id: string, command: 'compact' | { name: string; text?: string }): Promise<void> {
  if (REMOTE) return mirrorCall('opencode', 'runOpenCodeCommand', [id, command]);
  const c = client(id); if (!c.state.ready || c.state.busy || c.sending) throw new Error('OpenCode is not ready');
  // A new conversation has no session until its first prompt, so there is nothing to compact yet.
  if (command === 'compact' && !c.state.nativeId) return;
  c.sending = true; c.state = { ...c.state, busy: true, startedAt: Date.now(), error: undefined }; publish(c, true);
  try {
    if (command === 'compact') await request(c, id, 'compact');
    else await request(c, id, 'command', { name: command.name, text: command.text ?? '' });
  } catch (error) { c.state = { ...c.state, busy: false, startedAt: undefined, error: String(error) }; throw error; }
  finally { c.sending = false; publish(c, true); }
}
export async function loadOpenCodeHistory(id: string): Promise<void> {
  if (REMOTE) return mirrorCall('opencode', 'loadOpenCodeHistory', [id]);
  const c = client(id); if (!c.state.cursor || c.state.loadingHistory) return;
  c.state = { ...c.state, loadingHistory: true }; publish(c, true);
  try {
    const page = await request(c, id, 'messages', { cursor: c.state.cursor });
    const known = new Set(c.state.native.map(m => m.id));
    const older = arr(page.data).map(obj).reverse().filter(m => !known.has(m.id));
    c.state = { ...c.state, native: [...older, ...c.state.native], cursor: older.length ? str(obj(page.cursor).next) || null : null };
  } catch (error) { c.state = { ...c.state, error: String(error) }; }
  finally { c.state = { ...c.state, loadingHistory: false }; publish(c, true); }
}

// What a browser may ask the desktop to do in a opencode conversation.
registerMirrorActions('opencode', { sendOpenCodeMessage, interruptOpenCode, replyOpenCodePermission, replyOpenCodeForm, configureOpenCode, runOpenCodeCommand, loadOpenCodeHistory });
