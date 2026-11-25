import { useEffect, useLayoutEffect, useRef } from 'react';
import { useAppState, type ToolType } from '../../store/app-state';
import { getAgentSession } from '../../lib/agent-session';
import { sendSessionPrompt } from '../../lib/send-session-prompt';
import { dueAutomations, getAutomations, scheduleNext, setAutomations, type Automation, type AutomationRun } from '../../lib/automations';

const TICK_MS = 30_000;
const READY_TIMEOUT_MS = 120_000;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Runs automations as they fall due: a new desktop conversation opens in front, then gets the prompt once it connects. */
export function AutomationRunner() {
  const { state, dispatch } = useAppState();
  const stateRef = useRef(state);
  useLayoutEffect(() => { stateRef.current = state; }, [state]);
  const running = useRef(new Set<string>());

  useEffect(() => {
    const record = (id: string, run: AutomationRun) => setAutomations(current => current.map(item => item.id === id ? { ...item, lastRun: run } : item));
    const run = async (automation: Automation) => {
      const sessionId = crypto.randomUUID(), started = Date.now();
      try {
        const tool = automation.tool as ToolType;
        dispatch({ type: 'LAUNCH_TERMINAL_TOOL', id: sessionId, tool, cwd: automation.cwd, strictCwd: true,
          claudeMode: tool === 'claude' ? 'conversation' : undefined, codexMode: tool === 'codex' ? 'conversation' : undefined,
          opencodeMode: tool === 'opencode' ? 'conversation' : undefined, piMode: tool === 'pi' ? 'conversation' : undefined });
        const deadline = started + READY_TIMEOUT_MS;
        for (;;) {
          const tab = stateRef.current.terminals.find(item => item.id === sessionId);
          const session = tab && getAgentSession(tab);
          // Closed before it connected: nothing left to send to.
          if (!tab && Date.now() - started > 2_000) { record(automation.id, { at: started, sessionId, ok: false, error: 'closed' }); return; }
          if (tab && session?.ready) {
            const sent = await sendSessionPrompt(tab, automation.prompt);
            record(automation.id, sent ? { at: started, sessionId, ok: true } : { at: started, sessionId, ok: false, error: 'send' });
            return;
          }
          if (session?.error && !session.ready) { record(automation.id, { at: started, sessionId, ok: false, error: session.error }); return; }
          if (Date.now() > deadline) { record(automation.id, { at: started, sessionId, ok: false, error: 'timeout' }); return; }
          await pause(500);
        }
      } catch (error) {
        record(automation.id, { at: started, sessionId, ok: false, error: String(error) });
      } finally { running.current.delete(automation.id); }
    };
    const tick = (force?: string) => {
      const now = Date.now();
      const due = force ? getAutomations().filter(item => item.id === force) : dueAutomations(now);
      for (const automation of due) {
        if (running.current.has(automation.id)) continue;
        running.current.add(automation.id);
        // Move it on first, so a slow start never runs it twice; one missed while closed runs once.
        if (!force) setAutomations(current => current.map(item => item.id === automation.id ? scheduleNext({ ...item, lastRun: { at: now, ok: true } }, now) : item));
        void run(automation);
      }
    };
    const timer = window.setInterval(() => tick(), TICK_MS);
    const onRunNow = (event: Event) => { const id = (event as CustomEvent<string>).detail; if (typeof id === 'string') tick(id); };
    window.addEventListener('coffee-run-automation', onRunNow);
    // A run missed while Coffee was closed starts once, shortly after launch.
    const first = window.setTimeout(() => tick(), 5_000);
    return () => { window.clearInterval(timer); window.clearTimeout(first); window.removeEventListener('coffee-run-automation', onRunNow); };
  }, [dispatch]);
  return null;
}
