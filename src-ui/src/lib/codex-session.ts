import { useSyncExternalStore } from 'react';
import { readLaunchControls, setSessionControls, clearSessionControls } from './session-controls';
import { directoryFailure } from './session-directory';
import { recordSessionReply } from './session-replies';
import { markPromptSubmitted } from './notify-prompts';
import { invoke } from '../tauri';
import { gambitAttachments } from './gambit-attachments';
import { arr, codexColdReturn, codexSubTasks, num, obj, str, emptyCodexState, reduceCodexEvent, restoreCodexTurns, type CodexState, type CodexModel, type Json } from './codex-protocol';

interface Client { state: CodexState; generation: string; listeners: Set<() => void>; owners: number; starting?: Promise<void>; closeTimer?: ReturnType<typeof setTimeout>; publishTimer?: ReturnType<typeof setTimeout>; sending: boolean; exited?: boolean; connecting?: boolean; startupExit?: string; interruptSent?: string; permissionOverride?: Json; planPermissions?: Json; skills?: Json[] }
const clients = new Map<string, Client>();
// Tabs restarted as a new thread: which thread they continue, and the prompt waiting to be sent.
const continuations = new Map<string, { continueFrom: Json; prompt: string; planMode?: boolean }>();
const COLD_RETURN_NEVER = 'coffee:codex-cold-return-never';
const EMPTY = emptyCodexState();
let listening: Promise<unknown> | undefined;
function client(id: string): Client {
  let c = clients.get(id);
  if (!c) { c = { state: emptyCodexState(), generation: crypto.randomUUID(), listeners: new Set(), owners: 0, sending: false }; clients.set(id, c); }
  return c;
}
function publish(c: Client, immediate = false) {
  if (immediate) { clearTimeout(c.publishTimer); c.publishTimer = undefined; c.listeners.forEach(fn => fn()); }
  else if (!c.publishTimer) c.publishTimer = setTimeout(() => { c.publishTimer = undefined; c.listeners.forEach(fn => fn()); }, 40);
}
function listen() {
  return listening ??= import('@tauri-apps/api/event').then(({ listen }) => listen<{ id: string; generation: string; event: Json }>('codex-session-event', ({ payload }) => {
    const c = clients.get(payload.id); if (!c || c.generation !== payload.generation) return;
    if (payload.event.method === 'coffee/exit') { c.exited = true; clearSessionControls(payload.id, c.generation); }
    if (c.connecting && !c.state.ready && payload.event.method === 'coffee/exit') { c.startupExit = str(obj(payload.event.params).detail) || 'Codex process exited'; return; }
    const wasBusy = c.state.busy;
    c.state = reduceCodexEvent(c.state, payload.event);
    if (wasBusy && !c.state.busy && payload.event.method === 'turn/completed'
      && obj(obj(payload.event.params).turn).status === 'completed') recordSessionReply(payload.id, 'codex', c.state.nativeId);
    if (payload.event.method === 'turn/started' && c.state.interrupting) void performInterrupt(c, payload.id);
    publish(c, payload.event.id !== undefined || ['turn/completed', 'serverRequest/resolved', 'coffee/exit'].includes(str(payload.event.method)));
  }));
}
export function useCodexSession(id: string): CodexState;
export function useCodexSession<T>(id: string, select: (state: CodexState) => T): T;
export function useCodexSession(id: string, select: (state: CodexState) => unknown = state => state) {
  return useSyncExternalStore(fn => { const c = client(id); c.listeners.add(fn); return () => { c.listeners.delete(fn); }; }, () => select(clients.get(id)?.state ?? EMPTY), () => select(EMPTY));
}
export function getCodexConnection(id: string) {
  const c = clients.get(id);
  return c && c.owners > 0 ? { generation: c.generation, state: c.state, ready: c.state.ready && !c.connecting, inputBusy: c.state.busy || c.sending } : undefined;
}
function rpc(c: Client, id: string, method: string, params: Json): Promise<Json> {
  return invoke('codex_session_request', { id, generation: c.generation, method, params: { ...params, threadId: c.state.nativeId } });
}
export function retainCodexSession(id: string, cwd: string | null, resumeToken?: string): () => void {
  const c = client(id); clearTimeout(c.closeTimer); c.owners++;
  c.starting ??= (async () => {
    c.connecting = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await listen();
        clearSessionControls(id, c.generation);
        const controls = readLaunchControls('codex'), generation = c.generation;
        const result = await invoke<Json>('codex_session_start', { id, generation: c.generation, cwd, resumeToken: resumeToken ?? null, continueFrom: continuations.get(id)?.continueFrom ?? null });
        if (c.exited) throw new Error(c.startupExit || 'Codex process exited');
        const thread = obj(result.thread), history = restoreCodexTurns(arr(thread.turns));
        c.state = { ...c.state, planMode: continuations.get(id)?.planMode ?? c.state.planMode };
        const liveIds = new Set(c.state.messages.map(m => m.id));
        c.state = { ...c.state, ready: true, error: undefined, nativeId: str(thread.id), title: str(thread.name).trim() || c.state.title, threadPath: str(thread.path), lastContextTokens: num(result.lastContextTokens), model: str(result.model), effort: str(result.reasoningEffort), approvalPolicy: result.approvalPolicy, sandbox: obj(result.sandbox), models: arr(result.models) as CodexModel[], messages: [...history.filter(m => !liveIds.has(m.id)), ...c.state.messages], historyCursor: str(result.turnsBackwardsCursor) || null };
        const active = arr(thread.turns).map(obj).find(turn => turn.status === 'inProgress');
        if (active && !c.state.turnId) c.state = { ...c.state, busy: true, turnId: str(active.id) };
        void controls.then(value => {
          if (clients.get(id) === c && c.owners && c.generation === generation && c.state.ready) setSessionControls(id, generation, value);
        });
        publish(c, true);
        void rpc(c, id, 'collaborationMode/list', {}).then(result => {
          if (clients.get(id) !== c || !c.owners || !c.state.ready || c.generation !== generation) return;
          const modes = arr(result.data).map(obj);
          c.state = { ...c.state, planSupported: modes.some(mode => mode.mode === 'plan') && modes.some(mode => mode.mode === 'default') }; publish(c, true);
        }).catch(() => { /* older CLIs keep the existing chat controls */ });
        if (!c.owners) return;
        const continuation = continuations.get(id);
        if (continuation) { continuations.delete(id); if (continuation.prompt) await sendCodexMessage(id, continuation.prompt); }
        return;
      } catch (error) {
        if (directoryFailure(error) || attempt === 2) { c.state = { ...c.state, ready: false, error: String(error) }; publish(c, true); return; }
        const generation = c.generation;
        clearSessionControls(id, generation);
        c.generation = crypto.randomUUID();
        await invoke('codex_session_close', { id, generation }).catch(() => {});
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
      void (c.starting ?? Promise.resolve()).finally(() => invoke('codex_session_close', { id, generation: c.generation })).catch(() => {});
      clearTimeout(c.publishTimer); clearSessionControls(id, c.generation); continuations.delete(id); clients.delete(id);
    }, 300);
  };
}
export function configureCodex(id: string, patch: Partial<Pick<CodexState, 'model' | 'effort' | 'sandbox' | 'approvalPolicy' | 'planMode'>>): void {
  const c = client(id); if (c.state.busy || c.sending || patch.planMode === true && (!c.state.planSupported || !c.state.model)) return;
  const model = c.state.models.find(m => m.model === (patch.model ?? c.state.model));
  if (model && patch.model) patch.effort = model.supportedReasoningEfforts.some(e => e.reasoningEffort === c.state.effort) ? c.state.effort : model.defaultReasoningEffort;
  if (patch.sandbox) c.permissionOverride = { sandboxPolicy: patch.sandbox, approvalPolicy: patch.approvalPolicy };
  c.state = { ...c.state, ...patch, ...(patch.planMode !== undefined ? { planReady: undefined } : {}) }; publish(c, true);
}
export async function readCodexRateLimits(id: string): Promise<Json> {
  const c = clients.get(id);
  if (!c?.state.ready) throw new Error('Codex is not ready');
  return rpc(c, id, 'account/rateLimits/read', {});
}
export async function runCodexCommand(id: string, command: 'compact' | 'review' | 'skills' | 'mcp'): Promise<Json> {
  const c = client(id), startsTurn = command === 'compact' || command === 'review';
  if (!c.state.ready || startsTurn && (c.state.busy || c.sending)) throw new Error('Codex is not ready');
  if (startsTurn) { c.sending = true; c.interruptSent = undefined; c.state = { ...c.state, busy: true, turnId: '', interrupting: false, error: undefined }; publish(c, true); }
  try {
    const method = { compact: 'thread/compact/start', review: 'review/start', skills: 'skills/list', mcp: 'mcpServerStatus/list' }[command];
    let cursor: string | undefined;
    const data: unknown[] = [];
    do {
      const result = await rpc(c, id, method, command === 'review' ? { delivery: 'inline', target: { type: 'uncommittedChanges' } } : command === 'mcp' ? { cursor, limit: 100 } : {});
      if (startsTurn) {
        if (!c.state.turnId) c.state = { ...c.state, turnId: str(obj(result.turn).id) };
        if (c.state.interrupting) await performInterrupt(c, id);
        return result;
      }
      data.push(...arr(result.data)); cursor = command === 'mcp' ? str(result.nextCursor) || undefined : undefined;
    } while (cursor);
    if (command === 'skills') c.skills = data.flatMap(entry => arr(obj(entry).skills).map(obj)).filter(skill => skill.enabled === true);
    return { data };
  } catch (error) {
    if (startsTurn) c.state = { ...c.state, busy: false, error: String(error) };
    throw error;
  } finally { if (startsTurn) { c.sending = false; publish(c, true); } }
}
/** A person's send: a thread idle for half a day asks first, because it has very likely lost its cache. */
export async function sendCodexInteractive(id: string, prompt: string): Promise<boolean> {
  const c = client(id);
  if (c.state.coldReturn) return false;
  let dismissed = false;
  try { dismissed = localStorage.getItem(COLD_RETURN_NEVER) === '1'; } catch { /* optional preference */ }
  const cold = dismissed || prompt.startsWith('/') ? null : codexColdReturn(c.state, Date.now());
  if (!cold) return sendCodexMessage(id, prompt);
  c.state = { ...c.state, coldReturn: { ...cold, prompt } }; publish(c, true);
  return true;
}
/** Settles the held prompt in this thread; returns it so `cancel` can put it back in the composer. */
export async function settleCodexColdReturn(id: string, choice: 'full' | 'never' | 'cancel'): Promise<string> {
  const c = client(id), held = c.state.coldReturn, prompt = held?.prompt ?? '';
  c.state = { ...c.state, coldReturn: undefined }; publish(c, true);
  if (choice === 'never') { try { localStorage.setItem(COLD_RETURN_NEVER, '1'); } catch { /* optional preference */ } }
  // A session that cannot take it keeps the card, so the words are not lost.
  if (choice !== 'cancel' && prompt && !await sendCodexMessage(id, prompt)) { c.state = { ...c.state, coldReturn: held }; publish(c, true); }
  return prompt;
}
/** Prepares a lightweight continuation, forwarding only a prompt held by the cold-return card. */
export function continueCodexInNewThread(id: string, newId: string): boolean {
  const c = client(id), prompt = c.state.coldReturn?.prompt ?? '';
  if (!c.owners || !c.state.ready || c.state.busy || c.sending || !c.state.nativeId || !c.state.messages.length || c.state.requests.length || codexSubTasks(c.state).length) return false;
  const messages = c.state.messages, lastPrompt = messages.findLast(m => m.role === 'user'), reply = messages.findLast(m => m.role === 'assistant');
  continuations.set(newId, { prompt, planMode: c.state.planMode, continueFrom: { token: c.state.nativeId, path: c.state.threadPath, prompt: lastPrompt?.content ?? '', reply: reply?.content ?? '' } });
  c.state = { ...c.state, coldReturn: undefined };
  return true;
}
/** A prompt with the images it attaches and the skills it names, as `turn/start` and `turn/steer` both take it. */
function codexInput(c: Client, prompt: string) {
  const images = [...new Set(gambitAttachments(prompt).filter(a => a.image).map(a => a.path))];
  const skills = (c.skills ?? []).filter(skill => new RegExp(`\\$${str(skill.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(prompt)).map(skill => ({ type: 'skill', name: skill.name, path: skill.path }));
  return [{ type: 'text', text: prompt }, ...images.map(path => ({ type: 'localImage', path })), ...skills];
}
/** A prompt during a running turn joins it, as `turn/steer` does in Codex's own clients. */
async function steerCodex(c: Client, id: string, prompt: string): Promise<boolean> {
  if (!c.state.turnId || c.state.interrupting) return false;
  try { await rpc(c, id, 'turn/steer', { expectedTurnId: c.state.turnId, input: codexInput(c, prompt) }); return true; }
  catch (error) { c.state = { ...c.state, error: String(error) }; publish(c, true); return false; }
}
export async function sendCodexMessage(id: string, prompt: string): Promise<boolean> {
  const c = client(id);
  const planCommand = /^\/plan(?:\s+([\s\S]*))?$/.exec(prompt);
  if (planCommand) {
    if (!c.state.ready || !c.state.planSupported || !c.state.model || c.state.busy || c.sending) return false;
    configureCodex(id, { planMode: planCommand[1]?.trim() ? true : !c.state.planMode });
    if (!planCommand[1]?.trim()) return true;
    prompt = planCommand[1].trimStart();
  }
  // The chime announces a finished Codex turn only after a prompt the user sent, as in the terminal.
  if (c.state.ready && !c.sending && prompt.trim()) markPromptSubmitted(id);
  if (c.state.ready && c.state.busy && !c.sending && prompt.trim()) return steerCodex(c, id, prompt);
  if (!c.state.ready || c.state.busy || c.sending || !prompt.trim()) return false;
  c.sending = true; c.interruptSent = undefined;
  c.state = { ...c.state, busy: true, turnId: '', interrupting: false, error: undefined }; publish(c, true);
  try {
    if (c.state.planMode) c.planPermissions ??= c.permissionOverride ?? { sandboxPolicy: c.state.sandbox, approvalPolicy: c.state.approvalPolicy };
    const collaborationMode = c.state.planSupported || c.state.planMode || c.planPermissions ? { mode: c.state.planMode ? 'plan' : 'default', settings: { model: c.state.model, reasoning_effort: c.state.effort || null, developer_instructions: null } } : undefined;
    const permissions = c.state.planMode ? { sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'never' } : c.permissionOverride ?? c.planPermissions;
    const result = await rpc(c, id, 'turn/start', { input: codexInput(c, prompt), ...(c.state.model ? { model: c.state.model } : {}), ...(c.state.effort ? { effort: c.state.effort } : {}), ...(collaborationMode ? { collaborationMode } : {}), ...permissions });
    if (!c.state.planMode) c.planPermissions = undefined;
    const turn = obj(result.turn);
    if (!c.state.turnId) c.state = { ...c.state, turnId: str(turn.id) };
    if (c.state.interrupting) await performInterrupt(c, id);
    return true;
  } catch (error) { c.state = { ...c.state, busy: false, error: String(error) }; return false; }
  finally { c.sending = false; publish(c, true); }
}
/** Approval starts implementation in the same thread, restoring the user's execution permissions. */
export async function approveCodexPlan(id: string, prompt: string): Promise<boolean> {
  const c = client(id);
  if (!c.owners || !c.state.ready || !c.state.planMode || !c.state.planReady || c.state.coldReturn || c.state.busy || c.sending || c.state.requests.length) return false;
  const planReady = c.state.planReady;
  c.state = { ...c.state, planMode: false, planReady: undefined };
  if (await sendCodexMessage(id, prompt)) return true;
  c.state = { ...c.state, planMode: true, planReady }; publish(c, true);
  return false;
}
export async function interruptCodex(id: string): Promise<void> {
  const c = client(id); if (!c.state.busy || c.state.interrupting) return;
  c.state = { ...c.state, interrupting: true }; publish(c, true);
  await performInterrupt(c, id);
}
async function performInterrupt(c: Client, id: string): Promise<void> {
  if (!c.state.busy || !c.state.turnId || c.interruptSent === c.state.turnId) return;
  c.interruptSent = c.state.turnId;
  try { await rpc(c, id, 'turn/interrupt', { turnId: c.state.turnId }); }
  catch (error) { c.interruptSent = undefined; c.state = { ...c.state, interrupting: false, error: String(error) }; publish(c, true); }
}
export async function respondCodex(id: string, requestId: string | number, response: Json, reject = false): Promise<void> {
  const c = client(id);
  await invoke('codex_session_respond', { id, generation: c.generation, requestId, response, reject });
  c.state = { ...c.state, requests: c.state.requests.filter(r => r.id !== requestId) }; publish(c, true);
}
export async function loadCodexHistory(id: string): Promise<void> {
  const c = client(id); if (!c.state.historyCursor || c.state.loadingHistory) return;
  c.state = { ...c.state, loadingHistory: true }; publish(c, true);
  try {
    const page = await rpc(c, id, 'thread/turns/list', { cursor: c.state.historyCursor, itemsView: 'full', sortDirection: 'desc', limit: 20 });
    const turns = arr(page.data).reverse().map(obj), turnIds = new Set(turns.map(turn => str(turn.id)));
    const existing = new Map(c.state.messages.map(m => [m.id, m]));
    const messages = turns.flatMap(turn => {
      const restored = restoreCodexTurns([turn]), ids = new Set(restored.map(m => m.id));
      return [...restored.map(m => existing.get(m.id) ?? m), ...c.state.messages.filter(m => m.turnId === turn.id && !ids.has(m.id))];
    });
    c.state = { ...c.state, messages: [...messages, ...c.state.messages.filter(m => !turnIds.has(m.turnId))], historyCursor: str(page.nextCursor) || null };
  } catch (error) { c.state = { ...c.state, error: String(error) }; }
  finally { c.state = { ...c.state, loadingHistory: false }; publish(c, true); }
}
