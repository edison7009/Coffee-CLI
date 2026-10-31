// DeepSeek Harness Session events (persisted log rows and live SDK `session.event`
// notifications share one vocabulary) reduced into conversation rows.
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
  tone?: 'info' | 'error';
}
export interface DshRequest { id: string | number; method: string; params: Json }
export interface DshState {
  ready: boolean;
  busy: boolean;
  sessionId: string;
  title: string;
  route: DshRoute;
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
    arr(message.content).map(obj).forEach((block, index) => {
      if (block.type === 'reasoning' && str(block.text).trim()) upsert({ id: `${id}:${index}`, role: 'reasoning', content: str(block.text), turn, timestamp: time });
      else if (block.type === 'text' && str(block.text).trim()) upsert({ id: `${id}:${index}`, role: 'assistant', content: str(block.text), turn, timestamp: time });
      else if (block.type === 'tool-call') {
        const existing = s.messages.find(m => m.id === `tool:${str(block.id)}`);
        upsert({ id: `tool:${str(block.id)}`, role: 'tool', content: existing?.content ?? '', turn, timestamp: time, toolName: str(block.name), toolInput: str(block.arguments), toolStatus: existing?.toolStatus ?? 'running' });
      }
    });
    const usage = obj(data.usage);
    if (!historical && usage.totalTokens !== undefined) s.contextTokens = num(usage.inputTokens) + num(usage.cacheReadTokens) + num(usage.cacheWriteTokens) + num(usage.outputTokens);
  } else if (type === 'tool/call') {
    const id = `tool:${str(data.callId)}`;
    if (!s.messages.some(m => m.id === id)) upsert({ id, role: 'tool', content: '', turn, timestamp: time, toolName: str(data.name), toolInput: str(data.arguments), toolStatus: 'running' });
  } else if (type === 'tool/result') {
    const message = obj(data.message), id = `tool:${str(message.toolCallId)}`;
    const existing = s.messages.find(m => m.id === id);
    upsert({ ...(existing ?? { id, role: 'tool', turn, timestamp: time }), content: text(message.content), toolStatus: message.isError === true ? 'failed' : 'done' } as DshMessage);
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
