// OpenCode v2 session events reduced into its own message timeline. The reducer mirrors the
// projector in OpenCode's client (`packages/client/src/solid/data.ts`) so live events and the
// `/message` history read land on the same shape; `openCodeRows` then flattens it for display.
import type { ChatMessage } from './chat-transcript';

export type Json = Record<string, unknown>;
export const obj = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
export const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const str = (value: unknown): string => typeof value === 'string' ? value : '';
export const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
export const pretty = (value: unknown): string => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);

export interface OpenCodeModel { id: string; providerID: string; name: string; variants: string[]; context?: number }
export interface OpenCodeAgent { id: string; name: string; description?: string; mode?: string; hidden?: boolean }
export interface OpenCodeModelRef { id: string; providerID: string; variant?: string }
export interface OpenCodeCommand { name: string; description?: string }
export interface OpenCodeState {
  ready: boolean; busy: boolean; nativeId: string; title: string;
  /** OpenCode's own message timeline, oldest first. */
  native: Json[];
  permissions: Json[]; forms: Json[];
  models: OpenCodeModel[]; agents: OpenCodeAgent[]; commands: OpenCodeCommand[];
  model: OpenCodeModelRef | null; agent: string;
  contextTokens: number; totalTokens: number;
  cursor: string | null; loadingHistory: boolean;
  startedAt?: number; error?: string; interrupting: boolean;
}
export function emptyOpenCodeState(): OpenCodeState {
  return { ready: false, busy: false, nativeId: '', title: '', native: [], permissions: [], forms: [], models: [], agents: [], commands: [], model: null, agent: '', contextTokens: 0, totalTokens: 0, cursor: null, loadingHistory: false, interrupting: false };
}

/** Prompt, reasoning, output and cache tokens of the latest finished step fill the context window. */
export function stepContext(tokens: unknown): number {
  const t = obj(tokens), cache = obj(t.cache);
  return num(t.input) + num(t.output) + num(t.reasoning) + num(cache.read) + num(cache.write);
}
export function lastContextTokens(native: Json[]): number {
  for (let i = native.length - 1; i >= 0; i--) if (native[i].type === 'assistant' && native[i].tokens) return stepContext(native[i].tokens);
  return 0;
}

const RUNNING = new Set(['streaming', 'running']);
function editAssistant(native: Json[], id: string, edit: (message: Json, content: Json[]) => void): Json[] {
  const index = native.findLastIndex(m => m.id === id && m.type === 'assistant');
  if (index < 0) return native;
  const message = { ...native[index] }, content = arr(message.content).map(obj).map(part => ({ ...part }));
  edit(message, content);
  message.content = content;
  const next = [...native]; next[index] = message; return next;
}
const lastPart = (content: Json[], type: string, id?: string) => {
  for (let i = content.length - 1; i >= 0; i--) if (content[i].type === type && (id === undefined || content[i].id === id)) return content[i];
};
function upsert(native: Json[], message: Json): Json[] {
  const index = native.findIndex(m => m.id === message.id);
  if (index < 0) return [...native, message];
  const next = [...native]; next[index] = { ...native[index], ...message }; return next;
}

export function reduceOpenCodeEvent(state: OpenCodeState, event: Json): OpenCodeState {
  const type = str(event.type), data = obj(event.data), created = num(event.created) || Date.now();
  if (type !== 'coffee.exit' && str(data.sessionID || obj(data.form).sessionID) !== state.nativeId) return state;
  const s = { ...state };
  const assistantId = str(data.assistantMessageID);
  switch (type) {
    case 'session.renamed': s.title = str(data.title); break;
    case 'session.agent.selected': s.agent = str(data.agent) || s.agent; break;
    case 'session.model.selected': { const model = obj(data.model); if (model.id) s.model = { id: str(model.id), providerID: str(model.providerID), ...(model.variant ? { variant: str(model.variant) } : {}) }; break; }
    case 'session.usage.updated': s.totalTokens = stepContext(data.tokens) || s.totalTokens; break;
    case 'session.inbox.enqueued': {
      const item = obj(data.item);
      // Prompts steered in while a turn runs wait in the inbox; they join the transcript as the user wrote them.
      if (item.type === 'user') s.native = upsert(s.native, { id: str(data.inboxID), type: 'user', ...obj(item.payload), time: { created }, pending: true });
      break;
    }
    case 'session.inbox.delivered': {
      const index = s.native.findIndex(m => m.id === data.inboxID);
      if (index >= 0) { const message = { ...s.native[index], pending: false, time: { created } }; s.native = [...s.native.slice(0, index), ...s.native.slice(index + 1), message]; }
      break;
    }
    case 'session.inbox.cancelled': s.native = s.native.filter(m => m.id !== data.inboxID); break;
    case 'session.synthetic': s.native = [...s.native, { id: str(event.id), type: 'synthetic', text: data.text, description: data.description, time: { created } }]; break;
    case 'session.shell.started': { const shell = obj(data.shell); s.native = [...s.native, { id: str(event.id), type: 'shell', shellID: shell.id, command: shell.command, status: shell.status, time: { created } }]; break; }
    case 'session.shell.ended': {
      const shell = obj(data.shell), index = s.native.findLastIndex(m => m.type === 'shell' && m.shellID === shell.id);
      if (index >= 0) { s.native = [...s.native]; s.native[index] = { ...s.native[index], status: shell.status, exit: shell.exit, output: data.output, time: { ...obj(s.native[index].time), completed: created } }; }
      break;
    }
    case 'session.execution.started': s.busy = true; s.startedAt ??= created; s.error = undefined; break;
    case 'session.step.started': {
      const existing = s.native.find(m => m.id === assistantId && m.type === 'assistant');
      if (existing) s.native = editAssistant(s.native, assistantId, message => { message.agent = data.agent; message.model = data.model; message.error = undefined; message.retry = undefined; message.finish = undefined; message.time = { created: num(data.started) || created }; });
      else s.native = [...s.native, { id: assistantId, type: 'assistant', agent: data.agent, model: data.model, content: [], time: { created: num(data.started) || created } }];
      break;
    }
    case 'session.step.ended': case 'session.step.failed':
      s.native = editAssistant(s.native, assistantId, message => {
        message.time = { ...obj(message.time), completed: created };
        message.finish = data.finish ?? (type === 'session.step.failed' ? 'error' : undefined);
        if (data.tokens) message.tokens = data.tokens;
        if (type === 'session.step.failed') { message.error = data.error; message.retry = undefined; }
      });
      if (data.tokens) s.contextTokens = stepContext(data.tokens);
      break;
    case 'session.retry.scheduled': s.native = editAssistant(s.native, assistantId, message => { message.retry = { attempt: data.attempt, at: data.at, error: data.error }; }); break;
    case 'session.text.started': s.native = editAssistant(s.native, assistantId, (_, content) => { content.push({ type: 'text', text: '' }); }); break;
    case 'session.text.delta': s.native = editAssistant(s.native, assistantId, (_, content) => { const part = lastPart(content, 'text'); if (part) part.text = str(part.text) + str(data.delta); }); break;
    case 'session.text.ended': s.native = editAssistant(s.native, assistantId, (_, content) => { const part = lastPart(content, 'text'); if (part) part.text = str(data.text); }); break;
    case 'session.reasoning.started': s.native = editAssistant(s.native, assistantId, (_, content) => { content.push({ type: 'reasoning', text: '', time: { created } }); }); break;
    case 'session.reasoning.delta': s.native = editAssistant(s.native, assistantId, (_, content) => { const part = lastPart(content, 'reasoning'); if (part) part.text = str(part.text) + str(data.delta); }); break;
    case 'session.reasoning.ended': s.native = editAssistant(s.native, assistantId, (_, content) => { const part = lastPart(content, 'reasoning'); if (part) { part.text = str(data.text); part.time = { ...obj(part.time), completed: created }; } }); break;
    case 'session.tool.input.started': s.native = editAssistant(s.native, assistantId, (_, content) => { content.push({ type: 'tool', id: data.id, name: data.name, time: { created }, state: { status: 'streaming', input: '' } }); }); break;
    case 'session.tool.input.delta': case 'session.tool.input.ended':
      s.native = editAssistant(s.native, assistantId, (_, content) => {
        const part = lastPart(content, 'tool', str(data.id)), state = obj(part?.state);
        if (part && state.status === 'streaming') part.state = { ...state, input: type === 'session.tool.input.ended' ? str(data.text) : str(state.input) + str(data.delta) };
      });
      break;
    case 'session.tool.called': s.native = editAssistant(s.native, assistantId, (_, content) => { const part = lastPart(content, 'tool', str(data.id)); if (part) { part.state = { status: 'running', input: obj(data.input), metadata: {} }; part.time = { ...obj(part.time), ran: created }; } }); break;
    case 'session.tool.progress': s.native = editAssistant(s.native, assistantId, (_, content) => { const part = lastPart(content, 'tool', str(data.id)), state = obj(part?.state); if (part && state.status === 'running') part.state = { ...state, metadata: data.metadata }; }); break;
    case 'session.tool.success': case 'session.tool.failed':
      s.native = editAssistant(s.native, assistantId, (_, content) => {
        const part = lastPart(content, 'tool', str(data.id)), state = obj(part?.state);
        if (!part || !RUNNING.has(str(state.status))) return;
        const input = typeof state.input === 'string' ? {} : state.input;
        part.state = type === 'session.tool.success' ? { status: 'completed', input, metadata: data.metadata, content: data.content } : { status: 'error', input, error: data.error, metadata: data.metadata, content: data.content };
        part.time = { ...obj(part.time), completed: created };
      });
      break;
    case 'session.compaction.started': s.native = [...s.native, { id: str(data.inputID) || str(event.id), type: 'compaction', status: 'running', reason: data.reason, summary: '', time: { created } }]; break;
    case 'session.compaction.delta': { const index = s.native.findLastIndex(m => m.type === 'compaction' && m.status === 'running'); if (index >= 0) { s.native = [...s.native]; s.native[index] = { ...s.native[index], summary: str(s.native[index].summary) + str(data.text) }; } break; }
    case 'session.compaction.ended': case 'session.compaction.failed': {
      const index = s.native.findLastIndex(m => m.type === 'compaction' && m.status === 'running');
      const settled = { type: 'compaction', status: type === 'session.compaction.ended' ? 'completed' : 'failed', reason: data.reason, summary: str(data.text), error: data.error };
      if (index >= 0) { s.native = [...s.native]; s.native[index] = { ...s.native[index], ...settled }; }
      else s.native = [...s.native, { id: str(event.id), ...settled, time: { created } }];
      break;
    }
    case 'session.execution.succeeded': case 'session.execution.failed': case 'session.execution.interrupted': {
      s.busy = false; s.interrupting = false; s.startedAt = undefined;
      // Tool calls left open by an interrupted or failed execution will not settle.
      s.native = s.native.map(m => m.type !== 'assistant' || !arr(m.content).some(p => RUNNING.has(str(obj(obj(p).state).status))) ? m
        : { ...m, content: arr(m.content).map(obj).map(p => RUNNING.has(str(obj(p.state).status)) ? { ...p, state: { ...obj(p.state), status: 'error', input: typeof obj(p.state).input === 'string' ? {} : obj(p.state).input } } : p) });
      if (type === 'session.execution.interrupted' && data.reason === 'shutdown') break;
      const outcome = type === 'session.execution.succeeded' ? 'succeeded' : type === 'session.execution.failed' ? 'failed' : 'interrupted';
      s.native = [...s.native, { id: str(event.id), type: 'idle', outcome, ...(outcome === 'failed' ? { error: data.error } : {}), time: { created } }];
      if (outcome === 'failed') s.error = errorText(data.error) || 'OpenCode turn failed';
      s.permissions = []; s.forms = [];
      break;
    }
    case 'permission.asked': if (!s.permissions.some(p => p.id === data.id)) s.permissions = [...s.permissions, data]; break;
    case 'permission.replied': s.permissions = s.permissions.filter(p => p.id !== data.requestID); break;
    case 'form.created': { const form = obj(data.form); if (!s.forms.some(f => f.id === form.id)) s.forms = [...s.forms, form]; break; }
    case 'form.replied': case 'form.cancelled': s.forms = s.forms.filter(f => f.id !== data.id); break;
    case 'coffee.exit': s.ready = false; s.busy = false; s.interrupting = false; s.permissions = []; s.forms = []; s.error = str(data.detail).trim() || `OpenCode exited (${data.code ?? 'unknown'})`; break;
    default: return state;
  }
  return s;
}

export function errorText(error: unknown): string {
  const e = obj(error);
  return str(e.message) || str(obj(e.data).message) || str(e.type);
}

export interface OpenCodeRow extends ChatMessage {
  role: 'user' | 'assistant' | 'reasoning' | 'tool';
  /** Turn index: one turn runs from a prompt to the next idle marker. */
  turn: number;
  timestamp: number;
  partial: boolean;
  /** `idle` rows close a turn; `notice` rows are compaction, shell and retry lines. */
  kind?: 'idle' | 'notice';
  outcome?: string;
  durationMs?: number;
  title?: string;
  input?: unknown;
  output?: string;
  pending?: boolean;
  files?: string[];
}

/** First string argument of a tool call: its path, command or query. */
function toolSummary(input: unknown): string {
  if (typeof input === 'string') { try { return toolSummary(JSON.parse(input)); } catch { return input.slice(0, 200); } }
  const value = obj(input);
  for (const key of ['description', 'filePath', 'path', 'command', 'pattern', 'query', 'url', 'code']) if (typeof value[key] === 'string' && value[key]) return str(value[key]).split('\n')[0].slice(0, 200);
  return str(Object.values(value).find(v => typeof v === 'string')).split('\n')[0].slice(0, 200);
}
function contentText(content: unknown): string {
  return arr(content).map(obj).map(part => part.type === 'text' ? str(part.text) : str(part.filename) || str(part.name) || str(part.uri)).filter(Boolean).join('\n');
}

const cache = new WeakMap<Json, OpenCodeRow[]>();
function rowsOf(message: Json, turn: number, busy: boolean): OpenCodeRow[] {
  const cached = cache.get(message);
  if (cached && cached[0]?.turn === turn && !busy) return cached;
  const time = obj(message.time), timestamp = num(time.created) || Date.now(), id = str(message.id);
  let rows: OpenCodeRow[] = [];
  if (message.type === 'user') {
    const files = arr(message.files).map(obj).map(f => str(f.name) || str(f.filename) || str(f.uri)).filter(Boolean);
    rows = [{ id, role: 'user', content: str(obj(message.metadata).displayText) || str(message.text), turn, timestamp, partial: false, pending: message.pending === true, files }];
  } else if (message.type === 'assistant') {
    const open = !time.completed;
    rows = arr(message.content).map(obj).flatMap((part, index): OpenCodeRow[] => {
      const partId = `${id}:${index}`;
      if (part.type === 'text') return str(part.text) ? [{ id: partId, role: 'assistant', content: str(part.text), turn, timestamp, partial: open }] : [];
      if (part.type === 'reasoning') return str(part.text).trim() ? [{ id: partId, role: 'reasoning', content: str(part.text), turn, timestamp: num(obj(part.time).created) || timestamp, partial: !obj(part.time).completed && open }] : [];
      if (part.type !== 'tool') return [];
      const state = obj(part.state), status = str(state.status);
      const output = status === 'error' ? [errorText(state.error), contentText(state.content)].filter(Boolean).join('\n') : contentText(state.content);
      return [{ id: str(part.id) ? `${id}:tool:${str(part.id)}` : partId, role: 'tool', content: output, turn, timestamp: num(obj(part.time).created) || timestamp, partial: RUNNING.has(status),
        toolName: str(part.name), toolStatus: RUNNING.has(status) ? 'running' : status === 'error' ? 'failed' : 'done', title: toolSummary(state.input), input: state.input, output }];
    });
    const error = errorText(message.error);
    if (error) rows.push({ id: `${id}:error`, role: 'assistant', kind: 'notice', content: error, turn, timestamp, partial: false, outcome: 'failed' });
  } else if (message.type === 'shell') {
    rows = [{ id, role: 'tool', content: str(obj(message.output).text) || pretty(message.output), turn, timestamp, partial: message.status === 'running', toolName: 'shell', toolStatus: message.status === 'running' ? 'running' : num(message.exit) ? 'failed' : 'done', title: str(message.command) }];
  } else if (message.type === 'synthetic') {
    rows = [{ id, role: 'tool', content: str(message.text), turn, timestamp, partial: false, toolName: 'synthetic', toolStatus: 'done', title: str(message.description) }];
  } else if (message.type === 'compaction') {
    rows = [{ id, role: 'assistant', kind: 'notice', content: str(message.summary), turn, timestamp, partial: message.status === 'running', outcome: `compaction:${str(message.status)}` }];
  } else if (message.type === 'idle') {
    rows = [{ id, role: 'assistant', kind: 'idle', content: '', turn, timestamp, partial: false, outcome: str(message.outcome) }];
  }
  if (!busy) cache.set(message, rows);
  return rows;
}

/** Display rows, oldest first; each idle row carries its turn's duration. */
export function openCodeRows(native: Json[]): OpenCodeRow[] {
  const rows: OpenCodeRow[] = [];
  let turn = 0, started = 0;
  for (const message of native) {
    if (message.type === 'user' && !started) started = num(obj(message.time).created);
    const busy = message.type === 'assistant' && !obj(message.time).completed;
    for (const row of rowsOf(message, turn, busy)) rows.push(row.kind === 'idle' && started ? { ...row, durationMs: row.timestamp - started } : row);
    if (message.type === 'idle') { turn++; started = 0; }
  }
  return rows;
}
