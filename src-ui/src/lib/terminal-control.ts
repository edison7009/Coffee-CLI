import type { Terminal } from '@xterm/xterm';
import { commands } from '../tauri';
import { markSentinelSubmission, cancelSentinelSubmission, markSentinelInterrupt } from './agent-sentinel';

interface Control {
  term: Terminal;
  ready: boolean;
  error?: string;
  dirty: boolean;
  busy: boolean;
  localRevision: number;
  capture: Promise<void>[] | null;
  onSubmitted: (statusConfirmed: boolean) => void;
  statusRevision: number;
  draft: string;
}
const controls = new Map<string, Control>();
export class TerminalInputError extends Error {
  readonly uncertain: boolean;
  constructor(message: string, uncertain: boolean) { super(message); this.uncertain = uncertain; }
}

export function registerTerminalControl(sessionId: string, term: Terminal, onSubmitted: (statusConfirmed: boolean) => void): () => void {
  const control: Control = { term, ready: false, dirty: false, busy: false, localRevision: 0, capture: null, onSubmitted, draft: '', statusRevision: 0 };
  controls.set(sessionId, control);
  return () => { if (controls.get(sessionId) === control) controls.delete(sessionId); };
}

export function confirmTerminalAgentStatus(sessionId: string): void {
  const control = controls.get(sessionId);
  if (control) control.statusRevision++;
}

export function setTerminalControlReady(sessionId: string, ready: boolean, error?: string): void {
  const control = controls.get(sessionId);
  if (control) { control.ready = ready; control.error = error; }
}

export function terminalControlStatus(sessionId: string) {
  const control = controls.get(sessionId);
  return { ready: control?.ready ?? false, localInputPending: control?.dirty ?? false, inputBusy: control?.busy ?? false, error: control?.error };
}

/** Pasting a multiline draft does not submit it; shared sends confirm their separate Enter. */
export function isTerminalSubmitInput(sessionId: string, data: string): boolean {
  return !controls.get(sessionId)?.busy && !data.startsWith('\x1b[200~') && /[\r\n]/.test(data);
}

/** Shared xterm onData path for locally typed input. Programmatic sends (Gambit/Agent)
 *  go through submitTerminalPrompt, which writes to the PTY directly. */
export function forwardTerminalInput(sessionId: string, data: string, editing = false): Promise<void> {
  const control = controls.get(sessionId);
  let submitted = '';
  const localInput = control && !control.capture;
  if (localInput) {
    if (data.includes('\x03') || data.includes('\x15')) control.draft = '';
    else if (data.startsWith('\x1b[200~')) control.draft = (control.draft + (data.endsWith('\x1b[201~') ? data.slice(6, -6) : data.slice(6))).slice(-4000);
    else if (data === '\x7f' || data === '\b') control.draft = control.draft.slice(0, -1);
    else if (data.startsWith('\x1b') && /^(?:\[[0-9;]*|O)[AB]$/.test(data.slice(1))) control.draft ||= '[recalled input]';
    else if (/^[\r\n]+$/.test(data)) { submitted = control.draft; control.draft = ''; }
    else if (!data.startsWith('\x1b')) {
      const parts = data.split(/[\r\n]/);
      control.draft = (control.draft + parts[0]).slice(-4000);
      if (parts.length > 1) { submitted = control.draft; control.draft = parts[parts.length - 1]; }
    }
  }
  if (control && !control.capture) {
    control.localRevision++;
    if (data.startsWith('\x1b[200~')) control.dirty = true;
    else if (editing) control.dirty = true;
    else if (data.includes('\x03') || data.includes('\x15') || /[\r\n]$/.test(data)) control.dirty = false;
    else if (data.startsWith('\x1b') && /^(?:\[[0-9;]*|O)[AB]/.test(data.slice(1))) control.dirty = true;
    else if (data && !data.startsWith('\x1b')) control.dirty = true;
  }
  const submission = localInput && submitted.trim() ? markSentinelSubmission(sessionId, submitted) : undefined;
  const write = commands.tierTerminalInput(sessionId, data);
  control?.capture?.push(write);
  if (localInput) return write.then(() => {
    if (controls.get(sessionId) !== control) return;
    if (data.includes('\x03')) markSentinelInterrupt(sessionId);
  }, error => { cancelSentinelSubmission(sessionId, submission); throw error; });
  return write;
}

function requireControl(sessionId: string): Control {
  const control = controls.get(sessionId);
  if (!control?.ready) throw new Error(control?.error || '终端尚未启动或进程已退出');
  if (control.busy) throw new Error('该终端正在提交输入，请稍后重试');
  return control;
}

// Large prompts must reach the PTY as small, ordered, paced writes instead of
// one huge burst. A single oversized invoke body + a single ConPTY input write
// can lose its tail on Windows (issue #127: the draft looks complete in Gambit,
// but the CLI only receives a prefix after Enter). Chunks stay under any IPC
// buffer, strict awaiting preserves order, and the pacing gives the ConPTY
// host and the CLI's stdin reader room to drain.
const PASTE_CHUNK_CHARS = 2048;
const PASTE_PACE_MS = 10;

/** Fixed-size chunks that never cut a UTF-16 surrogate pair in half. */
function splitPasteChunks(text: string): string[] {
  if (text.length <= PASTE_CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + PASTE_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export async function submitTerminalPrompt(sessionId: string, text: string, guard: () => boolean = () => true): Promise<void> {
  const control = requireControl(sessionId);
  if (!text.trim()) throw new Error('消息不能为空');
  if (control.dirty) throw new Error('终端有本地未提交输入，请先处理后再发送');
  if (!guard()) throw new Error('目标会话已经改变');
  control.busy = true;
  const revision = control.localRevision;
  let attempted = false;
  let submission: number | undefined;
  try {
    // One bracketed pair spans the whole paste, so the CLI still sees a single
    // paste event — byte-identical to what xterm's own paste() used to emit.
    const bracketed = control.term.modes.bracketedPasteMode !== false;
    const chunks = splitPasteChunks(text.replace(/\r\n?/g, '\r'));
    const last = chunks.length - 1;
    for (let i = 0; i <= last; i++) {
      let piece = chunks[i];
      if (bracketed) {
        if (i === 0) piece = `\x1b[200~${piece}`;
        if (i === last) piece = `${piece}\x1b[201~`;
      }
      // attempted means "issued", not "acknowledged": a rejected write still
      // leaves the PTY in an uncertain state that must flag the tab dirty.
      attempted = true;
      await commands.tierTerminalInput(sessionId, piece);
      if (i < last) await new Promise(resolve => setTimeout(resolve, PASTE_PACE_MS));
    }
    // Ink digests bracketed paste before accepting a separate Enter; give huge
    // pastes proportionally more settle time so their tail drains first.
    await new Promise(resolve => setTimeout(resolve, Math.min(2000, 150 + last * 40)));
    if (controls.get(sessionId) !== control || !control.ready || !guard()) throw new Error('发送期间目标会话已关闭或改变');
    if (control.localRevision !== revision) throw new Error('发送期间检测到本地输入；文本已粘贴，未自动提交');
    submission = markSentinelSubmission(sessionId, text);
    const statusRevision = control.statusRevision;
    await commands.tierTerminalInput(sessionId, '\r');
    if (control.localRevision === revision) control.dirty = false;
    control.onSubmitted(control.statusRevision !== statusRevision);
  } catch (error) {
    cancelSentinelSubmission(sessionId, submission);
    if (attempted) control.dirty = true;
    throw new TerminalInputError(String(error), attempted);
  } finally {
    control.busy = false;
  }
}

export async function sendTerminalKey(sessionId: string, key: string, guard: () => boolean): Promise<void> {
  const control = requireControl(sessionId);
  const arrow = control.term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[';
  const keys: Record<string, string> = { Enter: '\r', Escape: '\x1b', CtrlC: '\x03', Up: `${arrow}A`, Down: `${arrow}B`, Right: `${arrow}C`, Left: `${arrow}D`, Tab: '\t' };
  if (!(key in keys)) throw new Error('不支持的按键');
  if (control.dirty && key !== 'CtrlC') throw new Error('终端有本地未提交输入');
  if (!guard()) throw new Error('目标会话已经改变');
  control.busy = true;
  const revision = control.localRevision;
  const statusRevision = control.statusRevision;
  try {
    await commands.tierTerminalInput(sessionId, keys[key]);
    if (key === 'CtrlC') {
      if (control.localRevision === revision) { control.dirty = false; control.draft = ''; }
      markSentinelInterrupt(sessionId);
    }
    if (key === 'Enter') control.onSubmitted(control.statusRevision !== statusRevision);
  } catch (error) { throw new TerminalInputError(String(error), true); }
  finally { control.busy = false; }
}
