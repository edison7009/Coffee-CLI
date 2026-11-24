// ACP v1 records observed from agy 1.5.16. Render through Coffee's shared conversation rows.
import type { ClaudeMessage } from './claude-protocol';
import { acpToolStep } from './step-cards';
export type Json = Record<string, unknown>;
export const obj = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
export const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export const str = (v: unknown): string => typeof v === 'string' ? v : '';
export interface AcpOption { value: string; name: string; description?: string }
export interface AcpConfig { id: string; name: string; category: string; currentValue: string; options: AcpOption[] }
export interface AcpPermission { id: string; title: string; message: string; options: { optionId: string; name: string; kind: string }[] }
export interface AntigravityState {
  ready: boolean; busy: boolean; sessionId: string; title: string; messages: ClaudeMessage[];
  requests: AcpPermission[]; configOptions: AcpConfig[]; commands: { name: string; description: string }[];
  contextTokens: number; contextWindow: number; startedAt?: number; endedAt?: number; interrupted: boolean;
  error?: string; current?: string; nextRow: number; turnStart?: number;
}
export function emptyAntigravityState(): AntigravityState {
  return { ready: false, busy: false, sessionId: '', title: '', messages: [], requests: [], configOptions: [], commands: [], contextTokens: 0, contextWindow: 0, interrupted: false, nextRow: 0 };
}
function options(v: unknown): AcpOption[] {
  return arr(v).flatMap(value => { const item = obj(value); return Array.isArray(item.options) ? options(item.options) : typeof item.value === 'string' ? [{ value: item.value, name: str(item.name) || item.value, description: str(item.description) }] : []; });
}
export function acpConfig(v: unknown): AcpConfig[] {
  return arr(v).map(obj).filter(c => c.type === 'select' && typeof c.id === 'string').map(c => ({ id: str(c.id), name: str(c.name), category: str(c.category), currentValue: str(c.currentValue), options: options(c.options) }));
}
export function initializeAntigravity(s: AntigravityState, result: Json): AntigravityState {
  return { ...s, ready: true, sessionId: str(result.sessionId), configOptions: acpConfig(result.configOptions), messages: s.messages.map(m => ({ ...m, partial: false })), current: undefined, error: undefined };
}
function text(v: unknown): string {
  const content = obj(v);
  if (content.type === 'text') return str(content.text);
  if (content.type === 'resource') return str(obj(content.resource).text) || str(obj(content.resource).uri);
  if (content.type === 'resource_link') return str(content.uri);
  if (content.type === 'image') return `[${str(content.mimeType) || 'image'}]`;
  return '';
}
export function settleAntigravity(s: AntigravityState, result: Json, error?: string): AntigravityState {
  const now = Date.now(), interrupted = result.stopReason === 'cancelled';
  const usage = obj(result.usage);
  const messages = s.messages.map(m => ({ ...m, partial: false, ...(m.toolStatus === 'running' ? { toolStatus: 'failed' as const, interrupted, endedAt: now } : {}) }));
  const last = s.turnStart === undefined ? undefined : messages.findLast((m, index) => index >= s.turnStart! && m.role === 'assistant');
  if (last && s.startedAt) last.turnStats = { durationMs: now - s.startedAt, usage: { input: Number(usage.inputTokens) || 0, output: Number(usage.outputTokens) || 0, cacheRead: Number(usage.cachedReadTokens) || 0, cacheWrite: Number(usage.cachedWriteTokens) || 0, cacheWrite1h: 0 } };
  return { ...s, busy: false, current: undefined, requests: [], messages, interrupted, endedAt: now, error };
}
export function reduceAntigravityEvent(s: AntigravityState, event: Json): AntigravityState {
  if (event.type === 'coffee_exit') return { ...settleAntigravity(s, {}, str(event.detail) || 'Antigravity process exited'), ready: false };
  const params = obj(event.params);
  if (s.sessionId && params.sessionId && params.sessionId !== s.sessionId) return s;
  if (event.method === 'session/request_permission') {
    const tool = obj(params.toolCall), id = JSON.stringify(event.id);
    return { ...s, current: undefined, requests: [...s.requests.filter(r => r.id !== id), { id, title: str(tool.title), message: arr(tool.content).map(v => text(obj(v).content)).filter(Boolean).join('\n'), options: arr(params.options).map(obj).map(o => ({ optionId: str(o.optionId), name: str(o.name), kind: str(o.kind) })) }] };
  }
  if (event.method !== 'session/update') return s;
  const update = obj(params.update), kind = str(update.sessionUpdate);
  if (kind === 'config_option_update') return { ...s, configOptions: acpConfig(update.configOptions) };
  if (kind === 'current_mode_update') return { ...s, configOptions: s.configOptions.map(c => c.category === 'mode' ? { ...c, currentValue: str(update.currentModeId) } : c) };
  if (kind === 'session_info_update') return { ...s, title: str(update.title) || s.title };
  if (kind === 'available_commands_update') return { ...s, commands: arr(update.availableCommands).map(obj).map(c => ({ name: str(c.name), description: str(c.description) })) };
  if (kind === 'usage_update') return { ...s, contextTokens: Number(update.used) || 0, contextWindow: Number(update.size) || 0 };
  const now = Date.now();
  if (['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk'].includes(kind)) {
    const role = kind === 'agent_message_chunk' ? 'assistant' : kind === 'agent_thought_chunk' ? 'reasoning' : 'user';
    const chunk = text(update.content); if (!chunk) return s;
    const old = s.messages.find(m => m.id === s.current && m.role === role);
    const id = old?.id ?? `acp:${s.nextRow}`;
    const messages = old ? s.messages.map(m => m.id === id ? { ...m, content: m.content + chunk } : m) : [...s.messages, { id, role, content: chunk, timestamp: now, partial: role !== 'user' } as ClaudeMessage];
    return { ...s, messages, current: id, nextRow: old ? s.nextRow : s.nextRow + 1 };
  }
  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const id = `tool:${str(update.toolCallId)}`, previous = s.messages.find(m => m.id === id);
    const content = arr(update.content).map(obj);
    const { toolName, input } = acpToolStep(update, previous);
    const row: ClaudeMessage = { id, role: 'tool', content: '', timestamp: previous?.timestamp ?? now, ...previous, toolName, input,
      output: update.content ? content.map(c => text(c.content)).filter(Boolean).join('\n') : typeof update.rawOutput === 'string' ? update.rawOutput : previous?.output,
      toolStatus: update.status === 'completed' ? 'done' : update.status === 'failed' ? 'failed' : previous?.toolStatus ?? 'running', startedAt: previous?.startedAt ?? now,
      ...(update.status === 'completed' || update.status === 'failed' ? { endedAt: now } : {}) };
    return { ...s, current: undefined, messages: previous ? s.messages.map(m => m.id === id ? row : m) : [...s.messages, row] };
  }
  return s;
}
