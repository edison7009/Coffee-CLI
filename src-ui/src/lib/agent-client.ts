import { useSyncExternalStore } from 'react';
import { invoke } from '../tauri';
import type { I18nKey } from '../i18n/en';

type AgentTranslator = (key: I18nKey, vars?: Record<string, string | number>) => string;

export function formatAgentActivity(activity: string, t: AgentTranslator): string {
  const toolPrefix = '正在操作：';
  if (activity.startsWith(toolPrefix)) return t('agent.activity.operating', { tool: activity.slice(toolPrefix.length) });
  switch (activity) {
    case '正在思考…': return t('agent.activity.thinking');
    case '正在连接模型…': return t('agent.activity.connecting');
    case '正在整理前文…':
    case '正在整理前文，完整历史仍保留…': return t('agent.activity.context');
    default: return activity;
  }
}

export function formatAgentError(error: string, t: AgentTranslator): string {
  const message = error.startsWith('Error: ') ? error.slice(7) : error;
  switch (message) {
    case '请求失败': return t('agent.error.request_failed');
    case '请先在 Agent 配置中填写服务地址': return t('agent.error.url_required');
    case '请先在 Agent 配置中填写模型 ID': return t('agent.error.model_required');
    case '请先在 Agent 配置中填写 API 密钥': return t('agent.error.api_key_required');
    case 'Agent 正在处理上一条消息':
    case '请先停止当前身份正在执行的 Agent 请求，再开始新对话':
    case '这个身份的 Agent 正在处理上一条请求，请先等待完成或取消': return t('agent.error.busy');
    default: return error;
  }
}

export function formatAgentMessage(message: string, t: AgentTranslator): string {
  if (message === 'Agent 请求已取消；已经提交的终端任务可能继续运行。') return t('agent.chat.cancelled');
  const prefix = 'Agent 请求未完成：';
  if (message.startsWith(prefix)) return t('agent.chat.incomplete', { error: formatAgentError(message.slice(prefix.length), t) });
  return message;
}

export interface AgentMessage { id: number; role: 'user' | 'assistant'; text: string; tools?: { name: string; ok: boolean }[] }
export interface AgentConversation { id: string; route: string; source: string; title: string; updatedAt: number; messageCount: number }
interface ConversationPage { id: string; route: string; messages: AgentMessage[]; hasOlder: boolean; runId: string | null }
export interface ChannelSettings {
  telegram: { enabled: boolean; botName?: string; allowedUserId?: string; hasToken?: boolean };
  weixin: { enabled: boolean; accountId?: string; allowedUserId?: string };
  status: { telegram: string; weixin: string; telegramError?: string; weixinError?: string };
}
export interface AgentEvent { conversationId: string; runId: string; kind: string; text?: string; tool?: string }
interface Snapshot {
  conversationId: string;
  route: string;
  conversations: AgentConversation[];
  hasOlder: boolean;
  loadingOlder: boolean;
  messages: AgentMessage[];
  running: boolean;
  activity: string;
  error: string;
  channels: ChannelSettings | null;
}
let snapshot: Snapshot = { conversationId: '', route: 'desktop', conversations: [], hasOlder: false, loadingOlder: false, messages: [], running: false, activity: '', error: '', channels: null };
let conversationRevision = 0;
let channelRevision = 0;
const listeners = new Set<() => void>();
const runs = new Map<string, string>();
let listRequest = 0;
function update(patch: Partial<Snapshot>) {
  if (patch.messages) conversationRevision++;
  if (patch.channels) channelRevision++;
  snapshot = { ...snapshot, ...patch };
  listeners.forEach(listener => listener());
}
export function useAgentClient() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => snapshot);
}
export async function refreshAgentConversation() {
  const revision = conversationRevision;
  const target = snapshot.conversationId || 'desktop';
  const run = currentRun;
  const error = snapshot.error;
  const lastStoredId = snapshot.messages.reduce((id, message) => Math.max(id, message.id), 0);
  const page = await invoke<ConversationPage>('agent_get_conversation', { conversationId: target });
  if (revision === conversationRevision && target === (snapshot.conversationId || 'desktop')) {
    const lastMessage = page.messages.at(-1);
    const errorRecorded = error && snapshot.error === error && currentRun === run
      && !runs.has(page.id) && !page.runId && lastMessage && lastMessage.id > lastStoredId
      && lastMessage.role === 'assistant' && lastMessage.text === `Agent 请求未完成：${error}`;
    currentRun = runs.get(page.id) ?? page.runId ?? '';
    update({ conversationId: page.id, route: page.route, messages: page.messages, hasOlder: page.hasOlder, running: !!currentRun, ...(errorRecorded ? { error: '' } : {}) });
  }
}
export async function refreshAgentConversations() {
  const request = ++listRequest;
  const conversations = await invoke<AgentConversation[]>('agent_list_conversations');
  if (request === listRequest) update({ conversations });
}
export function receiveConversationChanged(id: string) {
  refreshAgentConversations().catch(() => {});
  if (snapshot.conversationId === id && !snapshot.running) refreshAgentConversation().catch(() => {});
}
export async function openAgentConversation(id: string) {
  currentRun = runs.get(id) ?? '';
  replyIndex = -1;
  update({ conversationId: id, messages: [], running: !!currentRun, hasOlder: false, loadingOlder: false, activity: '', error: '' });
  try { await refreshAgentConversation(); }
  catch (error) { if (snapshot.conversationId === id) update({ error: String(error) }); throw error; }
}
export async function loadOlderAgentMessages() {
  if (!snapshot.hasOlder || snapshot.loadingOlder || !snapshot.messages[0]) return;
  const id = snapshot.conversationId;
  const before = snapshot.messages[0].id;
  update({ loadingOlder: true });
  try {
    const page = await invoke<ConversationPage>('agent_get_conversation', { conversationId: id, before });
    if (snapshot.conversationId === id && snapshot.messages[0]?.id === before) {
      if (replyIndex >= 0) replyIndex += page.messages.length;
      update({ messages: [...page.messages, ...snapshot.messages], hasOlder: page.hasOlder });
    }
  } finally { if (snapshot.conversationId === id) update({ loadingOlder: false }); }
}
export async function refreshChannels() {
  const revision = channelRevision;
  const channels = await invoke<ChannelSettings>('channel_get_settings');
  if (revision === channelRevision) update({ channels });
}
export function receiveChannelStatus(channels: ChannelSettings) { update({ channels }); }
let currentRun = '';
let replyIndex = -1;
export function receiveAgentEvent(event: AgentEvent) {
  if (event.kind === 'started') runs.set(event.conversationId, event.runId);
  if (['done', 'error', 'cancelled'].includes(event.kind)) {
    if (runs.get(event.conversationId) === event.runId) runs.delete(event.conversationId);
    refreshAgentConversations().catch(() => {});
  }
  if (event.conversationId !== snapshot.conversationId) return;
  if (event.kind === 'started') {
    currentRun = event.runId;
    replyIndex = -1;
    update({ running: true, activity: '正在思考…', error: '' });
  } else if (event.runId === currentRun) {
    if (event.kind === 'tool') update({ activity: `正在操作：${event.tool ?? ''}` });
    if (event.kind === 'context') update({ activity: event.text ?? '正在整理前文…' });
    if (event.kind === 'text' && event.text) {
      const messages = [...snapshot.messages];
      if (replyIndex < 0) { replyIndex = messages.length; messages.push({ id: -Date.now(), role: 'assistant', text: event.text }); }
      else messages[replyIndex] = { ...messages[replyIndex], text: messages[replyIndex].text + event.text };
      update({ messages });
    }
    if (['done', 'error', 'cancelled'].includes(event.kind)) {
      update({ running: false, activity: '', error: event.kind === 'error' ? event.text ?? '请求失败' : '' });
      refreshAgentConversation().catch(error => update({ error: String(error) }));
    }
  }
}
export async function sendAgentMessage(text: string) {
  if (!snapshot.conversationId) await refreshAgentConversation();
  if (snapshot.running) throw new Error('Agent 正在处理上一条消息');
  if (['/new', '新对话', '开始新对话'].includes(text.trim())) {
    const id = await invoke<string>('agent_new_conversation', { conversationId: snapshot.conversationId });
    await openAgentConversation(id);
    await refreshAgentConversations();
    return;
  }
  const conversationId = snapshot.conversationId;
  update({ messages: [...snapshot.messages, { id: -Date.now(), role: 'user', text }], running: true, error: '', activity: '正在连接模型…' });
  try { await invoke('agent_send_message', { conversationId, text }); }
  catch (error) {
    if (snapshot.conversationId === conversationId) {
      update({ running: false, activity: '', error: String(error) });
      await refreshAgentConversation().catch(() => {});
    }
    throw error;
  }
}
