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

export function orchestrationSearchLabel(name: string, query: string, t: (key: I18nKey) => string): { title: string; description: string } | undefined {
  if (name !== 'ToolSearch' || !query.startsWith('select:')) return undefined;
  const names = query.slice(7).split(',').map(name => name.trim());
  if (names.at(-1) === 'mcp__coffee-team__') names.pop();
  if (!names.length) return undefined;
  const descriptions = names.map(name => orchestrationToolLabel(name, t));
  if (descriptions.some(label => !label)) return undefined;
  return { title: t('orchestration.tool.search'), description: [...new Set(descriptions)].join(' · ') };
}
