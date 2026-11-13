import { useEffect, useMemo, useRef } from 'react';
import { useT } from '../../i18n/useT';
import { getProjectFolders } from '../../lib/project-folders';
import { useAppState, useAppStateRef } from '../../store/app-state';
import { commands, invoke, isTauri } from '../../tauri';
import { getAgentSession } from '../../lib/agent-session';
import { isClaudeConversation, isCodexConversation, isDshConversation, isOpenCodeConversation, isPiConversation } from '../../lib/chat-tools';
import type { TerminalSession } from '../../store/app-state';

interface MobileRequest { requestId: string; method: string; params: { id?: string; text?: string; name?: string; cmd?: string; args?: Record<string, unknown> } }
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
  const t = useT(), tRef = useRef(t);
  useEffect(() => { tRef.current = t; }, [t]);

  // Phones re-read the list when what it shows changes; bursts (restoring tabs) collapse into one notice.
  const { state } = useAppState();
  const listed = useMemo(() => state.terminals.filter(tab => tab.tool && !tab.isHidden)
    .map(tab => [tab.id, tab.tool, tab.pinnedTitle || tab.toolTitle || '', tab.folderPath ?? '', tab.agentStatus ?? ''].join('\u0000')).join('\u0001'), [state.terminals]);
  const firstList = useRef(true);
  useEffect(() => {
    if (!isTauri) return;
    if (firstList.current) { firstList.current = false; return; }
    const timer = setTimeout(() => { void commands.mobileRpcSessionsChanged().catch(() => {}); }, 300);
    return () => clearTimeout(timer);
  }, [listed]);
  useEffect(() => {
    if (!isTauri) return;
    let disposed = false, stop: (() => void) | undefined;
    const tabFor = (id?: string) => {
      const tab = stateRef.current.terminals.find(tab => tab.id === id && tab.tool && !tab.isHidden);
      if (!tab) throw new RequestError('Session not found', 'not_found');
      return tab;
    };
    const run = async ({ method, params }: MobileRequest) => {
      // A browser's command (Web 端), already checked against the desktop's rules in Rust.
      if (method === 'invoke' && params.cmd) return invoke(params.cmd, params.args ?? {});
      // The folders this desktop has opened, offered to a browser in place of the folder dialog.
      if (method === 'projects.list') return { folders: getProjectFolders() };
      if (method === 'pair.confirm') {
        // A native prompt reaches the person even when the settings page is closed.
        const { ask } = await import('@tauri-apps/plugin-dialog');
        const accepted = await ask(tRef.current('settings.mobile.confirm.body', { name: String(params.name ?? '') }), { title: tRef.current('settings.mobile.confirm.title'), kind: 'warning', okLabel: tRef.current('settings.mobile.confirm.allow'), cancelLabel: tRef.current('settings.mobile.confirm.deny') });
        return { accepted };
      }
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
