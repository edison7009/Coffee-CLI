import { useEffect } from 'react';
import { useAppDispatch, useAppState, useAppStateRef } from '../../store/app-state';
import { invoke, isTauri } from '../../tauri';
import { createAgentToolExecutor, type ToolRequest } from '../../lib/agent-tools';
import { receiveAgentEvent, receiveConversationChanged, receiveChannelStatus, refreshChannels, refreshAgentConversation, refreshAgentConversations, type AgentEvent, type ChannelSettings } from '../../lib/agent-client';
import { setSentinelEnabled, updateSentinelSessions } from '../../lib/agent-sentinel';
import { OrchestrationBridge } from './OrchestrationBridge';

/** Lives with the workspace, independently of Agent/configuration tabs and the sidebar. */
export function AgentBridge() {
  const stateRef = useAppStateRef();
  const dispatch = useAppDispatch();
  const { state } = useAppState();
  useEffect(() => { updateSentinelSessions(state.terminals, state.currentLang); }, [state.terminals, state.currentLang]);
  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let modesRevision = 0;
    const unlisteners: (() => void)[] = [];
    const cancelled = new Set<string>();
    const pending = async (id: string) => {
      if (disposed || cancelled.has(id)) return false;
      const active = await invoke<boolean>('agent_tool_is_pending', { requestId: id });
      return active && !disposed && !cancelled.has(id);
    };
    const execute = createAgentToolExecutor({ stateRef, dispatch, pending, isCancelled: id => disposed || cancelled.has(id) });
    const start = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      for (const stop of await Promise.all([
        listen<ToolRequest>('agent-tool-request', async ({ payload }) => {
          let result: unknown;
          try { result = { ok: true, result: await execute(payload) }; }
          catch (error) { result = { ok: false, uncertain: error instanceof Error && 'uncertain' in error && error.uncertain === true, error: String(error) }; }
          if (!disposed) await invoke('agent_resolve_tool', { requestId: payload.requestId, result }).catch(() => {});
          cancelled.delete(payload.requestId);
        }),
        listen<{ requestId: string }>('agent-tool-cancelled', ({ payload }) => cancelled.add(payload.requestId)),
        listen<AgentEvent>('agent-event', ({ payload }) => receiveAgentEvent(payload)),
        listen<string>('agent-conversations-changed', ({ payload }) => receiveConversationChanged(payload)),
        listen<ChannelSettings>('channel-status', ({ payload }) => receiveChannelStatus(payload)),
        listen<{ sentinel: boolean }>('agent-work-modes', ({ payload }) => { modesRevision++; setSentinelEnabled(payload.sentinel); }),
      ])) { if (disposed) stop(); else unlisteners.push(stop); }
      if (!disposed) {
        await invoke('agent_bridge_ready');
        const revision = modesRevision;
        const modes = await invoke<{ sentinel: boolean }>('agent_get_work_modes');
        if (!disposed && revision === modesRevision) setSentinelEnabled(modes.sentinel);
        await Promise.allSettled([refreshChannels(), refreshAgentConversation(), refreshAgentConversations()]);
      }
    };
    start().catch(error => console.error('[AgentBridge]', error));
    return () => { disposed = true; setSentinelEnabled(false); unlisteners.forEach(stop => stop()); };
  }, [dispatch, stateRef]);
  return <OrchestrationBridge />;
}
