// A window controlling another computer, operated by a Claude tab on this computer (src/window_control.rs).
// This computer asks the window through `window-control-request`; the window does it the way the user
// would, with the same tab tools the coordinator uses (lib/agent-tools.ts), and answers with
// `window_control_resolve`. While it is being operated it says so, and the user can pause it.
import { useEffect, useRef, useState } from 'react';
import { useAppDispatch, useAppStateRef } from '../../store/app-state';
import { createAgentToolExecutor, type ToolRequest } from '../../lib/agent-tools';
import { localInvoke, onLocalEvent } from '../../remote/local-ipc';
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
    const stop = onLocalEvent<ToolRequest>('window-control-request', payload => {
      void (async () => {
        const id = payload.requestId;
        let result: unknown;
        if (pausedRef.current) result = { ok: false, error: PAUSED };
        else {
          running.current.add(id); setWorking(count => count + 1);
          try { result = { ok: true, result: await execute(payload) }; }
          catch (error) { result = { ok: false, error: cancelled.current.has(id) ? PAUSED : error instanceof Error ? error.message : String(error) }; }
          finally { running.current.delete(id); cancelled.current.delete(id); if (!disposed) setWorking(count => count - 1); }
        }
        if (!disposed) await localInvoke('window_control_resolve', { requestId: id, result }).catch(() => {});
      })();
    });
    return () => { disposed = true; stop(); };
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
