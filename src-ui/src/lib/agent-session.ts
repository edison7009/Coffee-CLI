import type { TerminalSession } from '../store/app-state';
import { invoke, commands } from '../tauri';
import { isClaudeConversation, isCodexConversation, isDshConversation } from './chat-tools';
import { getClaudeConnection, sendClaudeMessage, controlClaude, loadClaudeHistory } from './claude-session';
import { getCodexConnection, sendCodexMessage, interruptCodex, loadCodexHistory } from './codex-session';
import { getDshConnection, sendDshMessage, stopDsh } from './dsh-session';
import type { ClaudeMessage } from './claude-protocol';
import type { CodexMessage } from './codex-protocol';
import type { DshMessage } from './dsh-protocol';
import { getTerminalObserver } from './terminal-observer';
import { terminalControlStatus, submitTerminalPrompt, sendTerminalKey, TerminalInputError } from './terminal-control';

/** Adapt the existing session; observation and control never start another process. */
export function getAgentSession(tab: TerminalSession) {
  const id = tab.id, claude = isClaudeConversation(tab), codex = isCodexConversation(tab), dsh = isDshConversation(tab);
  if (!claude && !codex && !dsh) {
    const observer = getTerminalObserver(id);
    return observer && {
      mode: 'terminal' as const, generation: observer.generation, ...terminalControlStatus(id),
      readScreen: observer.readScreen, readScrollback: observer.readScrollback,
      send: (text: string, guard: () => boolean) => submitTerminalPrompt(id, text, guard),
      key: (key: string, guard: () => boolean) => sendTerminalKey(id, key, guard),
      close: () => commands.tierTerminalKill(id),
    };
  }
  const connection = () => dsh ? getDshConnection(id) : claude ? getClaudeConnection(id) : getCodexConnection(id);
  const initial = connection();
  if (!initial) return;
  const generation = `desktop:${tab.tool}:${initial.generation}`;
  const current = () => {
    const c = connection();
    if (!c || c.generation !== initial.generation) throw new Error('会话已关闭或重启，请重新读取会话清单');
    return c;
  };
  const historyCursor = () => { const { state } = current(); return 'historyCursor' in state && !!state.historyCursor; };
  const rows = () => current().state.messages.flatMap((message: ClaudeMessage | CodexMessage | DshMessage) => {
    const parts = [message.content];
    if ('toolInput' in message && message.toolInput) parts.push(message.toolInput);
    if ('input' in message && message.input) parts.push(JSON.stringify(message.input));
    if ('inputJson' in message && !message.input && message.inputJson) parts.push(message.inputJson);
    if ('output' in message && message.output) parts.push(message.output);
    if ('item' in message && message.item.command) parts.push(JSON.stringify(message.item.command));
    return [`[${message.role}${message.toolName ? `: ${message.toolName} (${message.toolStatus ?? 'unknown'})` : ''}]`, ...parts.filter(Boolean).join('\n').split(/\r?\n/)];
  });
  const page = (lines: string[], start: number, limit: number) => {
    const selected = lines.slice(start, start + limit);
    return {
      sessionId: id, generation, capturedAt: Date.now(), source: 'desktop-session' as const,
      startRow: start, endRow: start + selected.length, availableRows: lines.length,
      hasMore: start + selected.length < lines.length, hasOlder: historyCursor(),
      loadingHistory: (({ state }) => 'loadingHistory' in state && state.loadingHistory)(current()), error: current().state.error,
      truncated: selected.some(line => line.length > 1000),
      lines: selected.map((text, row) => ({ row, bufferRow: start + row, text: text.length > 1000 ? `${text.slice(0, 1000)} [truncated]` : text, isWrapped: false })),
    };
  };
  const readScreen = async () => {
    const { state, ready } = current(), lines = rows();
    return {
      ...page(lines, Math.max(0, lines.length - 200), 200), nativeSessionId: 'nativeId' in state ? state.nativeId : state.sessionId,
      ready, busy: state.busy, localInputPending: !!tab.gambitDraft?.trim(), status: state.requests.length ? 'wait_input' : state.busy ? 'working' : ready ? 'idle' : 'disconnected',
      error: state.error,
      pendingRequests: state.requests.map(request => ({ id: request.id, kind: 'method' in request ? request.method : String(request.request.subtype ?? 'approval') })),
    };
  };
  return {
    mode: 'desktop' as const, generation, ready: initial.ready,
    canReceive: initial.ready && !initial.inputBusy && !initial.state.requests.length && !initial.state.error && !tab.gambitDraft?.trim(),
    localInputPending: !!tab.gambitDraft?.trim(), inputBusy: initial.inputBusy, error: initial.state.error,
    readScreen,
    readScrollback: async (startRow?: number, limit = 200) => {
      if (startRow === 0 && historyCursor()) {
        if (claude) await loadClaudeHistory(id); else await loadCodexHistory(id);
      }
      const lines = rows(), count = Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.floor(limit) : 200));
      const start = startRow === undefined ? Math.max(0, lines.length - count) : Math.max(0, Math.min(lines.length, Number.isFinite(startRow) ? Math.floor(startRow) : 0));
      return page(lines, start, count);
    },
    send: async (text: string, guard: () => boolean, deliveryId?: string) => {
      const c = current();
      if (!guard()) throw new Error('目标会话已经改变');
      if (!text.trim()) throw new Error('消息不能为空');
      if (!c.ready) throw new Error('桌面会话尚未就绪或已经断开');
      if (tab.gambitDraft?.trim()) throw new Error('会话有本地未提交输入，请先处理后再发送');
      if (c.state.requests.length) throw new Error('会话正在等待用户处理请求，请先由用户处理');
      if (c.inputBusy) throw new Error('会话正在执行任务，请等待完成或明确请求中断');
      if (deliveryId && !claude) throw new Error('此会话不支持自动编排结果投递');
      const sent = await (dsh ? sendDshMessage(id, text) : claude ? sendClaudeMessage(id, text, deliveryId) : sendCodexMessage(id, text));
      if (!sent) throw new TerminalInputError('消息发送未得到确认，请读取会话核实，不要自动重发', true);
    },
    key: async (key: string, guard: () => boolean) => {
      const c = current();
      if (!guard()) throw new Error('目标会话已经改变');
      if (key !== 'CtrlC') throw new Error('桌面会话仅支持 CtrlC 中断；发送消息请使用 terminal_send，审批请求由用户处理');
      if (!c.ready && !c.state.busy) throw new Error('桌面会话尚未就绪或已经断开');
      try {
        if (dsh) await stopDsh(id);
        else if (claude) await controlClaude(id, { subtype: 'interrupt' });
        else {
          await interruptCodex(id);
          const state = current().state;
          if (state.busy && 'interrupting' in state && !state.interrupting) throw new Error(state.error || '中断未得到确认');
        }
      } catch (error) { throw new TerminalInputError(String(error), true); }
    },
    close: () => invoke<void>(dsh ? 'dsh_session_close' : claude ? 'claude_session_close' : 'codex_session_close', { id, generation: current().generation }),
  };
}
