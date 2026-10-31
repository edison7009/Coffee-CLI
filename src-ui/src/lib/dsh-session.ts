import { useSyncExternalStore } from 'react';
import { directoryFailure } from './session-directory';
import { recordSessionReply } from './session-replies';
import { invoke } from '../tauri';
import { arr, obj, str, emptyDshState, reduceDshNotification, restoreDshLog, type DshModel, type DshRoute, type DshState, type Json } from './dsh-protocol';

interface Client { state: DshState; generation: string; listeners: Set<() => void>; owners: number; cwd: string | null; starting?: Promise<void>; switching?: Promise<void>; closeTimer?: ReturnType<typeof setTimeout>; publishTimer?: ReturnType<typeof setTimeout> }
const clients = new Map<string, Client>();
const EMPTY = emptyDshState();
let listening: Promise<unknown> | undefined;

/** Native commands the SDK routes through `session/query` (official names and Chinese aliases). */
export const DSH_COMMANDS = ['compact', 'permission', 'plan', 'goal'] as const;
const COMMAND = /^\/(compact|permission|plan|goal|压缩|权限|计划|目标)(\s|$)/;

function client(id: string): Client {
  let c = clients.get(id);
  if (!c) { c = { state: emptyDshState(), generation: crypto.randomUUID(), listeners: new Set(), owners: 0, cwd: null }; clients.set(id, c); }
  return c;
}
function publish(c: Client, immediate = false) {
  if (immediate) { clearTimeout(c.publishTimer); c.publishTimer = undefined; c.listeners.forEach(fn => fn()); }
  else if (!c.publishTimer) c.publishTimer = setTimeout(() => { c.publishTimer = undefined; c.listeners.forEach(fn => fn()); }, 40);
}
function listen() {
  return listening ??= import('@tauri-apps/api/event').then(({ listen }) => listen<{ id: string; generation: string; event: Json }>('dsh-session-event', ({ payload }) => {
    const c = clients.get(payload.id); if (!c || c.generation !== payload.generation) return;
    const wasBusy = c.state.busy;
    c.state = reduceDshNotification(c.state, payload.event);
    if (wasBusy && !c.state.busy && payload.event.method === 'session.status') recordSessionReply(payload.id, 'dsh', c.state.sessionId);
    publish(c, payload.event.id !== undefined || ['session.status', 'coffee/exit', 'user-question.cancelled'].includes(str(payload.event.method)));
  }));
}
export function useDshSession(id: string): DshState;
export function useDshSession<T>(id: string, select: (state: DshState) => T): T;
export function useDshSession(id: string, select: (state: DshState) => unknown = state => state) {
  return useSyncExternalStore(fn => { const c = client(id); c.listeners.add(fn); return () => { c.listeners.delete(fn); }; }, () => select(clients.get(id)?.state ?? EMPTY), () => select(EMPTY));
}
export function getDshConnection(id: string) {
  const c = clients.get(id);
  return c && c.owners > 0 ? { generation: c.generation, state: c.state, ready: c.state.ready, inputBusy: c.state.busy } : undefined;
}

/** Starts (or restarts) the runtime; a known Session resumes and its persisted log restores the transcript. */
async function connect(id: string, c: Client, resumeToken: string | undefined, route: DshRoute | undefined, keepTranscript: boolean) {
  await listen();
  const result = await invoke<Json>('dsh_session_start', { id, generation: c.generation, cwd: c.cwd, resumeToken: resumeToken ?? null, route: route ?? null });
  const sessionId = str(result.sessionId), routeResult = obj(result.route);
  let state: DshState = { ...c.state, sessionId, ready: true, restarting: false, stopping: false, error: undefined, routeError: str(result.routeError) || undefined, commands: result.commands !== false, models: arr(result.models).map(obj) as unknown as DshModel[],
    route: { provider: str(routeResult.provider), model: str(routeResult.model), effort: str(routeResult.effort) || null } };
  if (resumeToken && !keepTranscript) {
    const rows = await invoke<unknown[]>('dsh_session_history', { sessionId }).catch(() => []);
    // The resumed runtime records its own route; the requested one stays authoritative here.
    state = { ...restoreDshLog(rows, { ...state, messages: [] }), route: state.route, ready: true, sessionId };
  }
  c.state = state; publish(c, true);
}

export function retainDshSession(id: string, cwd: string | null, resumeToken?: string): () => void {
  const c = client(id); clearTimeout(c.closeTimer); c.owners++; c.cwd = cwd;
  c.starting ??= (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await connect(id, c, resumeToken, undefined, false); return; }
      catch (error) {
        if (directoryFailure(error) || attempt === 1) { c.state = { ...c.state, ready: false, error: String(error) }; publish(c, true); return; }
        const generation = c.generation; c.generation = crypto.randomUUID();
        await invoke('dsh_session_close', { id, generation }).catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (!c.owners) return;
      }
    }
  })();
  return () => {
    if (--c.owners) return;
    c.closeTimer = setTimeout(() => {
      if (c.owners) return;
      void (c.starting ?? Promise.resolve()).finally(() => invoke('dsh_session_close', { id, generation: c.generation })).catch(() => {});
      clearTimeout(c.publishTimer); clients.delete(id);
    }, 300);
  };
}

/** The SDK has no cancel call: replace the runtime and resume the same Session, which repairs the interrupted turn. */
async function restart(id: string, route?: DshRoute) {
  const c = clients.get(id); if (!c || c.state.restarting || !c.state.sessionId) return;
  const previous = c.generation, sessionId = c.state.sessionId;
  c.generation = crypto.randomUUID();
  c.state = { ...c.state, restarting: true, stopping: !route, busy: false, requests: [], startedAt: undefined }; publish(c, true);
  await invoke('dsh_session_close', { id, generation: previous }).catch(() => {});
  // DeepSeek Harness creates a Session on its first prompt; an untouched tab has nothing to resume.
  const started = c.state.messages.length > 0;
  try { await connect(id, c, started ? sessionId : undefined, route ?? c.state.route, true); }
  catch (error) {
    // The failed runtime's exit can arrive after this; its stderr must not replace the start error.
    c.generation = crypto.randomUUID();
    c.state = { ...c.state, restarting: false, stopping: false, ready: false, error: String(error) }; publish(c, true);
  }
}
export const stopDsh = (id: string) => restart(id);
export function setDshRoute(id: string, route: DshRoute): Promise<void> {
  const c = clients.get(id);
  const done = restart(id, route);
  if (c) { c.switching = done; void done.finally(() => { if (c.switching === done) c.switching = undefined; }); }
  return done;
}

export async function sendDshMessage(id: string, prompt: string): Promise<boolean> {
  const c = clients.get(id); const text = prompt.trim();
  // A model or effort switch reloads in the background; a message sent meanwhile goes out once it is back.
  if (c?.switching) await c.switching;
  if (!c?.state.ready || c.state.restarting || !text) return false;
  // The configured model is missing: surface it now rather than answer from a model the user did not pick.
  if (c.state.routeError) { c.state = { ...c.state, error: c.state.routeError }; publish(c, true); return false; }
  const command = COMMAND.test(text);
  if (command && !c.state.commands) {
    // An older runtime would hand the command to the model as an ordinary prompt.
    c.state = { ...c.state, messages: [...c.state.messages, { id: `unsupported:${Date.now()}`, role: 'notice', content: 'commands-unsupported', turn: 0, timestamp: Date.now(), tone: 'info' }] }; publish(c, true);
    return true;
  }
  if (!command) { c.state = { ...c.state, busy: true, startedAt: c.state.startedAt ?? Date.now(), error: undefined }; publish(c, true); }
  try {
    await invoke('dsh_session_request', { id, generation: c.generation, method: command ? 'session/query' : 'session/prompt', params: { contentBlocks: [{ type: 'text', text }] } });
    return true;
  } catch (error) {
    c.state = { ...c.state, busy: false, error: String(error) }; publish(c, true);
    return false;
  }
}

export async function respondDsh(id: string, requestId: string | number, result: Json): Promise<void> {
  const c = clients.get(id); if (!c) return;
  await invoke('dsh_session_respond', { id, generation: c.generation, requestId, result });
  c.state = { ...c.state, requests: c.state.requests.filter(r => r.id !== requestId) }; publish(c, true);
}
