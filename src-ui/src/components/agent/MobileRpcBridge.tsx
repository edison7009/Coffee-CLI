import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n/useT';
import { getProjectFolders } from '../../lib/project-folders';
import { useAppState, useAppStateRef } from '../../store/app-state';
import { commands, invoke, isTauri } from '../../tauri';
import { getAgentSession } from '../../lib/agent-session';
import { isClaudeConversation, isCodexConversation, isDshConversation, isOpenCodeConversation, isPiConversation } from '../../lib/chat-tools';
import { SETTINGS_ACTIONS, pickMirroredSettings, type Action, type TerminalSession } from '../../store/app-state';
import { writeFromBrowser } from '../../lib/storage-mirror';
import { mirrorSnapshot, mirrorSource, runMirrorAction, setMirrorActive, type MirrorKind } from '../../lib/session-mirror';
import type { MobileRpcStatus } from '../../tauri';

/** Tab changes a browser may ask for; everything else it does stays in the browser. */
const BROWSER_ACTIONS = new Set<Action['type']>(['ADD_TERMINAL', 'LAUNCH_TERMINAL_TOOL', 'SET_TERMINAL_TOOL', 'REMOVE_TERMINAL', 'CLOSE_TERMINAL_GROUP', 'RESTART_TERMINAL', 'SET_TERMINAL_HIDDEN', 'SET_TERMINAL_WORKTREE', 'SET_TAB_TITLE']);
const MIRROR_KINDS = new Set<MirrorKind>(['claude', 'codex', 'opencode', 'pi', 'dsh', 'app']);

interface MobileRequest { requestId: string; method: string; params: { id?: string; text?: string; name?: string; cmd?: string; args?: Record<string, unknown> | unknown[]; kind?: string; action?: Action & { cwd?: string } } }
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
  const { state, dispatch } = useAppState();
  const listed = useMemo(() => state.terminals.filter(tab => tab.tool && !tab.isHidden)
    .map(tab => [tab.id, tab.tool, tab.pinnedTitle || tab.toolTitle || '', tab.folderPath ?? '', tab.agentStatus ?? '', conversationKind(tab) ?? ''].join('\u0000')).join('\u0001'), [state.terminals]);
  const firstList = useRef(true);
  useEffect(() => {
    if (!isTauri) return;
    if (firstList.current) { firstList.current = false; return; }
    const timer = setTimeout(() => { void commands.mobileRpcSessionsChanged().catch(() => {}); }, 300);
    return () => clearTimeout(timer);
  }, [listed]);
  // Conversations are only turned into patches while a browser is there to receive them.
  useEffect(() => {
    if (!isTauri) return;
    let stop: (() => void) | undefined, disposed = false;
    const follow = (status: MobileRpcStatus) => setMirrorActive(status.enabled && status.connected.length > 0);
    void commands.mobileRpcStatus().then(status => { if (!disposed) follow(status); }).catch(() => {});
    void import('@tauri-apps/api/event').then(({ listen }) => listen<MobileRpcStatus>('mobile-rpc-devices', ({ payload }) => follow(payload)))
      .then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop?.(); setMirrorActive(false); };
  }, []);
  // The desktop's settings, followed by every browser (see MIRRORED_SETTINGS).
  const [settingsChanged] = useState(() => mirrorSource('app', 'settings', () => pickMirroredSettings(stateRef.current)));
  const settingsKey = JSON.stringify(pickMirroredSettings(state));
  useEffect(() => { settingsChanged(); }, [settingsKey, settingsChanged]);
  const dispatchRef = useRef(dispatch);
  useEffect(() => { dispatchRef.current = dispatch; }, [dispatch]);
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
      if (method === 'invoke' && params.cmd) return invoke(params.cmd, (params.args ?? {}) as Record<string, unknown>);
      // A browser following a conversation, or asking it to act: the desktop's own session does the work.
      if (method === 'mirror.snapshot' || method === 'ui.call') {
        const kind = params.kind as MirrorKind;
        if (!MIRROR_KINDS.has(kind) || typeof params.id !== 'string' && method === 'mirror.snapshot') throw new RequestError('Unknown conversation', 'not_found');
        if (method === 'mirror.snapshot') return mirrorSnapshot(kind, params.id!);
        return await runMirrorAction(kind, String(params.name ?? ''), Array.isArray(params.args) ? params.args : []) ?? null;
      }
      // A tab opened, closed or changed in the browser happens here; the browser's list follows.
      if (method === 'ui.dispatch') {
        const action = params.action;
        if (!action || !BROWSER_ACTIONS.has(action.type) && !SETTINGS_ACTIONS.has(action.type)) throw new RequestError('Unsupported change', 'internal');
        const before = stateRef.current.activeTerminalId;
        let next: Action = action;
        // Choosing a tool on the browser's blank launch page opens a new desktop tab.
        if (action.type === 'SET_TERMINAL_TOOL' && !stateRef.current.terminals.some(tab => tab.id === action.id)) {
          next = { type: 'LAUNCH_TERMINAL_TOOL', id: action.id, tool: action.tool, cwd: action.cwd, toolData: action.toolData, resumeToken: action.resumeToken, claudeMode: action.claudeMode, codexMode: action.codexMode, opencodeMode: action.opencodeMode, piMode: action.piMode };
        }
        if (next.type === 'LAUNCH_TERMINAL_TOOL') next = { ...next, background: true };
        dispatchRef.current(next);
        // Each screen keeps the tab it is looking at.
        setTimeout(() => {
          const now = stateRef.current;
          if (before && now.activeTerminalId !== before && now.terminals.some(tab => tab.id === before)) dispatchRef.current({ type: 'SET_ACTIVE_TERMINAL', id: before });
        }, 0);
        return {};
      }
      // The folders this desktop has opened, offered to a browser in place of the folder dialog.
      if (method === 'projects.list') return { folders: getProjectFolders() };
      // A browser saved one of the desktop's records (a recent folder, a launch mode…).
      if (method === 'storage.set') {
        const { key, value } = params as unknown as { key?: unknown; value?: unknown };
        if (typeof key !== 'string' || value !== null && typeof value !== 'string') throw new RequestError('Bad setting', 'internal');
        writeFromBrowser(key, value as string | null);
        return {};
      }
      // The wallpaper a browser shows; the file itself is read and sent by the server.
      if (method === 'wallpaper.path') return { path: stateRef.current.bgType === 'none' ? '' : stateRef.current.bgPath };
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
            claudeMode: tab.claudeMode, codexMode: tab.codexMode, opencodeMode: tab.opencodeMode, piMode: tab.piMode, worktree: tab.worktree, parentId: tab.parentId,
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
