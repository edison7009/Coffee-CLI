import { useEffect } from 'react';
import { useAppDispatch, useAppStateRef } from '../../store/app-state';
import { commands, isTauri } from '../../tauri';
import { createAgentToolExecutor, type ToolRequest } from '../../lib/agent-tools';
import { getAgentSession } from '../../lib/agent-session';
import { getOrchestrationSnapshot, receiveOrchestration, refreshOrchestration, type OrchestrationSnapshot } from '../../lib/orchestration';

export function OrchestrationBridge() {
  const stateRef = useAppStateRef(), dispatch = useAppDispatch();
  useEffect(() => {
    if (!isTauri) return;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    const stops: (() => void)[] = [], scopes = new Map<string, { parentId: string; generation: string; worker?: string }>();
    const cancelled = (id: string) => {
      const scope = scopes.get(id), tab = stateRef.current.terminals.find(tab => tab.id === scope?.parentId);
      const snapshot = getOrchestrationSnapshot();
      return disposed || !snapshot.enabled || !scope || !tab || getAgentSession(tab)?.generation !== scope.generation || Boolean(scope.worker && !snapshot.agents?.includes(scope.worker));
    };
    const pending = async (id: string) => !cancelled(id) && await commands.orchestrationPending(id) && !cancelled(id);
    const execute = createAgentToolExecutor({ stateRef, dispatch, pending, isCancelled: cancelled, openTimeoutMs: 60_000 });
    const sync = async () => {
      if (disposed) return;
      const sessions = stateRef.current.terminals.filter(tab => tab.tool).map(tab => {
        const session = getAgentSession(tab);
        return { id: tab.id, tool: tab.tool, cwd: tab.folderPath ?? '', nativeId: tab.resumeToken ?? null, generation: session?.generation ?? null, ready: session?.ready ?? false, status: tab.agentStatus ?? null, error: session?.error ?? null };
      });
      try { await commands.orchestrationSync(sessions); } catch { /* Retry the live registry on the next tick. */ }
      if (!disposed) timer = setTimeout(() => { void sync(); }, 1000);
    };
    const start = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const bindings = await Promise.all([
        listen<OrchestrationSnapshot>('orchestration-updated', ({ payload }) => receiveOrchestration(payload)),
        listen<ToolRequest>('orchestration-request', async ({ payload }) => {
          let result: unknown;
          try {
            const parent = stateRef.current.terminals.find(tab => tab.id === payload.parentId && tab.tool);
            const generation = parent && getAgentSession(parent)?.generation;
            if (parent && generation) scopes.set(payload.requestId, { parentId: parent.id, generation, worker: payload.name === 'team_worker_start' ? String(payload.arguments.tool) : undefined });
            if (!parent || !await pending(payload.requestId)) throw new Error('Coordinator closed or request expired');
            if (payload.name === 'team_worker_start') {
              const opened = await execute({ ...payload, name: 'sessions_open' }) as { ready?: boolean; sessionId: string; generation?: string; error?: string };
              if (!opened.ready || !opened.generation) throw new Error(opened.error ?? 'Worker is not ready. Its tab has been retained; inspect it before retrying.');
              await waitForWorkerPrompt(opened.sessionId, opened.generation, stateRef, () => pending(payload.requestId));
              result = await execute({ requestId: payload.requestId, name: 'terminal_send', arguments: { sessionId: opened.sessionId, generation: opened.generation, expectedCwd: payload.arguments.cwd, text: payload.arguments.text } });
            } else if (['terminal_read_screen', 'terminal_key', 'terminal_send'].includes(payload.name)) {
              if (payload.name === 'terminal_send') await waitForWorkerPrompt(String(payload.arguments.sessionId), String(payload.arguments.generation), stateRef, () => pending(payload.requestId));
              result = await execute(payload);
            }
            else throw new Error('Unsupported coordination request');
            result = { ok: true, result };
          } catch (error) { result = { ok: false, error: String(error) }; }
          if (!disposed) await commands.orchestrationResolve(payload.requestId, result).catch(() => {});
          scopes.delete(payload.requestId);
          void refreshOrchestration().catch(() => {});
        }),
      ]);
      for (const stop of bindings) { if (disposed) stop(); else stops.push(stop); }
      if (!disposed) { await refreshOrchestration(); void sync(); }
    };
    void start().catch(error => console.error('[OrchestrationBridge]', error));
    return () => { disposed = true; if (timer) clearTimeout(timer); stops.forEach(stop => stop()); };
  }, [dispatch, stateRef]);
  return null;
}

async function waitForWorkerPrompt(id: string, generation: string, stateRef: ReturnType<typeof useAppStateRef>, pending: () => Promise<boolean>) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && await pending()) {
    const tab = stateRef.current.terminals.find(tab => tab.id === id), session = tab && getAgentSession(tab);
    if (!session || session.generation !== generation) throw new Error('Worker closed or restarted');
    const screen = await session.readScreen();
    if ('pendingRequests' in screen && screen.pendingRequests.length || tab?.agentStatus === 'wait_input') throw new Error('Worker needs user approval. Its tab has been retained; handle the prompt before sending a task.');
    if (session.mode === 'desktop' || tab?.agentStatus === 'idle') return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Worker prompt is not confirmed ready. Inspect the retained tab; no task was sent.');
}
