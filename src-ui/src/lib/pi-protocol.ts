// Pi RPC records (`pi --mode rpc`) reduced into the same conversation rows the Claude desktop
// view renders, so edits show as diffs and commands show their streamed output.
import type { ClaudeMessage, TurnStats } from './claude-protocol';

export type Json = Record<string, unknown>;
export const obj = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
export const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const str = (value: unknown): string => typeof value === 'string' ? value : '';
export const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;

export interface PiModel { provider: string; id: string; name: string; reasoning: boolean; contextWindow: number }
/** An extension dialog (`select`, `confirm`, `input`, `editor`) waiting for the user. */
export interface PiDialog { id: string; method: string; title: string; message: string; options: string[]; placeholder: string; prefill: string }
export interface PiStats { contextTokens: number | null; contextWindow: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export type PiStatus = 'working' | 'compacting' | 'retrying';
export interface PiState {
  ready: boolean;
  busy: boolean;
  sessionId: string;
  title: string;
  model: PiModel | null;
  thinkingLevel: string;
  models: PiModel[];
  messages: ClaudeMessage[];
  requests: PiDialog[];
  status: PiStatus;
  retry?: { attempt: number; maxAttempts: number };
  stats: PiStats;
  /** The run in progress, for the totals under its last row. */
  turn?: PiTurn;
  startedAt?: number;
  endedAt?: number;
  interrupted: boolean;
  error?: string;
  /** Tool calls whose arguments are still streaming, by content block. */
  streams: Record<string, { callId: string; name: string; json: string }>;
  /** Compaction began while no run was active. */
  compactingIdle?: boolean;
  /** Row key of the assistant message being streamed. */
  current?: string;
}

export const emptyPiStats = (): PiStats => ({ contextTokens: null, contextWindow: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
export function emptyPiState(): PiState {
  return { ready: false, busy: false, sessionId: '', title: '', model: null, thinkingLevel: 'off', models: [], messages: [], requests: [], status: 'working', stats: emptyPiStats(), interrupted: false, streams: {} };
}

export function piModel(value: unknown): PiModel | null {
  const model = obj(value), id = str(model.id);
  if (!id || id === 'unknown') return null;
  return { provider: str(model.provider), id, name: str(model.name) || id, reasoning: model.reasoning === true, contextWindow: num(model.contextWindow) };
}

function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content).map(obj).filter(block => block.type === 'text').map(block => str(block.text)).join('\n');
}

/** Pi's built-in tools under the names the shared tool card renders: edits become one diff, commands get input/output panes. */
export function piToolInput(name: string, args: Json): { toolName: string; input: Json } {
  const path = str(args.path);
  switch (name) {
    case 'bash': return { toolName: 'Bash', input: { command: str(args.command), description: str(args.description) } };
    case 'edit': {
      // Each replacement is matched against the original file and they never overlap, so stacking them reads as one diff.
      const edits = arr(args.edits).map(obj);
      const pairs = edits.length ? edits : [args];
      return { toolName: 'Edit', input: { file_path: path, old_string: pairs.map(e => str(e.oldText)).join('\n'), new_string: pairs.map(e => str(e.newText)).join('\n') } };
    }
    case 'write': return { toolName: 'Write', input: { file_path: path, ...(typeof args.content === 'string' ? { content: args.content } : {}) } };
    case 'read': return { toolName: 'Read', input: { file_path: path } };
    case 'grep': return { toolName: 'Grep', input: { pattern: str(args.pattern), path } };
    case 'find': return { toolName: 'Glob', input: { pattern: str(args.pattern), path } };
    case 'ls': return { toolName: 'LS', input: { path } };
    default: return { toolName: name, input: args };
  }
}

/** Partial tool arguments arrive as streamed JSON; only a complete prefix parses. */
function parseArgs(json: string): Json | undefined {
  try { return obj(JSON.parse(json)); } catch { return undefined; }
}

type Rows = ClaudeMessage[];
function upsert(rows: Rows, message: ClaudeMessage) {
  const index = rows.findIndex(row => row.id === message.id);
  if (index >= 0) rows[index] = { ...rows[index], ...message }; else rows.push(message);
}
function toolRow(rows: Rows, id: string, name: string, args: Json, timestamp: number) {
  const existing = rows.find(row => row.id === `tool:${id}`);
  const mapped = piToolInput(name, args);
  upsert(rows, { id: `tool:${id}`, role: 'tool', content: '', timestamp: existing?.timestamp ?? timestamp, toolName: mapped.toolName, input: mapped.input, toolStatus: existing?.toolStatus ?? 'running', startedAt: existing?.startedAt ?? timestamp });
}
function resultRow(rows: Rows, id: string, name: string, result: unknown, isError: boolean, timestamp: number, running = false) {
  const value = obj(result), output = blocksText(value.content);
  const existing = rows.find(row => row.id === `tool:${id}`);
  if (!existing) toolRow(rows, id, name, {}, timestamp);
  upsert(rows, { id: `tool:${id}`, role: 'tool', content: '', timestamp: existing?.timestamp ?? timestamp, output, result: value, toolStatus: running ? 'running' : isError ? 'failed' : 'done', ...(running ? {} : { endedAt: timestamp }) });
}

/** The rows of one assistant message, rebuilt from its authoritative content. */
function assistantRows(rows: Rows, message: Json, key: string, partial: boolean) {
  const timestamp = num(message.timestamp) || Date.now();
  arr(message.content).map(obj).forEach((block, index) => {
    if (block.type === 'thinking' && str(block.thinking).trim()) upsert(rows, { id: `${key}:${index}`, role: 'reasoning', content: str(block.thinking), timestamp, partial });
    else if (block.type === 'text' && str(block.text).trim()) upsert(rows, { id: `${key}:${index}`, role: 'assistant', content: str(block.text), timestamp, partial });
    else if (block.type === 'toolCall') toolRow(rows, str(block.id), str(block.name), obj(block.arguments), timestamp);
  });
  if (message.stopReason === 'error' && str(message.errorMessage).trim()) upsert(rows, { id: `${key}:error`, role: 'notice', content: str(message.errorMessage), timestamp, toolStatus: 'failed' });
}

const assistantKey = (message: Json) => `assistant:${num(message.timestamp)}`;

/** A run's usage so far: Pi reports each response's tokens and its own cost. */
export interface PiTurn { startedAt: number; lastAt: number; usage: TurnStats['usage']; cost?: number; model?: string }
const newTurn = (at: number): PiTurn => ({ startedAt: at, lastAt: at, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } });
function addUsage(turn: PiTurn, message: Json): PiTurn {
  const usage = obj(message.usage), u = turn.usage, cost = obj(usage.cost).total;
  return { ...turn, lastAt: num(message.timestamp) || turn.lastAt, model: str(message.model) || turn.model,
    usage: { ...u, input: u.input + num(usage.input), output: u.output + num(usage.output), cacheRead: u.cacheRead + num(usage.cacheRead), cacheWrite: u.cacheWrite + num(usage.cacheWrite) },
    ...(typeof cost === 'number' ? { cost: (turn.cost ?? 0) + cost } : {}) };
}
/** Puts a finished run's totals on its last row. */
function finishPiTurn(rows: Rows, turn: PiTurn | undefined, durationMs?: number): Rows {
  const at = rows.findLastIndex(row => row.role !== 'user');
  if (!turn || at < 0 || rows[at].timestamp < turn.startedAt) return rows;
  const turnStats: TurnStats = { durationMs: durationMs ?? Math.max(0, turn.lastAt - turn.startedAt), usage: turn.usage, model: turn.model, ...(turn.cost !== undefined ? { cost: turn.cost } : {}) };
  return rows.map((row, index) => index === at ? { ...row, turnStats } : row);
}

/** One persisted or live `AgentMessage`. */
export function addPiMessage(rows: Rows, value: unknown) {
  const message = obj(value), role = str(message.role), timestamp = num(message.timestamp) || Date.now();
  if (role === 'user') {
    const content = blocksText(message.content);
    if (content.trim()) upsert(rows, { id: `user:${timestamp}`, role: 'user', content, timestamp });
  } else if (role === 'assistant') assistantRows(rows, message, assistantKey(message), false);
  else if (role === 'toolResult') resultRow(rows, str(message.toolCallId), str(message.toolName), message, message.isError === true, timestamp);
  else if (role === 'bashExecution') {
    // A `!command` the user ran: shown like the agent's own command.
    const id = `bash:${timestamp}`;
    upsert(rows, { id, role: 'tool', content: '', timestamp, toolName: 'Bash', input: { command: str(message.command) }, output: str(message.output), toolStatus: num(message.exitCode) === 0 && message.cancelled !== true ? 'done' : 'failed' });
  } else if (role === 'compactionSummary') upsert(rows, { id: `compaction:${timestamp}`, role: 'notice', content: 'compacted', timestamp });
}

export function restorePiMessages(messages: unknown[], base: PiState): PiState {
  let rows: Rows = [], turn: PiTurn | undefined;
  for (const value of messages) {
    const message = obj(value), role = str(message.role), at = num(message.timestamp) || 0;
    // A prompt ends the previous run and opens the next.
    if (role === 'user') { rows = finishPiTurn(rows, turn); turn = newTurn(at); }
    addPiMessage(rows, message);
    if (turn && role === 'assistant') turn = addUsage(turn, message);
    else if (turn && at) turn = { ...turn, lastAt: at };
  }
  return { ...base, messages: finishPiTurn(rows, turn) };
}

/** Live session events and extension records. */
export function reducePiEvent(state: PiState, event: Json): PiState {
  const type = str(event.type);
  const s: PiState = { ...state };
  const rows = () => (s.messages === state.messages ? (s.messages = [...state.messages]) : s.messages);
  switch (type) {
    case 'agent_start': s.busy = true; s.status = 'working'; s.startedAt = state.busy ? state.startedAt : Date.now(); s.endedAt = undefined; s.interrupted = false; s.error = undefined; s.turn = state.busy && state.turn ? state.turn : newTurn(s.startedAt ?? Date.now()); return s;
    case 'agent_settled': s.busy = false; s.streams = {}; s.status = 'working'; s.retry = undefined; s.endedAt = Date.now(); s.interrupted = event.aborted === true;
      s.messages = finishPiTurn([...state.messages], state.turn, state.turn ? s.endedAt - state.turn.startedAt : undefined); s.turn = undefined;
      // Calls an aborted run left open will never finish.
      if (s.interrupted) s.messages = s.messages.map(row => row.toolStatus === 'running' ? { ...row, toolStatus: 'failed', interrupted: true, partial: false } : row.partial ? { ...row, partial: false } : row);
      return s;
    case 'message_start': case 'message_end': {
      const message = obj(event.message), role = str(message.role);
      if (role === 'assistant') {
        // Streamed updates carry no message; they belong to the assistant message that started last.
        if (type === 'message_start') { s.current = assistantKey(message); return s; }
        assistantRows(rows(), message, assistantKey(message), false);
        if (type === 'message_end' && s.turn) s.turn = addUsage(s.turn, message);
        const usage = obj(message.usage);
        if (usage.totalTokens !== undefined) s.stats = { ...s.stats, contextTokens: num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite) + num(usage.output) };
        return s;
      }
      // Tool results arrive through tool execution events; a user message is shown once.
      if (role === 'user' || role === 'bashExecution' || role === 'compactionSummary' || (role === 'toolResult' && type === 'message_end')) { addPiMessage(rows(), message); return s; }
      return state;
    }
    case 'message_update': {
      const update = obj(event.assistantMessageEvent), kind = str(update.type), index = num(update.contentIndex);
      const key = state.current ?? `assistant:${Date.now()}`;
      const id = `${key}:${index}`, existing = s.messages.find(row => row.id === id), now = Date.now();
      if (kind === 'text_delta') upsert(rows(), { id, role: 'assistant', content: (existing?.content ?? '') + str(update.delta), timestamp: existing?.timestamp ?? now, partial: true });
      else if (kind === 'text_end') upsert(rows(), { id, role: 'assistant', content: str(update.content) || existing?.content || '', timestamp: existing?.timestamp ?? now, partial: false });
      else if (kind === 'thinking_delta') upsert(rows(), { id, role: 'reasoning', content: (existing?.content ?? '') + str(update.delta), timestamp: existing?.timestamp ?? now, partial: true, startedAt: existing?.startedAt ?? now });
      else if (kind === 'thinking_end') upsert(rows(), { id, role: 'reasoning', content: str(update.content) || existing?.content || '', timestamp: existing?.timestamp ?? now, partial: false, endedAt: now, startedAt: existing?.startedAt ?? now });
      else if (kind === 'toolcall_start') {
        s.streams = { ...state.streams, [id]: { callId: str(update.id), name: str(update.toolName), json: '' } };
        toolRow(rows(), str(update.id), str(update.toolName), {}, now);
      } else if (kind === 'toolcall_delta') {
        const call = state.streams[id];
        if (!call) return state;
        const json = call.json + str(update.delta), args = parseArgs(json);
        s.streams = { ...state.streams, [id]: { ...call, json } };
        if (args) toolRow(rows(), call.callId, call.name, args, now);
      } else if (kind === 'toolcall_end') {
        const call = obj(update.toolCall), { [id]: _done, ...streams } = state.streams;
        void _done;
        s.streams = streams;
        toolRow(rows(), str(call.id), str(call.name), obj(call.arguments), now);
      } else return state;
      return s;
    }
    case 'tool_execution_start': toolRow(rows(), str(event.toolCallId), str(event.toolName), obj(event.args), Date.now()); return s;
    case 'tool_execution_update': resultRow(rows(), str(event.toolCallId), str(event.toolName), event.partialResult, false, Date.now(), true); return s;
    case 'tool_execution_end': resultRow(rows(), str(event.toolCallId), str(event.toolName), event.result, event.isError === true, Date.now()); return s;
    case 'compaction_start': s.status = 'compacting'; s.compactingIdle = !state.busy; s.busy = true; s.startedAt = state.busy ? state.startedAt : Date.now(); return s;
    case 'compaction_end':
      s.status = 'working';
      // A compaction started between runs (manual or on resume) ends the busy state; one inside a run does not.
      if (state.compactingIdle) { s.busy = false; s.compactingIdle = false; }
      if (event.errorMessage) upsert(rows(), { id: `compaction-error:${Date.now()}`, role: 'notice', content: str(event.errorMessage), timestamp: Date.now(), toolStatus: 'failed' });
      else if (event.result) { upsert(rows(), { id: `compaction:${Date.now()}`, role: 'notice', content: 'compacted', timestamp: Date.now() }); s.stats = { ...s.stats, contextTokens: null }; }
      return s;
    case 'auto_retry_start': s.status = 'retrying'; s.retry = { attempt: num(event.attempt), maxAttempts: num(event.maxAttempts) }; return s;
    case 'auto_retry_end': s.status = 'working'; s.retry = undefined;
      if (event.success === false && str(event.finalError)) upsert(rows(), { id: `retry-error:${Date.now()}`, role: 'notice', content: str(event.finalError), timestamp: Date.now(), toolStatus: 'failed' });
      return s;
    case 'session_info_changed': s.title = str(event.name); return s;
    case 'thinking_level_changed': s.thinkingLevel = str(event.level) || s.thinkingLevel; return s;
    case 'extension_ui_request': {
      const method = str(event.method);
      if (['select', 'confirm', 'input', 'editor'].includes(method)) {
        s.requests = [...state.requests.filter(r => r.id !== str(event.id)), { id: str(event.id), method, title: str(event.title), message: str(event.message), options: arr(event.options).map(str), placeholder: str(event.placeholder), prefill: str(event.prefill) }];
        return s;
      }
      if (method === 'notify' && str(event.message).trim()) { upsert(rows(), { id: `notify:${str(event.id)}`, role: 'notice', content: str(event.message), timestamp: Date.now(), ...(event.notifyType === 'error' ? { toolStatus: 'failed' as const } : {}) }); return s; }
      if (method === 'setTitle' && str(event.title).trim()) { s.title = str(event.title); return s; }
      return state;
    }
    case 'extension_error': upsert(rows(), { id: `extension-error:${Date.now()}`, role: 'notice', content: str(event.error), timestamp: Date.now(), toolStatus: 'failed' }); return s;
    case 'coffee_exit': return { ...state, ready: false, busy: false, requests: [], error: str(event.detail).trim() || `Pi exited (${event.code ?? 'unknown'})` };
    default: return state;
  }
}

/** Session statistics: context use and the share of input tokens served from the provider's cache. */
export function piStats(data: Json, previous: PiStats): PiStats {
  const tokens = obj(data.tokens), context = obj(data.contextUsage);
  return {
    contextTokens: context.tokens === null ? null : typeof context.tokens === 'number' ? context.tokens : previous.contextTokens,
    contextWindow: num(context.contextWindow) || previous.contextWindow,
    input: num(tokens.input), output: num(tokens.output), cacheRead: num(tokens.cacheRead), cacheWrite: num(tokens.cacheWrite), cost: num(data.cost),
  };
}

/** Cache reads as a share of all prompt tokens; undefined before any request. */
export function cacheHitRate(stats: PiStats): number | undefined {
  const prompt = stats.input + stats.cacheRead + stats.cacheWrite;
  return prompt > 0 ? stats.cacheRead / prompt : undefined;
}
