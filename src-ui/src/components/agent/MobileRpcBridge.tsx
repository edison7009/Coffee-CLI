import { useEffect } from 'react';
import { useAppStateRef } from '../../store/app-state';
import { commands, isTauri } from '../../tauri';
import { getAgentSession } from '../../lib/agent-session';
import { isClaudeConversation, isCodexConversation, isDshConversation, isOpenCodeConversation, isPiConversation } from '../../lib/chat-tools';
import type { TerminalSession } from '../../store/app-state';

interface MobileRequest { requestId: string; method: string; params: { id?: string; text?: string } }
class RequestError extends Error {
  readonly code: 'not_found' | 'busy' | 'internal';
  constructor(message: string, code: RequestError['code']) { super(message); this.code = code; }
}

function conversationKind(tab: TerminalSession) {
  return isClaudeConversation(tab) ? 'claude' : isCodexConversation(tab) ? 'codex' : isOpenCodeConversation(tab) ? 'opencode'
    : isPiConversation(tab) ? 'pi' : isDshConversation(tab) ? 'dsh' : null;
}

/** Answers phone requests (see mobile/PROTOCOL.md) through the same session paths the desktop uses. */
export function MobileRpcBridge() {
  const stateRef = useAppStateRef();
  useEffect(() => {
    if (!isTauri) return;
    let disposed = false, stop: (() => void) | undefined;
    const tabFor = (id?: string) => {
      const tab = stateRef.current.terminals.find(tab => tab.id === id && tab.tool && !tab.isHidden);
      if (!tab) throw new RequestError('Session not found', 'not_found');
      return tab;
    };
    const run = async ({ method, params }: MobileRequest) => {
      if (method === 'session.list') {
        return { sessions: stateRef.current.terminals.filter(tab => tab.tool && !tab.isHidden).map(tab => {
          const kind = conversationKind(tab);
          return {
            id: tab.id, tool: tab.tool, kind, view: kind ? 'conversation' : 'terminal',
            title: tab.pinnedTitle || tab.toolTitle || '', cwd: tab.folderPath ?? '',
            status: tab.agentStatus ?? null, updatedAt: tab.activeAt ?? tab.startedAt ?? null,
          };
        }) };
      }
      const tab = tabFor(params.id), session = getAgentSession(tab);
      if (!session || session.mode !== 'desktop') throw new RequestError('Not a desktop conversation', 'not_found');
      const generation = session.generation, guard = () => !disposed && getAgentSession(tabFor(params.id))?.generation === generation;
      if (method === 'conversation.send') {
        if (!session.ready) throw new RequestError('Session is not ready', 'busy');
        await session.send(String(params.text ?? ''), guard);
        return {};
      }
      if (method === 'conversation.cancel') { await session.key('CtrlC', guard); return {}; }
      throw new RequestError('Unsupported request', 'internal');
    };
    void import('@tauri-apps/api/event').then(({ listen }) => listen<MobileRequest>('mobile-rpc-request', async ({ payload }) => {
      let result: unknown;
      try { result = { ok: true, result: await run(payload) }; }
      catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error), code: error instanceof RequestError ? error.code : 'internal' }; }
      await commands.mobileRpcResolve(payload.requestId, result).catch(() => {});
    })).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; }).catch(error => console.error('[MobileRpcBridge]', error));
    return () => { disposed = true; stop?.(); };
  }, [stateRef]);
  return null;
}
