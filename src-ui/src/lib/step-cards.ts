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
  // A hunk's header counts its lines, so `--- x` inside it is a removed line that began `-- x`, not a file header.
  // Without counts (a bare `@@`), lines run to the next header as before.
  let oldLeft = 0, newLeft = 0, counted = false, inHunk = false;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (line.startsWith('@@')) { inHunk = true; counted = !!hunk; oldLeft = hunk ? Number(hunk[1] ?? 1) : 0; newLeft = hunk ? Number(hunk[2] ?? 1) : 0; continue; }
    if (line.startsWith('\\ No newline')) continue;
    if (inHunk && counted && oldLeft <= 0 && newLeft <= 0) inHunk = false;
    if ((!inHunk || !counted) && /^(?:---|\+\+\+|diff |index |new file|deleted file|similarity |rename |old mode|new mode)/.test(line)) { inHunk = false; continue; }
    if (line.startsWith('-')) { before.push(line.slice(1)); oldLeft--; }
    else if (line.startsWith('+')) { after.push(line.slice(1)); newLeft--; }
    else { const text = line.startsWith(' ') ? line.slice(1) : line; before.push(text); after.push(text); oldLeft--; newLeft--; }
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

/**
 * An ACP tool call (Agent Client Protocol, as `agy acp` speaks it) under the shared step names: the protocol's own
 * kind says what the call does (read, edit, execute, search, fetch), its locations where. An edit that finished
 * with a diff reads as that diff; one with no old text wrote a new file. The agent's own tool name and raw input
 * fill in what the kind leaves open.
 */
export function acpToolStep(update: Json, previous?: { toolName?: string; input?: unknown }): { toolName: string; input: Json } {
  const raw = obj(update.rawInput), name = str(update.name), kind = str(update.kind);
  const path = str(obj(arr(update.locations)[0]).path) || str(raw.AbsolutePath) || str(raw.Path) || str(raw.TargetFile) || str(raw.path) || str(raw.file_path);
  const diff = arr(update.content).map(obj).find(content => content.type === 'diff');
  if (diff) {
    const file = str(diff.path) || path, before = str(diff.oldText), after = str(diff.newText);
    return before ? { toolName: 'Edit', input: { file_path: file, old_string: before, new_string: after } } : { toolName: 'Write', input: { file_path: file, content: after } };
  }
  const known = previous?.toolName && previous.toolName !== 'Tool' ? previous : undefined;
  // A later update with no input, or one after the edit already showed its change, keeps what the call was.
  const shown = obj(known?.input), changed = !!(str(shown.old_string) || str(shown.new_string) || str(shown.content));
  if (known && (!Object.keys(raw).length || changed)) return { toolName: known.toolName!, input: shown };
  if (kind === 'execute' || name === 'run_command') return { toolName: 'Bash', input: { command: str(raw.CommandLine) || str(raw.command) || str(update.title), description: str(raw.toolSummary) } };
  if (name === 'list_dir') return { toolName: 'LS', input: { path: str(raw.DirectoryPath) || path || '.' } };
  if (kind === 'read') return { toolName: 'Read', input: { file_path: path } };
  if (kind === 'edit') return typeof raw.Content === 'string' || typeof raw.CodeContent === 'string'
    ? { toolName: 'Write', input: { file_path: path, content: str(raw.Content) || str(raw.CodeContent) } }
    : { toolName: 'Edit', input: { file_path: path, old_string: str(raw.TargetContent), new_string: str(raw.ReplacementContent) } };
  if (kind === 'search') return name === 'find_by_name'
    ? { toolName: 'Glob', input: { pattern: str(raw.Pattern) || str(update.title), path } }
    : name === 'search_web' ? { toolName: 'WebSearch', input: { query: str(raw.query) || str(raw.Query) || str(update.title) } }
    : { toolName: 'Grep', input: { pattern: str(raw.Query) || str(raw.Pattern) || str(raw.query) || str(update.title), path } };
  if (kind === 'fetch') return { toolName: 'WebFetch', input: { url: str(raw.Url) || str(raw.url) || str(update.title) } };
  return { toolName: name || str(update.title) || kind || 'Tool', input: { ...raw, description: str(update.title) } };
}
