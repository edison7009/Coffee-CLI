import type { I18nKey } from '../i18n/en';

const labels: Record<string, I18nKey> = {
  worker_start: 'orchestration.tool.start',
  worker_list: 'orchestration.tool.list',
  worker_wait: 'orchestration.tool.wait',
  worker_read: 'orchestration.tool.read',
  worker_send: 'orchestration.tool.send',
  worker_reply: 'orchestration.tool.reply',
  worker_interrupt: 'orchestration.tool.interrupt',
};

export function orchestrationToolLabel(name: string, t: (key: I18nKey) => string, server?: string): string | undefined {
  const prefix = 'mcp__coffee-team__';
  const action = name.startsWith(prefix) ? name.slice(prefix.length) : server === 'coffee-team' ? name : '';
  const key = Object.hasOwn(labels, action) ? labels[action] : undefined;
  return key ? t(key) : undefined;
}
