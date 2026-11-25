// A window controlling another computer, operated by a Claude tab on this computer (src/window_control.rs).
// This computer asks the window through `window-control-request`; the window does it the way the user
// would, with the same tab tools the coordinator uses (lib/agent-tools.ts), and answers with
// `window_control_resolve`. While it is being operated it says so, and the user can pause it.
import { useEffect, useRef, useState } from 'react';
import { useAppDispatch, useAppStateRef } from '../../store/app-state';
import { createAgentToolExecutor, type ToolRequest } from '../../lib/agent-tools';
import { localInvoke, onLocalEvent } from '../../remote/local-ipc';
import { onRemoteStatus, remoteComputerName, remoteRequest } from '../../remote/bridge';
import { commands, invoke } from '../../tauri';
import { useT } from '../../i18n/useT';
import './WindowControlBridge.css';

const PAUSED = 'Paused by the user in this window. Do not retry; ask the user to resume.';

export function WindowControlBridge() {
  const stateRef = useAppStateRef(), dispatch = useAppDispatch();
  const t = useT();
  const [working, setWorking] = useState(0);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const cancelled = useRef(new Set<string>()), running = useRef(new Set<string>());

  useEffect(() => {
    let disposed = false;
    const isCancelled = (id: string) => disposed || cancelled.current.has(id);
    const execute = createAgentToolExecutor({ stateRef, dispatch, pending: async id => !isCancelled(id), isCancelled, openTimeoutMs: 60_000 });
    // Work this computer's coordination hands to the computer this window shows: that computer's own coordination
    // runs it, and its progress comes back below (`orchestration_remote_update`).
    // The folders this computer works in, each with its repository (one git call per folder, remembered).
    const repos = new Map<string, Promise<string | null>>();
    const repoOf = (path: string) => { let known = repos.get(path); if (!known) { known = invoke<string | null>('git_repo_key', { folder: path }).catch(() => null); repos.set(path, known); } return known; };
    const folders = () => {
      const seen = new Set<string>();
      const add = (path: unknown) => { if (typeof path === 'string' && path.trim()) seen.add(path); };
      const { terminals, activeTerminalId } = stateRef.current;
      add(terminals.find(tab => tab.id === activeTerminalId)?.folderPath);
      terminals.forEach(tab => add(tab.folderPath));
      try { Object.values(JSON.parse(localStorage.getItem('coffee:last-folder-by-tool') || '{}')).forEach(add); } catch { /* no saved folders */ }
      return [...seen].slice(0, 40);
    };
    const projects = () => Promise.all(folders().map(async path => ({ path, repo: await repoOf(path) })));
    const delegate = async (request: ToolRequest) => {
      const { repo, ...args } = request.arguments as Record<string, unknown> & { repo?: string | null };
      if (request.name === 'team_delegate' && !args.cwd) {
        // The project with this conversation's repository, else the folder this window shows now.
        const match = repo ? (await projects()).find(project => project.repo === repo) : undefined;
        args.cwd = match?.path ?? folders()[0];
      }
      const result = await remoteRequest(request.name === 'team_delegate' ? 'team.delegate' : 'team.call', args);
      schedule();
      return result;
    };
    // This computer's coordination learns what the other computer offers and how its delegated work is going.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = async () => {
      if (disposed) return;
      try {
        const [snapshot, installed, listing] = await Promise.all([
          invoke<{ agents?: string[] }>('orchestration_get'),
          commands.checkToolsInstalled(),
          remoteRequest<{ tasks?: unknown[] }>('team.call', { action: 'list' }).catch(() => ({ tasks: [] })),
        ]);
        const agents = (snapshot.agents ?? []).filter(tool => installed?.[tool]);
        if (!disposed) await localInvoke('orchestration_remote_update', { computer: remoteComputerName(), agents, tasks: listing.tasks ?? [], projects: await projects() });
      } catch { /* Offline: the next connection reports again. */ }
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void report(); }, 300); };
    const stopStatus = onRemoteStatus(status => { if (status === 'connected') schedule(); });
    let stopUpdates: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(({ listen }) => listen('orchestration-updated', schedule)).then(stop => { if (disposed) stop(); else stopUpdates = stop; }).catch(() => {});
    const heartbeat = setInterval(schedule, 30_000);
    // This computer asks to show a tab of work it handed over here.
    const stopShow = onLocalEvent<{ sessionId?: string }>('remote-show-tab', ({ sessionId }) => {
      if (sessionId && stateRef.current.terminals.some(tab => tab.id === sessionId)) dispatch({ type: 'SET_ACTIVE_TERMINAL', id: sessionId });
    });
    schedule();
    const stop = onLocalEvent<ToolRequest>('window-control-request', payload => {
      void (async () => {
        const id = payload.requestId;
        let result: unknown;
        if (pausedRef.current) result = { ok: false, error: PAUSED };
        else {
          running.current.add(id); setWorking(count => count + 1);
          try { result = { ok: true, result: await (payload.name === 'team_delegate' || payload.name === 'team_call' ? delegate(payload) : execute(payload)) }; }
          catch (error) { result = { ok: false, error: cancelled.current.has(id) ? PAUSED : error instanceof Error ? error.message : String(error) }; }
          finally { running.current.delete(id); cancelled.current.delete(id); if (!disposed) setWorking(count => count - 1); }
        }
        if (!disposed) await localInvoke('window_control_resolve', { requestId: id, result }).catch(() => {});
      })();
    });
    return () => { disposed = true; stop(); stopStatus(); stopShow(); stopUpdates?.(); clearInterval(heartbeat); clearTimeout(timer); };
  }, [dispatch, stateRef]);

  const pause = () => {
    pausedRef.current = true; setPaused(true);
    for (const id of running.current) cancelled.current.add(id);
  };
  const resume = () => { pausedRef.current = false; setPaused(false); };

  if (!working && !paused) return null;
  return (
    <div className="window-control-badge" role="status" data-paused={paused || undefined}>
      <span className="window-control-dot" aria-hidden="true" />
      <span>{t(paused ? 'remote.ai_control.paused' : 'remote.ai_control.active')}</span>
      <button type="button" onClick={paused ? resume : pause}>{t(paused ? 'remote.ai_control.resume' : 'remote.ai_control.pause')}</button>
    </div>
  );
}
