// Every tool's conversation draws its steps the same way (the step line, the turn fold, the changed-files card), from
// rows shaped like Claude's: a call is `role: 'tool'` with Claude's tool names and inputs, so Read/Edit/Bash read
// alike whichever CLI made them. These turn Codex and OpenCode items into such rows. Status lines (a turn's end,
// a notice) become `role: 'notice'`, which is neither a step nor a reply.
import type { ClaudeMessage } from './claude-protocol';
import type { CodexMessage } from './codex-protocol';
import type { OpenCodeRow } from './opencode-protocol';

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown) => typeof value === 'string' ? value : '';

/** A step row, with the tool's own message kept for what only it draws (a status line, a user's attachments). */
export type StepCard<T> = ClaudeMessage & { source: T };

/** A unified diff's two sides, hunk after hunk: what the change replaced and what it wrote. */
export function diffSides(diff: string): { old_string: string; new_string: string } {
  const before: string[] = [], after: string[] = [];
  for (const line of diff.split('\n')) {
    if (/^(?:---|\+\+\+|@@|diff |index |new file|deleted file|\\ No newline)/.test(line)) continue;
    if (line.startsWith('-')) before.push(line.slice(1));
    else if (line.startsWith('+')) after.push(line.slice(1));
    else { const text = line.startsWith(' ') ? line.slice(1) : line; before.push(text); after.push(text); }
  }
  const join = (lines: string[]) => lines.length ? `${lines.join('\n')}\n` : '';
  return { old_string: join(before), new_string: join(after) };
}

function status(message: { partial?: boolean; toolStatus?: ClaudeMessage['toolStatus'] }): ClaudeMessage['toolStatus'] {
  return message.partial ? 'running' : message.toolStatus ?? 'done';
}

/** One Codex item as step rows: a command (or the read, search or listing it amounts to), each file a change
 *  touched, a web search, an MCP call; thoughts as thoughts and a turn's status line as status. */
export function codexStepCards(message: CodexMessage): StepCard<CodexMessage>[] {
  const item = obj(message.item), base = { id: message.id, timestamp: message.timestamp, interrupted: message.interrupted, source: message };
  if (item.type === 'turnStatus') return [{ ...base, role: 'notice', content: message.content, turnStats: message.turnStats && { ...message.turnStats, usage: { ...message.turnStats.usage, cacheWrite1h: 0 } } }];
  if (message.role !== 'tool') return [{ ...base, role: message.role, content: message.content, partial: message.partial }];
  const toolStatus = status(message), output = message.content;
  if (item.type === 'fileChange') {
    const changes = arr(item.changes).map(obj);
    return (changes.length ? changes : [{}]).map((change, i) => {
      const path = str(change.path), kind = str(obj(change.kind).type) || str(change.kind);
      const sides = diffSides(str(change.diff));
      const written = kind === 'add';
      return { ...base, id: changes.length > 1 ? `${message.id}:${i}` : message.id, role: 'tool', content: '', toolStatus, output,
        toolName: written ? 'Write' : 'Edit', input: written ? { file_path: path, content: sides.new_string } : { file_path: path, ...sides } };
    });
  }
  if (item.type === 'commandExecution') {
    const actions = arr(item.commandActions).map(obj), only = actions.length === 1 ? actions[0] : {};
    const [toolName, input] = only.type === 'read' && str(only.path) ? ['Read', { file_path: str(only.path) }]
      : only.type === 'search' ? ['Grep', { pattern: str(only.query), path: str(only.path) }]
      : only.type === 'listFiles' ? ['LS', { path: str(only.path) || '.' }]
      : ['Bash', { command: str(item.command) }];
    return [{ ...base, role: 'tool', content: '', toolStatus, output, toolName, input }];
  }
  if (item.type === 'webSearch') return [{ ...base, role: 'tool', content: '', toolStatus, output, toolName: 'WebSearch', input: { query: str(item.query) } }];
  if (item.type === 'mcpToolCall') {
    const server = str(item.server), tool = str(item.tool);
    return [{ ...base, role: 'tool', content: '', toolStatus, output, toolName: server ? `mcp__${server}__${tool}` : tool, input: obj(item.arguments) }];
  }
  return [{ ...base, role: 'tool', content: '', toolStatus, output, toolName: str(item.tool) || str(item.type), input: { description: message.content.split('\n')[0] } }];
}

const OPENCODE_TOOLS: Record<string, string> = {
  bash: 'Bash', shell: 'Bash', read: 'Read', edit: 'Edit', multiedit: 'MultiEdit', write: 'Write', grep: 'Grep', glob: 'Glob',
  list: 'LS', webfetch: 'WebFetch', websearch: 'WebSearch', task: 'Task', todowrite: 'TodoWrite', patch: 'Edit',
};

/** One OpenCode row as a step row: its tools under Claude's names, camel-cased inputs renamed to match. */
export function openCodeStepCard(row: OpenCodeRow): StepCard<OpenCodeRow> {
  const base = { id: row.id, timestamp: row.timestamp, source: row };
  if (row.kind) return { ...base, role: 'notice', content: row.content, turnStats: row.turnStats ? { ...row.turnStats, usage: { ...row.turnStats.usage, cacheWrite1h: 0 } } : undefined };
  if (row.role !== 'tool') return { ...base, role: row.role, content: row.content, partial: row.partial };
  let raw: Json = {};
  if (typeof row.input === 'string') { try { raw = obj(JSON.parse(row.input)); } catch { raw = { command: row.input }; } } else raw = obj(row.input);
  const name = row.toolName ?? '', toolName = OPENCODE_TOOLS[name] ?? name;
  const path = str(raw.filePath) || str(raw.path);
  const input: Json = toolName === 'Edit' && name !== 'patch' ? { file_path: path, old_string: str(raw.oldString), new_string: str(raw.newString) }
    : toolName === 'Edit' ? { file_path: path, ...diffSides(str(raw.patchText) || str(raw.patch)) }
    : toolName === 'MultiEdit' ? { file_path: path, edits: arr(raw.edits).map(obj).map(edit => ({ old_string: str(edit.oldString), new_string: str(edit.newString) })) }
    : toolName === 'Write' ? { file_path: path, content: str(raw.content) }
    : toolName === 'Read' ? { file_path: path }
    : toolName === 'Bash' ? { command: str(raw.command) || row.title || '', description: str(raw.description) }
    : toolName === 'Grep' || toolName === 'Glob' ? { pattern: str(raw.pattern), path }
    : toolName === 'LS' ? { path: path || '.' }
    : { ...raw, description: str(raw.description) || row.title || '' };
  return { ...base, role: 'tool', content: '', toolStatus: status(row), output: row.output ?? row.content, toolName, input };
}
