import type { ChatMessage } from './chat-transcript';

export type Json = Record<string, unknown>;
export const object = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
export const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export const text = (v: unknown): string => typeof v === 'string' ? v : '';
export const number = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0;
export function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => text(object(v).text) || resultText(object(v).content)).filter(Boolean).join('\n');
  return value == null ? '' : JSON.stringify(value, null, 2);
}

export interface ClaudeMessage extends ChatMessage {
  timestamp: number;
  /** Keeps a sent message's row mounted while its pending id becomes the native one. */
  renderKey?: string;
  partial?: boolean;
  input?: Json;
  inputJson?: string;
  output?: string;
  result?: Json;
  startedAt?: number;
  endedAt?: number;
  parentId?: string;
  streamKey?: string;
  interrupted?: boolean;
}
export interface ClaudeModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAutoMode?: boolean;
  supportsThinkingOff?: boolean;
}
export interface ClaudeCommand { name: string; description: string; argumentHint?: string }
export interface ClaudeRequest { id: string; request: Json }
export interface ClaudeBackgroundTask { id: string; type: string; description: string }
export interface ClaudeState {
  messages: ClaudeMessage[];
  ready: boolean;
  busy: boolean;
  pendingTurns: number;
  /** CLI-reported run state (session_state_changed); undefined for CLIs that do not emit it. */
  sessionState?: string;
  /** Background shells and agents still running after (or alongside) a turn. */
  backgroundTasks: ClaudeBackgroundTask[];
  status: string;
  nativeId: string;
  model: string;
  models: ClaudeModel[];
  commands: ClaudeCommand[];
  permissionMode: string;
  bypassAvailable?: boolean;
  effort: string;
  ultracode: boolean;
  thinking: boolean;
  thinkingTokens?: number;
  requests: ClaudeRequest[];
  usage: Json;
  modelUsage: Json;
  totalCost?: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  interruptRequested?: boolean;
  interrupted?: boolean;
  errorKey?: 'claude.error.request_failed' | 'claude.error.process_exited' | 'claude.error.settings_readback' | 'claude.error.restart';
  currentMessageId: string;
  contextTokens: number;
  contextWindow: number;
  historyCursor: number;
  loadingHistory?: boolean;
  orphanToolResults: Record<string, Partial<ClaudeMessage>>;
}
export function emptyClaudeState(): ClaudeState {
  return { messages: [], ready: false, busy: false, pendingTurns: 0, backgroundTasks: [], status: 'starting', nativeId: '', model: '', models: [], commands: [], permissionMode: 'default', effort: '', ultracode: false, thinking: true, requests: [], usage: {}, modelUsage: {}, currentMessageId: '', contextTokens: 0, contextWindow: 0, historyCursor: 0, orphanToolResults: {} };
}

function blockMessage(block: Json, id: string, now: number, historical: boolean): ClaudeMessage {
  const tool = block.type === 'tool_use' || block.type === 'server_tool_use';
  return {
    id: tool ? text(block.id) : id, role: tool ? 'tool' : ['thinking', 'redacted_thinking'].includes(text(block.type)) ? 'reasoning' : 'assistant',
    content: text(block.text) || text(block.thinking), timestamp: now,
    ...(tool ? { toolName: text(block.name), input: object(block.input), toolStatus: 'running' as const } : {}),
    ...(historical ? {} : { partial: true, startedAt: now }),
  };
}

/** Reduces the real wire protocol, retaining tool results and stable content-block identities.
 * Historical rows use the same content semantics without replaying live timers or usage. */
export function reduceClaudeEvent(state: ClaudeState, frame: Json, now = Date.now(), historical = false): ClaudeState {
  const s = { ...state, messages: [...state.messages] };
  const update = (id: string, change: Partial<ClaudeMessage>) => {
    const index = s.messages.findIndex(m => m.id === id);
    if (index >= 0) s.messages[index] = { ...s.messages[index], ...change };
  };
  const add = (message: ClaudeMessage) => {
    const result = s.orphanToolResults[message.id];
    s.messages.push(result ? { ...message, ...result } : message);
    if (result) { s.orphanToolResults = { ...s.orphanToolResults }; delete s.orphanToolResults[message.id]; }
  };
  const finish = (interrupted = false) => {
    s.busy = false; s.status = 'idle'; s.endedAt = now; s.thinkingTokens = undefined;
    s.messages = s.messages.map(m => m.partial || m.toolStatus === 'running'
      ? { ...m, partial: false, endedAt: m.endedAt ?? now, ...(m.toolStatus === 'running' ? { toolStatus: 'failed' as const, output: m.output || 'Interrupted', interrupted } : {}) } : m);
  };
  // An idle session can still stream side calls (idle compaction, suggestions) with no result frame;
  // they are not a turn and must neither start the working indicator nor add transcript rows.
  if (frame.type === 'stream_event' && !s.busy && s.sessionState === 'idle') return state;
  if (frame.type === 'stream_event') {
    const e = object(frame.event), block = object(e.content_block), delta = object(e.delta);
    const id = `${s.currentMessageId}:${number(e.index)}`;
    if (e.type === 'message_start') {
      if (!s.busy) s.startedAt = now;
      s.busy = true;
      s.currentMessageId = text(object(e.message).id);
      s.status = 'working';
    } else if (e.type === 'content_block_start') {
      const m = blockMessage(block, id, now, historical);
      m.streamKey = id;
      m.parentId = text(frame.parent_tool_use_id) || undefined;
      if (!s.messages.some(row => row.id === m.id)) add(m);
      s.status = m.role === 'reasoning' ? 'thinking' : m.role === 'tool' ? 'tool' : 'responding';
      if (m.role === 'reasoning') s.thinkingTokens = undefined;
    } else if (e.type === 'content_block_delta') {
      const target = s.messages.find(m => m.streamKey === id);
      if (target) {
        if (delta.type === 'text_delta' || delta.type === 'thinking_delta') update(target.id, { content: target.content + (text(delta.text) || text(delta.thinking)) });
        else if (delta.type === 'input_json_delta') {
          const inputJson = (target.inputJson ?? '') + text(delta.partial_json);
          let input = target.input; try { input = object(JSON.parse(inputJson)); } catch { /* incomplete tool arguments */ }
          update(target.id, { inputJson, input });
        }
      }
      if (delta.type === 'thinking_delta' && typeof delta.estimated_tokens === 'number') s.thinkingTokens = (s.thinkingTokens ?? 0) + delta.estimated_tokens;
    } else if (e.type === 'content_block_stop') {
      const target = s.messages.find(m => m.streamKey === id);
      if (target) update(target.id, { partial: false, endedAt: now });
    }
  } else if (frame.type === 'assistant') {
    const message = object(frame.message), mid = text(message.id) || text(frame.uuid);
    list(message.content).forEach((v, index) => {
      const b = object(v);
      const existing = b.type === 'tool_use' ? s.messages.find(m => m.id === b.id)
        : s.messages.find(m => m.id.startsWith(`${mid}:`) && m.role === (['thinking', 'redacted_thinking'].includes(text(b.type)) ? 'reasoning' : 'assistant') && (m.partial || m.content === (text(b.text) || text(b.thinking))));
      if (existing) update(existing.id, { content: text(b.text) || text(b.thinking), ...(b.input ? { input: object(b.input) } : {}) });
      else {
        const id = `${mid}:${index}:${text(b.type)}`;
        const m = { ...blockMessage(b, id, now, true), parentId: text(frame.parent_tool_use_id) || undefined };
        if (!s.messages.some(row => row.id === m.id)) add(m);
      }
    });
    if (frame.error) { s.error = text(frame.error); s.errorKey = undefined; }
  } else if (frame.type === 'user') {
    const message = object(frame.message);
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : list(message.content).map(object);
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const failed = b.is_error === true;
        const id = text(b.tool_use_id), result: Partial<ClaudeMessage> = { output: resultText(b.content), toolStatus: failed ? 'failed' : 'done', result: object(frame.tool_use_result), endedAt: now, partial: false };
        if (s.messages.some(m => m.id === id)) update(id, result);
        else s.orphanToolResults = { ...s.orphanToolResults, [id]: result };
      } else if (b.type === 'text') {
        const content = text(b.text);
        if (!content.trim() || /^(<system-reminder>|<ide_|<task-notification>|<command-|# AGENTS\.md)/.test(content)) continue;
        const pending = s.messages.findLast(m => m.role === 'user' && m.id.startsWith('pending:') && m.content === content);
        if (pending) update(pending.id, { id: text(frame.uuid) || pending.id });
        else if (!s.messages.some(m => m.id === frame.uuid)) s.messages.push({ id: text(frame.uuid) || `user:${now}:${s.messages.length}`, role: 'user', content, timestamp: now });
      }
    }
  } else if (frame.type === 'control_request') {
    s.requests = [...s.requests.filter(r => r.id !== frame.request_id), { id: text(frame.request_id), request: object(frame.request) }];
    s.status = 'requires_action';
  } else if (frame.type === 'control_cancel_request') {
    s.requests = s.requests.filter(r => r.id !== frame.request_id);
  } else if (frame.type === 'system') {
    if (frame.subtype === 'init') {
      s.nativeId = text(frame.session_id); s.model = text(frame.model); s.permissionMode = text(frame.permissionMode) || s.permissionMode;
    } else if (frame.subtype === 'thinking_tokens') s.thinkingTokens = number(frame.estimated_tokens);
    else if (frame.subtype === 'status') s.status = text(frame.status) || 'working';
    else if (frame.subtype === 'session_state_changed') {
      const value = text(frame.state);
      s.sessionState = value || undefined;
      if (value === 'requires_action') s.status = value;
      // Idle is authoritative once no sent prompt is still awaiting its result.
      else if (value === 'idle' && s.busy && !s.pendingTurns && !historical) finish();
    } else if (frame.subtype === 'background_tasks_changed' && !historical) {
      // The full current list; ambient tasks are internal and not shown, as in the official extension.
      s.backgroundTasks = list(frame.tasks).map(object).filter(task => task.ambient !== true && text(task.task_id))
        .map(task => ({ id: text(task.task_id), type: text(task.task_type), description: text(task.description) }));
    } else if (frame.subtype === 'commands_changed') s.commands = list(frame.commands).map(v => object(v) as unknown as ClaudeCommand);
  } else if (frame.type === 'tool_progress') {
    s.status = 'tool';
  } else if (frame.type === 'result') {
    const interrupted = !historical && s.interruptRequested === true;
    s.interruptRequested = false; s.interrupted = interrupted;
    finish(interrupted); s.requests = [];
    s.pendingTurns = Math.max(0, s.pendingTurns - 1);
    if (s.pendingTurns) { s.busy = true; s.status = 'working'; s.startedAt = now; s.endedAt = undefined; }
    if (!historical) {
      s.usage = object(frame.usage); s.modelUsage = object(frame.modelUsage);
      if (typeof frame.total_cost_usd === 'number') s.totalCost = frame.total_cost_usd;
      const model = object(s.modelUsage[s.model] ?? Object.values(s.modelUsage)[0]);
      s.contextWindow = number(model.contextWindow) || s.contextWindow;
      if (frame.is_error) {
        const errors = list(frame.errors).map(String);
        // Only a locally requested stop can downgrade interruption diagnostics.
        // Provider/API failures alongside them must still remain visible.
        const visible = interrupted ? errors.filter(error => !/^\[ede_diagnostic\]\s+result_type=user\s+last_content_type=n\/a\s+stop_reason=tool_use\s*$/.test(error) && !/^\[?Request interrupted by user(?: for tool use)?\]?$/.test(error)) : errors;
        if (!interrupted || !errors.length || visible.length) { s.error = visible.join('\n'); s.errorKey = s.error ? undefined : 'claude.error.request_failed'; s.error ||= 'Claude request failed'; }
      }
    }
  } else if (frame.type === 'coffee_exit') {
    const busy = s.busy; finish(); s.ready = false; s.pendingTurns = 0; s.requests = []; s.backgroundTasks = [];
    s.interruptRequested = false;
    if (number(frame.code) !== 0 || busy) { s.error = text(frame.detail); s.errorKey = s.error ? undefined : 'claude.error.process_exited'; s.error ||= 'Claude process exited'; }
  }
  const usage = frame.type === 'assistant' ? object(object(frame.message).usage) : frame.type === 'stream_event' && object(frame.event).type === 'message_start' ? object(object(object(frame.event).message).usage) : {};
  if (!historical && Object.keys(usage).length) s.contextTokens = number(usage.input_tokens) + number(usage.cache_read_input_tokens) + number(usage.cache_creation_input_tokens) + number(usage.output_tokens);
  return s;
}
