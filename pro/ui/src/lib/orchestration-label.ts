import type { I18nKey } from '../i18n/en';

// What the tools Coffee CLI gives an assistant are called in the conversation, by server.
const servers: Record<string, { search: I18nKey; labels: Record<string, I18nKey> }> = {
  'coffee-team': {
    search: 'orchestration.tool.search',
    labels: {
      worker_start: 'orchestration.tool.start',
      worker_list: 'orchestration.tool.list',
      worker_wait: 'orchestration.tool.wait',
      worker_read: 'orchestration.tool.read',
      worker_send: 'orchestration.tool.send',
      worker_reply: 'orchestration.tool.reply',
      worker_interrupt: 'orchestration.tool.interrupt',
    },
  },
  // src/window_control.rs
  'coffee-control': {
    search: 'ai_remote.tool.search',
    labels: {
      window_list: 'ai_remote.tool.list',
      window_tabs: 'ai_remote.tool.tabs',
      tab_open: 'ai_remote.tool.open',
      tab_send: 'ai_remote.tool.send',
      tab_key: 'ai_remote.tool.key',
      tab_read: 'ai_remote.tool.read',
    },
  },
};

/**
 * The server and tool a name refers to, when it is one of ours. Each assistant names a server's tools
 * its own way: `mcp__coffee-control__tab_read` (Claude), `coffee-control_tab_read` (OpenCode),
 * `coffee-control__tab_read`, or the bare name beside a separate server field (Codex).
 */
function ours(name: string, server?: string): { server: string; action: string } | undefined {
  for (const id of Object.keys(servers)) {
    for (const prefix of [`mcp__${id}__`, `${id}__`, `${id}_`]) if (name.startsWith(prefix)) return { server: id, action: name.slice(prefix.length) };
    if (server === id) return { server: id, action: name };
  }
  return undefined;
}

export function orchestrationToolLabel(name: string, t: (key: I18nKey) => string, server?: string): string | undefined {
  const tool = ours(name, server);
  const labels = tool && servers[tool.server].labels;
  return labels && Object.hasOwn(labels, tool.action) ? t(labels[tool.action]) : undefined;
}

export function orchestrationSearchLabel(name: string, query: string, t: (key: I18nKey) => string): { title: string; description: string } | undefined {
  if (name !== 'ToolSearch' || !query.startsWith('select:')) return undefined;
  const names = query.slice(7).split(',').map(name => name.trim()).filter(name => !/^mcp__[^_]+(?:-[^_]+)*__$/.test(name));
  if (!names.length) return undefined;
  const tools = names.map(name => ours(name));
  // Only a search for one server's tools gets that server's title.
  const server = tools[0]?.server;
  if (!server || tools.some(tool => tool?.server !== server)) return undefined;
  const descriptions = names.map(name => orchestrationToolLabel(name, t));
  if (descriptions.some(label => !label)) return undefined;
  return { title: t(servers[server].search), description: [...new Set(descriptions)].join(' · ') };
}
