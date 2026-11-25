import { useSyncExternalStore } from 'react';
import { commands } from '../tauri';
import type { TerminalSession } from '../store/app-state';

export interface OrchestrationTask {
  id: string; parentId: string; parentNativeId: string | null; sessionId: string; nativeId: string | null;
  parentTool: string; tool: 'claude' | 'codex' | 'opencode' | 'dsh' | 'pi' | 'antigravity'; title: string; cwd: string; phase: string; summary: string | null;
  question: { id: string; text: string; answer: string | null } | null; generation: string | null; activity: string | null;
  detached?: boolean;
  hidden?: boolean;
  resultDelivery?: string | null;
  /** Present when the worker was started in its own git worktree. */
  worktree?: { root: string; path: string; branch: string } | null;
  /** Work on another computer: the window that controls it. `tool` is then the helper's own tool. */
  remote?: { window: string; computer: string; taskId: string | null; sessionId?: string | null } | null;
}
export type OrchestrationMode = 'auto' | 'manager' | 'lead';
export interface OrchestrationSnapshot { enabled: boolean; agents: string[]; mode?: OrchestrationMode; deviceAccess?: 'restricted' | 'full'; coordinators: string[]; tasks: OrchestrationTask[]; revision: number; picks?: Record<string, string[]>;
  /** Helpers on other computers right now, from their open windows (`tool@computer` in picks and tasks). */
  remote?: { window: string; computer: string; agents: string[]; projects?: { path: string; repo: string | null }[] }[] }
/** `parentId` is the target tab: the coordinator for results, the worker itself for a retry. */
export interface ResultDelivery { id: string; parentId: string; generation: string; text: string; kind?: 'retry' }
let snapshot: OrchestrationSnapshot = { enabled: false, agents: [], coordinators: [], tasks: [], revision: 0 };
const listeners = new Set<() => void>();
export function receiveOrchestration(value: OrchestrationSnapshot) {
  if (value.revision < snapshot.revision) return;
  // A helper on another computer is `tool@computer` in the hub; the UI shows its tool and, beside it, the computer.
  const tasks = value.tasks.map(task => task.remote ? { ...task, tool: task.tool.split('@')[0] as OrchestrationTask['tool'] } : task);
  snapshot = { ...value, tasks }; listeners.forEach(listener => listener());
}
export function getOrchestrationSnapshot() { return snapshot; }
export function refreshOrchestration() { return commands.orchestrationGet().then(value => { receiveOrchestration(value); return value; }); }
export function useOrchestration() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, getOrchestrationSnapshot, getOrchestrationSnapshot);
}
export function workerState(task: OrchestrationTask, session?: TerminalSession) {
  if (!['starting', 'running', 'uncertain'].includes(task.phase)) {
    if (session?.agentStatus === 'working') return 'working';
    if (session?.agentStatus === 'wait_input') return 'waiting';
  }
  if (task.phase === 'completed') return 'completed';
  if (task.phase === 'failed') return 'failed';
  if (task.phase === 'closed' || task.phase === 'interrupted') return 'closed';
  if (task.activity === 'error') return 'failed';
  if (task.phase === 'starting') return 'starting';
  if (task.question && !task.question.answer || task.phase === 'uncertain' || task.activity === 'disconnected' || (session?.agentStatus ?? task.activity) === 'wait_input') return 'waiting';
  if ((session?.agentStatus ?? task.activity) === 'working') return 'working';
  return 'idle';
}
