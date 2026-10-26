import { useSyncExternalStore } from 'react';
import { directoryFailure } from './session-directory';
import { recordSessionReply } from './session-replies';
import { readLaunchControls, setSessionControls, clearSessionControls } from './session-controls';
import { invoke, type ToolConfigEntry } from '../tauri';
import { emptyClaudeState, reduceClaudeEvent, object, list, text, type ClaudeState, type ClaudeModel, type ClaudeCommand, type Json } from './claude-protocol';

interface Client {
  state: ClaudeState;
  generation: string;
  listeners: Set<() => void>;
  starting?: Promise<unknown>;
  owners: number;
  closeTimer?: ReturnType<typeof setTimeout>;
  publishTimer?: ReturnType<typeof setTimeout>;
  cwd?: string | null;
  restarting?: boolean;
  connecting?: boolean;
  startupExit?: string;
}
const clients = new Map<string, Client>();
let listening: Promise<unknown> | undefined;
const EMPTY = emptyClaudeState();

function client(id: string): Client {
  let c = clients.get(id);
  if (!c) { c = { state: emptyClaudeState(), generation: crypto.randomUUID(), listeners: new Set(), owners: 0 }; clients.set(id, c); }
  return c;
}
function publish(c: Client, immediate = false) {
  if (immediate) { clearTimeout(c.publishTimer); c.publishTimer = undefined; c.listeners.forEach(fn => fn()); }
  else if (!c.publishTimer) c.publishTimer = setTimeout(() => { c.publishTimer = undefined; c.listeners.forEach(fn => fn()); }, 40);
}
function listen() {
  return listening ??= import('@tauri-apps/api/event').then(({ listen }) => listen<{ id: string; generation: string; event: Json }>('claude-session-event', ({ payload }) => {
    const c = clients.get(payload.id);
    if (!c || c.generation !== payload.generation) return;
    if (payload.event.type === 'coffee_exit') clearSessionControls(payload.id, c.generation);
    if (c.connecting && !c.state.ready && payload.event.type === 'coffee_exit') { c.startupExit = text(payload.event.detail) || 'Claude process exited'; return; }
    const wasBusy = c.state.busy;
    c.state = reduceClaudeEvent(c.state, payload.event);
    if (wasBusy && !c.state.busy && payload.event.type === 'result' && payload.event.subtype === 'success'
      && payload.event.is_error !== true && !c.state.interrupted) recordSessionReply(payload.id, 'claude', c.state.nativeId);
    publish(c, ['control_request', 'result', 'coffee_exit'].includes(text(payload.event.type)));
  }));
}
export function useClaudeSession(id: string): ClaudeState {
  return useSyncExternalStore(fn => { const c = client(id); c.listeners.add(fn); return () => { c.listeners.delete(fn); }; }, () => clients.get(id)?.state ?? EMPTY, () => EMPTY);
}
export function getClaudeSession(id: string): ClaudeState { return clients.get(id)?.state ?? EMPTY; }
export function getClaudeConnection(id: string) {
  const c = clients.get(id);
  return c && c.owners > 0 ? { generation: c.generation, state: c.state, ready: c.state.ready && !c.connecting && !c.restarting, inputBusy: c.state.busy || !!c.restarting } : undefined;
}

async function readSettings(id: string, c: Client) {
  const settings = await invoke<Json>('claude_session_control', { id, generation: c.generation, request: { subtype: 'get_settings' } });
  const applied = object(settings.applied), effective = object(settings.effective);
  const selected = text(applied.model) || text(effective.model) || c.state.models[0]?.resolvedModel || 'default';
  c.state = { ...c.state, model: selected, effort: text(applied.effort) || text(applied.effortLevel) || text(effective.effortLevel), ultracode: typeof applied.ultracode === 'boolean' ? applied.ultracode : effective.ultracode === true, thinking: effective.alwaysThinkingEnabled !== false };
}

async function initializeClaude(id: string, c: Client, cwd: string | null, resumeToken?: string, ready = true) {
  await listen();
  clearSessionControls(id, c.generation);
  const controls = await readLaunchControls('claude');
  const result = await invoke<{ sessionId: string; initialization: Json; history: { data: string; cursor: number }; bypassAvailable?: boolean }>('claude_session_start', { id, generation: c.generation, cwd, resumeToken: resumeToken ?? null });
  const restoreHistory = !c.state.messages.length;
  if (restoreHistory) for (const line of result.history.data.split(/\r?\n/)) {
    try { const row = object(JSON.parse(line)); c.state = reduceClaudeEvent(c.state, row, Date.parse(text(row.timestamp)) || Date.now(), true); } catch { /* partial native row */ }
  }
  const init = result.initialization;
  c.state = { ...c.state, nativeId: result.sessionId, historyCursor: restoreHistory ? result.history.cursor : c.state.historyCursor, models: list(init.models) as ClaudeModel[], commands: list(init.commands) as ClaudeCommand[], permissionMode: text(init.current_permission_mode) || 'default', bypassAvailable: result.bypassAvailable === true };
  await readSettings(id, c);
  if (c.startupExit) throw new Error(c.startupExit);
  c.state = { ...c.state, ready, status: ready ? 'idle' : 'starting', error: undefined, errorKey: undefined };
  if (c.owners) setSessionControls(id, c.generation, controls);
  publish(c, true);
}

export function retainClaudeSession(id: string, cwd: string | null, resumeToken?: string): () => void {
  const c = client(id);
  c.cwd = cwd;
  clearTimeout(c.closeTimer); c.owners++;
  if (!c.starting) {
    c.connecting = true;
    c.starting = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await initializeClaude(id, c, cwd, resumeToken); return; }
        catch (error) {
          if (directoryFailure(error) || attempt === 2) { c.state = { ...c.state, status: 'error', error: String(error), errorKey: undefined, ready: false }; publish(c, true); return; }
          const generation = c.generation;
          clearSessionControls(id, generation);
          c.generation = crypto.randomUUID();
          await invoke('claude_session_close', { id, generation }).catch(() => {});
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          if (!c.owners) return;
          c.startupExit = undefined;
          c.state = { ...c.state, ready: false, status: 'starting', error: undefined, errorKey: undefined };
        }
      }
    })().finally(() => { c.connecting = false; });
  }
  return () => {
    c.owners--;
    if (!c.owners) c.closeTimer = setTimeout(() => {
      if (c.owners) return;
      void (c.starting ?? Promise.resolve()).finally(() => invoke('claude_session_close', { id, generation: c.generation })).catch(() => {});
      clearTimeout(c.publishTimer);
      clearSessionControls(id, c.generation);
      clients.delete(id);
    }, 300);
  };
}

export async function sendClaudeMessage(id: string, prompt: string): Promise<boolean> {
  const c = client(id);
  if (!c.state.ready || c.restarting) return false;
  const snapshot = c.state;
  const pendingId = `pending:${crypto.randomUUID()}`, now = Date.now();
  c.state = { ...c.state, busy: true, interrupted: false, pendingTurns: c.state.pendingTurns + 1, status: c.state.busy ? c.state.status : 'working', error: undefined, errorKey: undefined, startedAt: c.state.busy ? c.state.startedAt : now, endedAt: undefined,
    messages: [...c.state.messages, { id: pendingId, role: 'user', content: prompt, timestamp: now }] };
  publish(c, true);
  try { await invoke('claude_session_send', { id, generation: c.generation, text: prompt }); return true; }
  catch (error) { c.state = { ...c.state, busy: snapshot.busy, pendingTurns: Math.max(0, c.state.pendingTurns - 1), status: snapshot.status, messages: c.state.messages.filter(m => m.id !== pendingId), error: String(error), errorKey: undefined }; publish(c, true); return false; }
}

export async function loadClaudeHistory(id: string): Promise<void> {
  const c = client(id);
  if (!c.state.historyCursor || c.state.loadingHistory) return;
  c.state = { ...c.state, loadingHistory: true }; publish(c, true);
  try {
    const page = await invoke<{ data: string; cursor: number }>('claude_session_history', { id, generation: c.generation, before: c.state.historyCursor });
    let older = { ...emptyClaudeState(), orphanToolResults: c.state.orphanToolResults };
    for (const line of page.data.split(/\r?\n/)) { try { const row = object(JSON.parse(line)); older = reduceClaudeEvent(older, row, Date.parse(text(row.timestamp)) || Date.now(), true); } catch { /* partial native row */ } }
    const ids = new Set(older.messages.map(m => m.id));
    const messages = [...older.messages, ...c.state.messages.filter(m => !ids.has(m.id))];
    c.state = { ...c.state, messages, orphanToolResults: older.orphanToolResults, historyCursor: page.cursor };
  } catch (error) { c.state = { ...c.state, error: String(error), errorKey: undefined }; }
  finally { c.state = { ...c.state, loadingHistory: false }; publish(c, true); }
}

export async function controlClaude(id: string, request: Json): Promise<Json> {
  const c = client(id);
  if (!c.state.ready && (request.subtype !== 'interrupt' || !c.state.nativeId)) throw new Error('Claude 尚未就绪');
  if (request.subtype === 'set_permission_mode' && request.mode === 'bypassPermissions' && !c.state.bypassAvailable) return restartWithBypass(id, c);
  const interrupting = request.subtype === 'interrupt' && c.state.busy;
  if (interrupting) { c.state = { ...c.state, interruptRequested: true }; publish(c, true); }
  let errorKey: ClaudeState['errorKey'];
  try {
    const result = await invoke<Json>('claude_session_control', { id, generation: c.generation, request });
    const patch: Partial<ClaudeState> = request.subtype === 'interrupt' ? {} : { error: c.state.ready ? undefined : c.state.error, errorKey: c.state.ready ? undefined : c.state.errorKey };
    if (request.subtype === 'set_model') patch.model = text(request.model);
    if (request.subtype === 'set_permission_mode') patch.permissionMode = text(request.mode);
    if (request.subtype === 'apply_flag_settings') {
      const settings = object(request.settings);
      if (settings.effortLevel) patch.effort = text(settings.effortLevel);
      if (typeof settings.ultracode === 'boolean') patch.ultracode = settings.ultracode;
      if (typeof settings.alwaysThinkingEnabled === 'boolean') patch.thinking = settings.alwaysThinkingEnabled;
    }
    if (request.subtype === 'set_model' || request.subtype === 'apply_flag_settings') {
      let settings: Json;
      try { settings = await invoke<Json>('claude_session_control', { id, generation: c.generation, request: { subtype: 'get_settings' } }); }
      catch (error) { c.state = { ...c.state, ready: false }; errorKey = 'claude.error.settings_readback'; throw error; }
      const applied = object(settings.applied);
      if (typeof applied.model === 'string') patch.model = applied.model;
      if (typeof applied.effort === 'string') patch.effort = applied.effort;
      if (typeof applied.ultracode === 'boolean') patch.ultracode = applied.ultracode;
    }
    c.state = { ...c.state, ...patch }; publish(c, true); return result;
  } catch (error) { c.state = { ...c.state, ...(interrupting ? { interruptRequested: false } : {}), error: String(error), errorKey }; publish(c, true); throw error; }
}

function waitUntilIdle(c: Client): Promise<void> {
  if (!c.state.busy) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); c.listeners.delete(update); if (error) reject(error); else resolve(); };
    const update = () => { if (!c.state.busy) finish(); };
    const timer = setTimeout(() => finish(new Error('Claude did not finish interrupting the current turn')), 20000);
    c.listeners.add(update);
  });
}

function restartWithBypass(id: string, c: Client): Promise<Json> {
  if (c.restarting) return Promise.reject(new Error('Claude is restarting'));
  c.restarting = true;
  const restart = (async () => {
    let closed = false;
    const previousGeneration = c.generation;
    try {
      const config = await invoke<ToolConfigEntry>('get_tool_config', { tool: 'claude' });
      const flag = '--allow-dangerously-skip-permissions';
      if (!config.extra_args.includes(flag) && !config.command.includes(flag)) await invoke('set_tool_config', { tool: 'claude', entry: { ...config, extra_args: [...config.extra_args, flag] } });
      if (c.state.busy) { await controlClaude(id, { subtype: 'interrupt' }); await waitUntilIdle(c); }
      const previous = c.state;
      c.state = { ...c.state, ready: false, status: 'starting', error: undefined, errorKey: undefined };
      publish(c, true);
      c.generation = crypto.randomUUID();
      await invoke('claude_session_close', { id, generation: previousGeneration });
      clearSessionControls(id, previousGeneration);
      closed = true;
      // Empty sessions have no native transcript to resume yet.
      await initializeClaude(id, c, c.cwd ?? null, previous.messages.length ? previous.nativeId : undefined, false);
      const request = (request: Json) => invoke<Json>('claude_session_control', { id, generation: c.generation, request });
      if (previous.model) await request({ subtype: 'set_model', model: previous.model });
      await request({ subtype: 'apply_flag_settings', settings: { ...(previous.effort ? { effortLevel: previous.effort } : {}), ultracode: previous.ultracode, alwaysThinkingEnabled: previous.thinking } });
      const result = await request({ subtype: 'set_permission_mode', mode: 'bypassPermissions' });
      await readSettings(id, c);
      c.state = { ...c.state, ready: true, status: 'idle', permissionMode: 'bypassPermissions', bypassAvailable: true, requests: [] };
      publish(c, true);
      return result;
    } catch (error) {
      if (!closed) c.generation = previousGeneration;
      c.state = { ...c.state, ready: closed ? false : c.state.ready, error: String(error), errorKey: 'claude.error.restart' };
      publish(c, true);
      throw error;
    } finally { c.restarting = false; }
  })();
  c.starting = restart;
  return restart;
}

export async function respondClaude(id: string, requestId: string, response: Json): Promise<void> {
  const c = client(id);
  await invoke('claude_session_respond', { id, generation: c.generation, requestId, response });
  c.state = { ...c.state, requests: c.state.requests.filter(r => r.id !== requestId), status: 'working' }; publish(c, true);
}
