// A finished turn reads as its answer: the thinking, tool calls and running commentary before the
// final reply fold into one 「工作了 45 秒」 row, and the files the turn changed are listed after it.
// Rows stay one per message — the virtual list and turn navigation keep their indexes — so the fold
// is a lead row plus the indexes it hides, like lib/tool-runs.ts.
import { diffLines } from 'diff';

export interface TurnWorkMessage {
  role: string;
  content?: string;
  toolName?: string;
  toolStatus?: 'running' | 'done' | 'failed';
  input?: unknown;
  timestamp?: number;
  parentId?: string;
  interrupted?: boolean;
  turnStats?: { durationMs?: number };
}

export interface TurnFold {
  /** First and last index the fold covers. */
  start: number;
  end: number;
  /** Index of the turn's prompt and of its final reply (absent when the turn ended without one). */
  prompt: number;
  reply?: number;
  durationMs?: number;
  /** A call in the fold failed. */
  failed: boolean;
  /** The turn was interrupted, or ended without a reply. */
  stopped: boolean;
  /** One mark per top-level step, in order: a call, a thought, a file change, a failure. */
  steps: StepMark[];
}
export type StepMark = 'tool' | 'think' | 'edit' | 'fail';
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export function stepMark(message: TurnWorkMessage): StepMark {
  if (message.role === 'reasoning') return 'think';
  if (message.toolStatus === 'failed' && !message.interrupted) return 'fail';
  return EDITS.has(message.toolName ?? '') ? 'edit' : 'tool';
}

const isWork = (message: TurnWorkMessage) => message.role === 'tool' || message.role === 'reasoning';

/**
 * Folds for finished turns: from the message after a prompt up to the turn's last reply. The turn still
 * running (`busy`) stays open, and a turn with no tool call or thinking has nothing to fold.
 */
export function turnFolds(messages: readonly TurnWorkMessage[], busy: boolean): { lead: Map<number, TurnFold>; hidden: Set<number> } {
  const lead = new Map<number, TurnFold>(), hidden = new Set<number>();
  const prompts = messages.flatMap((message, index) => message.role === 'user' ? [index] : []);
  prompts.forEach((prompt, n) => {
    const next = prompts[n + 1] ?? messages.length;
    if (next === messages.length && busy) return;
    // The reply is the turn's last top-level text; work after it (a background task it left running) stays in sight.
    let reply: number | undefined;
    for (let i = next - 1; i > prompt; i--) {
      const message = messages[i];
      if (message.role === 'assistant' && !message.parentId && message.content?.trim()) { reply = i; break; }
    }
    const start = prompt + 1, end = (reply ?? next) - 1;
    if (end < start) return;
    const covered = messages.slice(start, end + 1);
    if (!covered.some(isWork)) return;
    // A call still under way (a background task the turn left running) keeps the turn open.
    if (covered.some(message => message.role === 'tool' && (!message.toolStatus || message.toolStatus === 'running') && !message.interrupted)) return;
    const stats = messages.slice(start, next).findLast(message => message.turnStats?.durationMs !== undefined)?.turnStats;
    const from = messages[prompt].timestamp, to = messages[reply ?? end].timestamp;
    const durationMs = stats?.durationMs ?? (from !== undefined && to !== undefined && to >= from ? to - from : undefined);
    lead.set(start, {
      start, end, prompt, reply, durationMs,
      failed: covered.some(message => message.role === 'tool' && message.toolStatus === 'failed' && !message.interrupted),
      stopped: reply === undefined || covered.some(message => message.interrupted),
      steps: covered.filter(message => isWork(message) && !message.parentId).map(stepMark),
    });
    for (let i = start + 1; i <= end; i++) hidden.add(i);
  });
  return { lead, hidden };
}

export interface ChangedFile { path: string; added: number; removed: number; /** Written whole (Write), not edited in place. */ written: boolean }

const text = (value: unknown) => typeof value === 'string' ? value : '';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const lineCount = (value: string) => value ? value.replace(/\n$/, '').split('\n').length : 0;
function editCounts(before: string, after: string): [number, number] {
  let added = 0, removed = 0;
  for (const change of diffLines(before, after, { timeout: 100 }) ?? []) {
    if (change.added) added += change.count ?? 0;
    else if (change.removed) removed += change.count ?? 0;
  }
  return [added, removed];
}

/** The files a run of messages changed, in the order first touched, with the lines each call added and removed. */
export function changedFiles(messages: readonly TurnWorkMessage[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const message of messages) {
    if (message.role !== 'tool' || message.toolStatus !== 'done' || message.interrupted) continue;
    const input = record(message.input), name = message.toolName;
    const path = text(input.file_path) || text(input.notebook_path) || text(input.path);
    if (!path) continue;
    let counts: [number, number], written = false;
    if (name === 'Edit') counts = editCounts(text(input.old_string), text(input.new_string));
    else if (name === 'MultiEdit') counts = (Array.isArray(input.edits) ? input.edits : []).map(record).reduce<[number, number]>((sum, edit) => { const [a, r] = editCounts(text(edit.old_string), text(edit.new_string)); return [sum[0] + a, sum[1] + r]; }, [0, 0]);
    else if (name === 'Write') { counts = [lineCount(text(input.content)), 0]; written = true; }
    else if (name === 'NotebookEdit') counts = [lineCount(text(input.new_source)), 0];
    else continue;
    const file = files.get(path) ?? { path, added: 0, removed: 0, written: false };
    file.added += counts[0]; file.removed += counts[1]; file.written ||= written;
    files.set(path, file);
  }
  return [...files.values()];
}


/** A path a tool reported, made absolute against the conversation's folder, with forward slashes. */
export function absoluteToolPath(path: string, cwd: string | null): string {
  const slashed = path.replace(/\\/g, '/');
  if (/^(?:[a-z]:\/|\/)/i.test(slashed) || !cwd) return slashed;
  return `${cwd.replace(/\\/g, '/').replace(/\/$/, '')}/${slashed.replace(/^\.\//, '')}`;
}

interface DiffEntry { path: string; rel: string; added: number; deleted: number }
interface DiffChanges { state: string; repo_root?: string; uncommitted?: DiffEntry[]; untracked?: DiffEntry[] }
export interface ChangedFileSelection { repoRoot: string; folderPath: string; path: string; rel: string; kind: 'uncommitted' | 'untracked' | 'file'; added?: number; deleted?: number }

/**
 * What opening a changed file shows: its uncommitted (or untracked) diff when git still has one, else the file
 * itself — a turn's edit may since have been committed, or the folder is not a repository.
 */
export function changedFileSelection(path: string, cwd: string | null, changes: DiffChanges | null): ChangedFileSelection {
  const absolute = absoluteToolPath(path, cwd);
  const key = (value: string) => /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
  if (changes?.state === 'ok' && changes.repo_root) {
    for (const kind of ['uncommitted', 'untracked'] as const) {
      const entry = changes[kind]?.find(item => key(item.path.replace(/\\/g, '/')) === key(absolute));
      if (entry) return { repoRoot: changes.repo_root, folderPath: cwd ?? changes.repo_root, path: entry.path, rel: entry.rel, kind, added: entry.added, deleted: entry.deleted };
    }
  }
  const parts = absolute.split('/');
  const name = parts.pop() ?? absolute;
  return { repoRoot: parts.join('/') || '/', folderPath: cwd ?? parts.join('/'), path: absolute, rel: name, kind: 'file' };
}
