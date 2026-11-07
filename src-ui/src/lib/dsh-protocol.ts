// DeepSeek Harness Session events (persisted log rows and live SDK `session.event`
// notifications share one vocabulary) reduced into conversation rows.
import type { ClaudeMessage } from './claude-protocol';
export type Json = Record<string, unknown>;
export const obj = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
export const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const str = (value: unknown): string => typeof value === 'string' ? value : '';
export const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;

export interface DshModel { provider: string; model: string; name: string; efforts: string[] }
export interface DshRoute { provider: string; model: string; effort?: string | null }
export interface DshMessage {
  id: string;
  role: 'user' | 'assistant' | 'reasoning' | 'tool' | 'notice';
  content: string;
  turn: number;
  timestamp: number;
  toolName?: string;
  toolInput?: string;
  toolStatus?: 'running' | 'done' | 'failed';
  /** Tool result metadata; file mutations record the applied `diffs` here. */
  toolMeta?: Json;
  /** Shown from the live stream; dropped if its attempt ends without committing. */
  streaming?: boolean;
  tone?: 'info' | 'error';
}
export interface DshRequest { id: string | number; method: string; params: Json }
export interface DshState {
  ready: boolean;
  busy: boolean;
  sessionId: string;
  title: string;
  route: DshRoute;
  /** Set when the configured route is not in the configuration; the runtime runs on the built-in route until it is changed. */
  routeError?: string;
  models: DshModel[];
  preset: string;
  policy: string;
  messages: DshMessage[];
  requests: DshRequest[];
  contextTokens: number;
  contextWindow: number;
  startedAt?: number;
  error?: string;
  restarting?: boolean;
  /** The restart is a user stop, shown as stopping; a model or effort switch restarts silently. */
  stopping?: boolean;
  /** Native slash commands need `session/query` (DeepSeek Harness 0.2.2+). */
  commands: boolean;
}

export function emptyDshState(): DshState {
  return { ready: false, busy: false, sessionId: '', title: '', route: { provider: '', model: '' }, models: [], preset: '', policy: '', messages: [], requests: [], contextTokens: 0, contextWindow: 0, commands: true };
}

function text(content: unknown): string {
  return arr(content).map(obj).filter(block => block.type === 'text').map(block => str(block.text)).join('\n');
}

/** Reduces one Session event; `historical` rows replay content without live timers. */
export function reduceDshEvent(state: DshState, event: Json, historical = false): DshState {
  const s = { ...state, messages: [...state.messages] };
  const data = obj(event.data), type = str(event.type), time = num(event.time) || Date.now(), turn = num(data.turn);
  const upsert = (message: DshMessage) => {
    const index = s.messages.findIndex(m => m.id === message.id);
    if (index >= 0) s.messages[index] = { ...s.messages[index], ...message }; else s.messages.push(message);
  };
  if (type === 'session') { s.sessionId = str(event.id) || s.sessionId; return s; }
  if (type === 'user/message') {
    // Runtime context, skill catalogs and notices are model input, not the user's words.
    const source = obj(data.source);
    if (source.kind !== 'user') return state;
    const content = text(data.content);
    if (!content.trim()) return state;
    upsert({ id: `user:${str(data.id) || num(event.seq)}`, role: 'user', content, turn, timestamp: time });
  } else if (type === 'assistant/message') {
    const message = obj(data.message), id = str(message.id) || `seq-${num(event.seq)}`;
    // Streamed text and reasoning become the committed blocks in place, so the row keeps its position.
    const renamed = new Set<string>(), touched = new Set<string>();
    if (!historical) {
      s.messages = s.messages.map(m => { if (m.streaming && !m.id.startsWith(LIVE)) return { ...m, streaming: false }; if (!m.id.startsWith(LIVE)) return m; const next = `${id}:${m.id.slice(LIVE.length)}`; renamed.add(next); return { ...m, id: next, streaming: false }; });
    }
    arr(message.content).map(obj).forEach((block, index) => {
      if ((block.type === 'reasoning' || block.type === 'text') && str(block.text).trim()) touched.add(`${id}:${index}`);
      if (block.type === 'reasoning' && str(block.text).trim()) upsert({ id: `${id}:${index}`, role: 'reasoning', content: str(block.text), turn, timestamp: time });
      else if (block.type === 'text' && str(block.text).trim()) upsert({ id: `${id}:${index}`, role: 'assistant', content: str(block.text), turn, timestamp: time });
      else if (block.type === 'tool-call') {
        const existing = s.messages.find(m => m.id === `tool:${str(block.id)}`);
        upsert({ id: `tool:${str(block.id)}`, role: 'tool', content: existing?.content ?? '', turn, timestamp: time, toolName: str(block.name), toolInput: str(block.arguments), toolStatus: existing?.toolStatus ?? 'running' });
      }
    });
    // A streamed block the committed message does not carry (empty, or indexed differently) must not linger.
    if (renamed.size) s.messages = s.messages.filter(m => !renamed.has(m.id) || touched.has(m.id));
    const usage = obj(data.usage);
    if (!historical && usage.totalTokens !== undefined) s.contextTokens = num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens) + num(usage.outputTokens);
  } else if (type === 'tool/call') {
    const id = `tool:${str(data.callId)}`;
    const existing = s.messages.find(m => m.id === id);
    // A streamed row may hold partial arguments; the dispatched call carries them whole.
    if (!existing) upsert({ id, role: 'tool', content: '', turn, timestamp: time, toolName: str(data.name), toolInput: str(data.arguments), toolStatus: 'running' });
    else if (existing.toolStatus === 'running' && str(data.arguments)) upsert({ ...existing, toolName: str(data.name) || existing.toolName, toolInput: str(data.arguments) });
  } else if (type === 'tool/result') {
    const message = obj(data.message), id = `tool:${str(message.toolCallId)}`;
    const existing = s.messages.find(m => m.id === id);
    upsert({ ...(existing ?? { id, role: 'tool', turn, timestamp: time }), content: text(message.content), toolMeta: obj(data.meta), toolStatus: message.isError === true ? 'failed' : 'done' } as DshMessage);
  } else if (type === 'turn/start') {
    if (!historical) { s.busy = true; s.startedAt ??= time; }
  } else if (type === 'turn/end') {
    const reason = str(obj(data.reason).kind);
    if (reason && reason !== 'completed') upsert({ id: `turn-end:${turn}:${num(event.seq)}`, role: 'notice', content: reason, turn, timestamp: time, tone: reason === 'interrupted' ? 'info' : 'error' });
    // Tool calls left running by an interrupted turn will never settle.
    s.messages = s.messages.map(m => m.toolStatus === 'running' && m.turn === turn ? { ...m, toolStatus: 'failed' } : m);
  } else if (type === 'session/title') s.title = str(data.title) || s.title;
  else if (type === 'permission/preset') s.preset = str(data.preset) || s.preset;
  else if (type === 'approval/policy') s.policy = str(data.policy) || s.policy;
  else if (type === 'model/selection') s.route = { provider: str(data.provider) || s.route.provider, model: str(data.model) || s.route.model, effort: str(data.reasoningEffort) || null };
  else if (type === 'request/context') s.contextWindow = num(data.contextWindow) || s.contextWindow;
  else if (type === 'command/run') upsert({ id: `command:${str(data.commandId)}`, role: 'notice', content: `/${str(data.name)}${str(data.args)}`, turn, timestamp: time, tone: 'info' });
  else if (type === 'command/done') {
    const id = `command:${str(data.commandId)}`, existing = s.messages.find(m => m.id === id);
    if (existing) upsert({ ...existing, content: [existing.content, str(data.text)].filter(Boolean).join(' · '), tone: data.kind === 'success' ? 'info' : 'error' });
  } else return state;
  return s;
}

/** Live SDK traffic: Session events, agent status, server requests, and process exit. */
export function reduceDshNotification(state: DshState, frame: Json): DshState {
  const method = str(frame.method), params = obj(frame.params);
  if (frame.id !== undefined && (method === 'approval/request' || method === 'user-question/ask')) {
    return { ...state, requests: [...state.requests.filter(r => r.id !== frame.id), { id: frame.id as string | number, method, params }] };
  }
  if (method === 'user-question.cancelled') return { ...state, requests: state.requests.filter(r => r.params.requestId !== params.requestId) };
  if (method === 'session.event') {
    if (str(params.sessionId) !== state.sessionId) return state;
    return reduceDshEvent(state, obj(params.event));
  }
  if (method === 'coffee/stream' && str(params.sessionId) === state.sessionId) return reduceDshStream(state, obj(params.frame));
  if (method === 'session.status' && str(params.sessionId) === state.sessionId) {
    const busy = params.status === 'running';
    return { ...state, busy, startedAt: busy ? state.startedAt ?? Date.now() : undefined, requests: busy ? state.requests : [] };
  }
  if (method === 'coffee/exit') return { ...state, ready: false, busy: false, requests: [], error: state.restarting ? undefined : str(params.detail).trim() || `DeepSeek Harness exited (${params.code ?? 'unknown'})` };
  return state;
}

export function restoreDshLog(rows: unknown[], base = emptyDshState()): DshState {
  return rows.map(obj).reduce((state, row) => reduceDshEvent(state, row, true), base);
}

const LIVE = 'live:';

/** Live assistant-stream frames forwarded by Coffee's Host plugin: text and reasoning grow in place, tool arguments fill in as they stream. */
export function reduceDshStream(state: DshState, frame: Json): DshState {
  const type = str(frame.type);
  // A new attempt or one that ended without committing (retry, abort) drops what streamed so far.
  if (type === 'start' || type === 'end') {
    return state.messages.some(m => m.streaming) ? { ...state, messages: state.messages.filter(m => !m.streaming) } : state;
  }
  const chunk = obj(frame.chunk), kind = str(chunk.type), index = num(chunk.index);
  const turn = state.messages.at(-1)?.turn ?? 0, now = Date.now();
  const messages = [...state.messages];
  const put = (id: string, change: (old: DshMessage | undefined) => DshMessage) => {
    const at = messages.findIndex(m => m.id === id);
    if (at >= 0) messages[at] = change(messages[at]); else messages.push(change(undefined));
  };
  if (kind === 'text-delta' || kind === 'reasoning-delta') {
    const text = str(chunk.text); if (!text) return state;
    put(`${LIVE}${index}`, old => ({ id: `${LIVE}${index}`, role: kind === 'text-delta' ? 'assistant' : 'reasoning', turn, timestamp: now, ...old, streaming: true, content: (old?.content ?? '') + text }));
  } else if (kind === 'tool-call-delta') {
    const id = `tool:${str(chunk.id)}`;
    put(id, old => ({ id, role: 'tool', content: '', turn, timestamp: now, toolStatus: 'running', ...old, streaming: old ? old.streaming : true, toolName: old?.toolName || str(chunk.name), toolInput: (old?.toolInput ?? '') + str(chunk.argumentsDelta) }));
  } else return state;
  return { ...state, messages };
}

/** The hunks a settled file mutation actually applied, from its result metadata. */
function appliedDiffs(meta: Json | undefined): { path: string; oldText: string; newText: string }[] {
  return arr(meta?.diffs).map(obj).filter(hunk => typeof hunk.path === 'string' && typeof hunk.newText === 'string')
    .map(hunk => ({ path: str(hunk.path), oldText: str(hunk.oldText), newText: str(hunk.newText) }));
}

/** A DeepSeek Harness tool call under the names the shared tool card renders: edits become a diff, commands get input/output panes. */
export function dshToolMessage(message: DshMessage): ClaudeMessage {
  let args: Json = {};
  try { args = obj(JSON.parse(message.toolInput ?? '')); } catch { /* Streamed or malformed arguments render as the generic card. */ }
  const name = message.toolName ?? '', path = str(args.file_path) || str(args.path);
  const settled = message.toolStatus === 'done' ? appliedDiffs(message.toolMeta) : [];
  const diff = (fallback: { old_string: string; new_string: string }) => settled.length
    // Applied hunks are what landed on disk; prefer them over the requested replacement.
    ? { file_path: path || settled[0].path, old_string: settled.map(h => h.oldText).join('\n'), new_string: settled.map(h => h.newText).join('\n') }
    : { file_path: path, ...fallback };
  let toolName = name, input: Json = args;
  switch (name) {
    case 'bash': case 'pwsh': toolName = 'Bash'; input = { command: str(args.command), description: str(args.description) }; break;
    case 'edit': toolName = 'Edit'; input = diff({ old_string: str(args.old_string), new_string: str(args.new_string) }); break;
    case 'apply_patch': if (settled.length) { toolName = 'Edit'; input = diff({ old_string: '', new_string: '' }); } break;
    case 'write': toolName = 'Write'; input = { file_path: path, ...(typeof args.content === 'string' ? { content: args.content } : {}) }; break;
    case 'str_replace_editor':
      if (args.command === 'create') { toolName = 'Write'; input = { file_path: path, content: str(args.file_text) }; }
      else if (args.command === 'str_replace') { toolName = 'Edit'; input = { file_path: path, old_string: str(args.old_str), new_string: str(args.new_str) }; }
      break;
    case 'read': case 'read_image': toolName = 'Read'; input = { file_path: path }; break;
    case 'grep': toolName = 'Grep'; input = { pattern: str(args.pattern), path }; break;
    case 'glob': toolName = 'Glob'; input = { pattern: str(args.pattern), path }; break;
  }
  const settledAt = message.toolStatus === 'running' ? undefined : message.timestamp;
  return { id: message.id, role: 'tool', content: '', timestamp: message.timestamp, toolName, input, toolStatus: message.toolStatus ?? 'running',
    ...(message.toolStatus && message.toolStatus !== 'running' ? { output: message.content, endedAt: settledAt } : {}) };
}
