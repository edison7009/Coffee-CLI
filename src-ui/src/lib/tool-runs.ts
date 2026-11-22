// Consecutive tool calls in a conversation read as one step ("读取 2 个文件、运行 1 条命令") that opens
// into the calls themselves. Rows stay one per message — the virtual list and turn navigation keep
// their indexes — the first row of a run shows the group and the others render empty.
import type { I18nKey } from '../i18n/en';

export interface ToolRunMessage { role: string; toolName?: string; toolStatus?: 'running' | 'done' | 'failed'; parentId?: string }

/** Runs of `minimum` (default two) or more adjacent tool calls under the same parent: first index → last index, and the rest. */
export function toolRuns(messages: readonly ToolRunMessage[], minimum = 2): { lead: Map<number, number>; follower: Set<number> } {
  const lead = new Map<number, number>(), follower = new Set<number>();
  for (let i = 0; i < messages.length;) {
    if (messages[i].role !== 'tool') { i++; continue; }
    let end = i;
    while (end + 1 < messages.length && messages[end + 1].role === 'tool' && messages[end + 1].parentId === messages[i].parentId) end++;
    if (end - i + 1 >= minimum) {
      lead.set(i, end);
      for (let k = i + 1; k <= end; k++) follower.add(k);
    }
    i = end + 1;
  }
  return { lead, follower };
}

type Kind = 'read' | 'search' | 'edit' | 'run' | 'web' | 'remote' | 'team' | 'other';
const KINDS: Record<string, Kind> = {
  Read: 'read', NotebookRead: 'read', LS: 'read',
  Grep: 'search', Glob: 'search', WebSearch: 'search', ToolSearch: 'search',
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'run', BashOutput: 'run',
  WebFetch: 'web',
};
export function toolKind(name = ''): Kind {
  if (KINDS[name]) return KINDS[name];
  if (/coffee-control/.test(name)) return 'remote';
  if (/coffee-team/.test(name) || name === 'Task' || name === 'Agent') return 'team';
  return 'other';
}
const ORDER: Kind[] = ['read', 'search', 'edit', 'run', 'web', 'remote', 'team', 'other'];
const KEYS: Record<Kind, I18nKey> = {
  read: 'tools.group.read', search: 'tools.group.search', edit: 'tools.group.edit', run: 'tools.group.run',
  web: 'tools.group.web', remote: 'tools.group.remote', team: 'tools.group.team', other: 'tools.group.other',
};

/** 「读取 2 个文件、运行 1 条命令」 for a run of calls, in the order a reader expects. */
export function toolRunSummary(messages: readonly ToolRunMessage[], t: (key: I18nKey, vars?: Record<string, string | number>) => string): string {
  const counts = new Map<Kind, number>();
  for (const message of messages) { const kind = toolKind(message.toolName); counts.set(kind, (counts.get(kind) ?? 0) + 1); }
  const text = ORDER.filter(kind => counts.has(kind)).map(kind => t(KEYS[kind], { count: counts.get(kind)! })).join(t('tools.group.join'));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The group's state: running while any call runs, failed if any failed, else done. */
export function toolRunStatus(messages: readonly ToolRunMessage[]): 'running' | 'failed' | 'done' {
  if (messages.some(message => message.toolStatus === 'running' || !message.toolStatus)) return 'running';
  return messages.some(message => message.toolStatus === 'failed') ? 'failed' : 'done';
}

const VERBS: Record<Kind, I18nKey> = {
  read: 'tools.verb.read', search: 'tools.verb.search', edit: 'tools.verb.edit', run: 'tools.verb.run',
  web: 'tools.verb.web', remote: 'tools.verb.remote', team: 'tools.verb.team', other: 'tools.verb.other',
};
export const toolVerbKey = (name?: string): I18nKey => VERBS[toolKind(name)];

/** What one call worked on, short enough for one line: a file's name, a search, a command, a page. */
export function toolTarget(name: string | undefined, input: Record<string, unknown>): string {
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const kind = toolKind(name);
  if (kind === 'read' || kind === 'edit') return base(text(input.file_path) || text(input.notebook_path) || text(input.path));
  if (name === 'Grep' || name === 'Glob' || name === 'WebSearch') return `“${text(input.pattern) || text(input.query)}”`;
  if (name === 'ToolSearch') return '';
  if (kind === 'run') return (text(input.command).split('\n')[0] ?? '').trim();
  if (kind === 'web') { try { return new URL(text(input.url)).hostname; } catch { return text(input.url); } }
  if (kind === 'team') return text(input.description) || text(input.title) || text(input.prompt).slice(0, 60);
  if (kind === 'remote') return text(input.text) || text(input.key) || '';
  return text(input.description) || text(input.path) || text(input.query) || '';
}

/** A short result after the target: the last line a command printed, how many places a search found. */
export function toolResult(name: string | undefined, output: string | undefined): string {
  if (!output) return '';
  const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
  if (name === 'Bash') { const last = lines[lines.length - 1] ?? ''; return last.length > 48 ? `${last.slice(0, 47)}…` : last; }
  if (name === 'Grep' || name === 'Glob') return String(lines.length);
  return '';
}
