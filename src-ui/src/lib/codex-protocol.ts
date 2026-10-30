import type { ChatMessage } from './chat-transcript';

export type Json = Record<string, unknown>;
export const obj = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
export const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const str = (value: unknown): string => typeof value === 'string' ? value : '';
export const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
export const pretty = (value: unknown): string => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
export interface CodexMessage extends ChatMessage {
  turnId: string;
  item: Json;
  partial: boolean;
  timestamp: number;
  interrupted?: boolean;
}
export interface CodexModel { id: string; model: string; displayName: string; defaultReasoningEffort: string; supportedReasoningEfforts: { reasoningEffort: string; description: string }[]; hidden?: boolean }
export interface CodexRequest { id: string | number; method: string; params: Json }
export interface CodexState {
  ready: boolean; busy: boolean; nativeId: string; turnId: string;
  messages: CodexMessage[]; requests: CodexRequest[]; models: CodexModel[];
  model: string; effort: string; approvalPolicy: unknown; sandbox: Json;
  contextTokens: number; contextWindow: number; totalTokens: number;
  historyCursor: string | null; loadingHistory: boolean;
  error?: string; interrupting: boolean;
}
export function emptyCodexState(): CodexState {
  return { ready: false, busy: false, nativeId: '', turnId: '', messages: [], requests: [], models: [], model: '', effort: '', approvalPolicy: undefined, sandbox: {}, contextTokens: 0, contextWindow: 0, totalTokens: 0, historyCursor: null, loadingHistory: false, interrupting: false };
}
function itemText(item: Json): string {
  if (item.type === 'userMessage') return arr(item.content).map(value => { const part = obj(value); return str(part.text) || str(part.path) || str(part.url); }).filter(Boolean).join('\n');
  if (item.type === 'reasoning') return arr(item.summary).map(pretty).join('\n') || arr(item.content).map(pretty).join('\n');
  if (item.type === 'fileChange') return arr(item.changes).map(value => { const change = obj(value); return `${str(change.path)}\n${str(change.diff)}`; }).join('\n\n');
  return str(item.text) || str(item.aggregatedOutput) || pretty(item.result ?? item.output ?? item.error) || str(item.query);
}
export function codexMessage(item: Json, turnId: string, partial: boolean, timestamp = Date.now()): CodexMessage {
  const role = item.type === 'userMessage' ? 'user' : item.type === 'agentMessage' || item.type === 'plan' ? 'assistant' : item.type === 'reasoning' ? 'reasoning' : 'tool';
  return { id: `${turnId}:${str(item.id)}`, turnId, item, role, content: itemText(item), partial, timestamp,
    ...(role === 'tool' ? { toolName: str(item.type), toolStatus: item.status === 'inProgress' ? 'running' as const : item.status === 'failed' || item.status === 'declined' ? 'failed' as const : 'done' as const } : {}) };
}
export function restoreCodexTurns(turns: unknown[]): CodexMessage[] {
  return turns.flatMap(value => { const turn = obj(value); return arr(turn.items).map(value => { const item = obj(value); return codexMessage(item, str(turn.id), turn.status === 'inProgress' && (item.status === 'inProgress' || ['agentMessage', 'reasoning'].includes(str(item.type))), num(item.startedAtMs) || num(turn.startedAt) * 1000 || Date.now()); }); });
}
export function reduceCodexEvent(state: CodexState, event: Json): CodexState {
  const method = str(event.method), p = obj(event.params), thread = obj(p.thread);
  const threadId = str(p.threadId) || str(thread.id);
  if (state.nativeId && threadId && threadId !== state.nativeId) return state;
  const s = { ...state };
  if (event.id !== undefined && method) {
    if (typeof event.id !== 'string' && typeof event.id !== 'number') return state;
    s.requests = [...s.requests.filter(r => r.id !== event.id), { id: event.id, method, params: p }];
    return s;
  }
  const update = (id: string, change: (message: CodexMessage) => CodexMessage) => { s.messages = s.messages.map(message => message.id === id ? change(message) : message); };
  if (method === 'thread/started') s.nativeId = str(thread.id) || s.nativeId;
  else if (method === 'turn/started') { s.turnId = str(obj(p.turn).id); s.busy = true; s.error = undefined; }
  else if (method === 'item/started' || method === 'item/completed') {
    const item = obj(p.item), id = `${str(p.turnId)}:${str(item.id)}`;
    const message = codexMessage(item, str(p.turnId), method === 'item/started', num(p.startedAtMs) || Date.now());
    const previous = s.messages.find(m => m.id === id);
    if (previous) update(id, old => ({ ...message, timestamp: old.timestamp, content: message.content || old.content }));
    else s.messages = [...s.messages, message];
  } else if (method.endsWith('/delta') || method.endsWith('/outputDelta')) {
    const id = `${str(p.turnId)}:${str(p.itemId)}`;
    const kind = method.includes('/agentMessage/') ? 'agentMessage' : method.includes('/reasoning/') ? 'reasoning' : method.includes('/fileChange/') ? 'fileChange' : method.includes('/commandExecution/') ? 'commandExecution' : '';
    if (!kind) return state;
    if (!s.messages.some(m => m.id === id)) s.messages = [...s.messages, codexMessage({ id: str(p.itemId), type: kind, status: 'inProgress' }, str(p.turnId), true)];
    update(id, m => {
      // Prefer the public reasoning summary when both summary and full text arrive.
      if (method === 'item/reasoning/textDelta' && m.item.hasSummary) return m;
      const summary = method === 'item/reasoning/summaryTextDelta';
      const content = `${summary && !m.item.hasSummary ? '' : m.content}${str(p.delta)}`;
      return { ...m, item: summary ? { ...m.item, hasSummary: true } : m.item, content: m.role === 'tool' ? content.slice(-512 * 1024) : content };
    });
  } else if (method === 'turn/completed') {
    const turn = obj(p.turn), turnId = str(turn.id);
    s.messages = s.messages.map(m => m.turnId === turnId ? { ...m, partial: false, interrupted: turn.status === 'interrupted', ...(m.toolStatus === 'running' ? { toolStatus: 'failed' as const } : {}) } : m);
    s.requests = s.requests.filter(request => request.params.turnId !== turnId);
    if (!s.turnId || s.turnId === turnId) {
      s.busy = false; s.interrupting = false;
      if (turn.status === 'failed') s.error = str(obj(turn.error).message) || 'Codex turn failed';
      const status = turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'completed';
      s.messages = [...s.messages.filter(m => m.id !== `${turnId}:status`), codexMessage({ id: 'status', type: 'turnStatus', status, durationMs: turn.durationMs }, turnId, false)];
    }
  } else if (method === 'serverRequest/resolved') s.requests = s.requests.filter(r => r.id !== p.requestId);
  else if (method === 'thread/tokenUsage/updated') {
    const usage = obj(p.tokenUsage); s.contextTokens = num(obj(usage.last).totalTokens); s.contextWindow = num(usage.modelContextWindow); s.totalTokens = num(obj(usage.total).totalTokens);
  } else if (method === 'turn/plan/updated') {
    const id = `${str(p.turnId)}:plan`;
    const plan = codexMessage({ id: 'plan', type: 'plan', text: [str(p.explanation), ...arr(p.plan).map(value => { const step = obj(value); return `- ${step.status === 'completed' ? '[x]' : '[ ]'} ${str(step.step)}`; })].filter(Boolean).join('\n') }, str(p.turnId), false);
    if (s.messages.some(m => m.id === id)) update(id, () => plan);
    else s.messages = [...s.messages, plan];
  } else if (method === 'item/fileChange/patchUpdated') {
    update(`${str(p.turnId)}:${str(p.itemId)}`, m => { const item = { ...m.item, changes: p.changes }; return { ...m, item, content: itemText(item) }; });
  } else if (method === 'error' && p.willRetry !== true) s.error = str(obj(p.error).message) || pretty(p.error);
  else if (method === 'coffee/exit') { s.ready = false; s.busy = false; s.interrupting = false; s.requests = []; s.error = str(p.detail) || `Codex process exited (${p.code ?? 'unknown'})`; }
  return s;
}
