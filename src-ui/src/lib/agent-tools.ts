import type { RefObject } from 'react';
import type { ToolType, AppState, useAppDispatch } from '../store/app-state';
import { commands, invoke } from '../tauri';
import { getAgentSession } from './agent-session';
import { isConversationSession } from './chat-tools';
import { focusTerminal } from './focus-registry';

export interface ToolRequest { requestId: string; name: string; arguments: Record<string, unknown>; parentId?: string; sessionId?: string; background?: boolean }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function historyDirectory(path: string): string {
  const windows = /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\');
  if (windows) return path.replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').replace(/\/+$/, '').toLowerCase();
  return path.replace(/\/+$/, '') || '/';
}

interface ToolContext {
  stateRef: RefObject<AppState>;
  dispatch: ReturnType<typeof useAppDispatch>;
  pending: (requestId: string) => Promise<boolean>;
  isCancelled: (requestId: string) => boolean;
  openTimeoutMs?: number;
}
export function createAgentToolExecutor({ stateRef, dispatch, pending, isCancelled, openTimeoutMs = 15_000 }: ToolContext) {
    const project = () => {
      return stateRef.current.terminals.flatMap(tab => {
        const items = tab.tool ? [{ sessionId: tab.id, tool: tab.tool, cwd: tab.folderPath, status: tab.agentStatus }] : [];
        const session = getAgentSession(tab);
        return items.map(item => ({ ...item, tabId: tab.id, title: tab.toolTitle, mode: session?.mode ?? (isConversationSession(tab) ? 'desktop' : 'terminal'), generation: session?.generation ?? null, ready: session?.ready ?? false, localInputPending: session?.localInputPending ?? false, inputBusy: session?.inputBusy ?? false, error: session?.error }));
      }).map((item, index) => ({ number: index + 1, ...item }));
    };
    return async (request: ToolRequest): Promise<unknown> => {
      const args = request.arguments;
      if (!await pending(request.requestId)) throw new Error('操作已取消');
      if (request.name === 'sessions_list') return { sessions: project(), observedAt: new Date().toISOString() };
      if (request.name === 'tools_list') return { tools: [...await commands.listTools(), { id: 'terminal', displayName: 'Terminal' }], installed: await commands.checkToolsInstalled() };
      if (request.name === 'directory_create') {
        if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('请先指定新建目录的完整路径');
        return invoke<{ path: string; created: boolean }>('agent_create_directory', { path: args.path });
      }
      if (['workspace_list', 'file_read', 'file_create', 'file_edit'].includes(request.name)) {
        if (typeof args.cwd !== 'string' || !args.cwd.trim()) throw new Error('请先询问用户要操作哪个工作目录');
        return invoke('agent_workspace_tool', { name: request.name, arguments: args });
      }
      if (request.name === 'history_list') {
        const history = await commands.getNativeHistory();
        return { sessions: history.filter(item => (!args.tool || item.tool === args.tool) && (!args.cwd || historyDirectory(item.cwd) === historyDirectory(String(args.cwd)))).slice(0, 100) };
      }
      if (request.name === 'sessions_open') {
        if (typeof args.tool !== 'string' || !args.tool.trim()) throw new Error('请先询问用户要打开什么 CLI 工具');
        const tools = await commands.listTools();
        if (typeof args.tool !== 'string' || (args.tool !== 'terminal' && !tools.some(tool => tool.id === args.tool))) throw new Error('请选择已支持的 CLI 工具');
        if (typeof args.cwd !== 'string' || !args.cwd.trim()) throw new Error('请先询问用户要打开哪个目录');
        const cwd = await invoke<string>('agent_validate_directory', { path: args.cwd });
        if (!await pending(request.requestId)) throw new Error('操作已取消');
        const id = request.sessionId ?? crypto.randomUUID();
        if (stateRef.current.terminals.some(session => session.id === id)) throw new Error('该会话已存在，请读取状态，不要重复创建');
        let mode: 'terminal' | 'conversation' = 'conversation';
        try { if (localStorage.getItem(`coffee:${args.tool}-launch-mode`) === 'terminal') mode = 'terminal'; } catch { /* Use the desktop default when no preference is available. */ }
        dispatch({ type: 'LAUNCH_TERMINAL_TOOL', id, tool: args.tool as ToolType, cwd, strictCwd: true, resumeToken: typeof args.resumeToken === 'string' ? args.resumeToken : undefined, claudeMode: args.tool === 'claude' ? mode : undefined, codexMode: args.tool === 'codex' ? mode : undefined, parentId: request.parentId, background: request.background });
        const deadline = Date.now() + openTimeoutMs;
        let appeared = false;
        while (Date.now() < deadline) {
          if (isCancelled(request.requestId)) return { sessionId: id, cwd, opened: true, ready: false, message: '等待已取消；真实终端已打开' };
          if (stateRef.current.terminals.some(tab => tab.id === id)) appeared = true;
          else if (appeared) throw new Error('新终端已被用户关闭');
          const tab = stateRef.current.terminals.find(tab => tab.id === id);
          const session = tab && getAgentSession(tab);
          if (session?.error && !session.ready) return { sessionId: id, cwd, opened: true, ready: false, generation: session.generation, error: session.error };
          if (session?.ready) return { ...project().find(item => item.sessionId === id), opened: true, screen: await session.readScreen(), message: '会话已启动；请先读取内容核对状态。登录、信任和授权提示需要用户处理。' };
          await pause(100);
        }
        if (!stateRef.current.terminals.some(tab => tab.id === id)) throw new Error('新终端未能打开或已经关闭');
        return { sessionId: id, cwd, opened: true, ready: false, generation: project().find(item => item.sessionId === id)?.generation, message: '会话仍在启动，请重新读取会话清单后再发送' };
      }
      const sessionId = String(args.sessionId ?? '');
      const generation = String(args.generation ?? '');
      const resolve = () => { const tab = stateRef.current.terminals.find(tab => tab.id === sessionId); return tab && getAgentSession(tab); };
      const session = resolve();
      const target = project().find(item => item.sessionId === sessionId);
      if (!session || !target || !generation || session.generation !== generation) throw new Error('会话已关闭或重启，请重新读取终端清单');
      const guard = () => {
        const current = project().find(item => item.sessionId === sessionId);
        return !isCancelled(request.requestId) && resolve()?.generation === generation
          && current?.tool === target.tool
          && (typeof args.expectedCwd !== 'string' || historyDirectory(args.expectedCwd) === historyDirectory(current?.cwd ?? ''));
      };
      if (request.name === 'terminal_read_screen') return { ...await session.readScreen(args.view === 'viewport' ? 'viewport' : 'live'), tool: target.tool, cwd: target.cwd, language: stateRef.current.currentLang };
      if (request.name === 'terminal_read_scrollback') return session.readScrollback(typeof args.startRow === 'number' ? args.startRow : undefined, typeof args.limit === 'number' ? args.limit : undefined);
      if (request.name === 'sessions_select') {
        dispatch({ type: 'SET_ACTIVE_TERMINAL', id: target.tabId });
        requestAnimationFrame(() => { if (guard() && stateRef.current.activeTerminalId === target.tabId && !stateRef.current.agentPageActive && !stateRef.current.diffTabActive) focusTerminal(sessionId); });
        return { selected: true, ...target };
      }
      if (request.name === 'sessions_close') {
        await session.close();
        if (!guard()) throw new Error('关闭期间目标会话已改变');
        dispatch({ type: 'REMOVE_TERMINAL', id: target.tabId });
        return { closed: true, sessionId, generation };
      }
      if (request.name === 'terminal_send' || request.name === 'terminal_key') {
        if (typeof args.expectedCwd === 'string' && historyDirectory(args.expectedCwd) !== historyDirectory(target.cwd ?? '')) throw new Error('工作目录已经改变，请重新读屏并检查项目后再派发');
        const before = await session.readScreen();
        const interrupt = request.name === 'terminal_key' && args.key === 'CtrlC';
        if (!interrupt && 'freshness' in before && (before.freshness.gap || before.freshness.failed || before.freshness.flushState !== 'flushed')) throw new Error('终端输出尚未同步或存在丢失，暂不发送输入');
        const active = await pending(request.requestId);
        if (typeof args.expectedCwd === 'string' && historyDirectory(args.expectedCwd) !== historyDirectory(project().find(item => item.sessionId === sessionId)?.cwd ?? '')) throw new Error('工作目录已经改变，请重新检查项目后再派发');
        if (!active || !guard()) throw new Error('操作已取消或目标会话已改变');
        const live = resolve();
        if (!live || live.generation !== generation) throw new Error('目标会话已经改变');
        if (request.name === 'terminal_send') {
          if (typeof args.text !== 'string') throw new Error('消息必须是文本');
          await live.send(args.text, guard);
        } else await live.key(String(args.key), guard);
        await pause(200);
        if (!guard()) return { written: true, sessionId, generation, message: '输入已写入；会话随后关闭或操作已取消' };
        return { written: true, sessionId, generation, screen: await live.readScreen(), message: live.mode === 'desktop' ? '操作已提交到原桌面会话；请读取后续状态确认结果' : 'PTY 已接收输入；请依据屏幕判断执行结果' };
      }
      throw new Error(`不支持的 Agent 工具：${request.name}`);
    };
}
