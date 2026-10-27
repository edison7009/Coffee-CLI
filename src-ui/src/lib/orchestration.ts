import { useSyncExternalStore } from 'react';
import { commands } from '../tauri';
import type { TerminalSession } from '../store/app-state';

export interface OrchestrationTask {
  id: string; parentId: string; parentNativeId: string | null; sessionId: string; nativeId: string | null;
  parentTool: string; tool: 'claude' | 'codex' | 'opencode'; title: string; cwd: string; phase: string; summary: string | null;
  question: { id: string; text: string; answer: string | null } | null; generation: string | null; activity: string | null;
  detached?: boolean;
}
export interface OrchestrationSnapshot { enabled: boolean; agents: string[]; coordinators: string[]; tasks: OrchestrationTask[]; revision: number }
export interface ResultDelivery { id: string; parentId: string; generation: string; text: string }
let snapshot: OrchestrationSnapshot = { enabled: false, agents: [], coordinators: [], tasks: [], revision: 0 };
const listeners = new Set<() => void>();
export function receiveOrchestration(value: OrchestrationSnapshot) {
  if (value.revision < snapshot.revision) return;
  snapshot = value; listeners.forEach(listener => listener());
}
export function getOrchestrationSnapshot() { return snapshot; }
export function refreshOrchestration() { return commands.orchestrationGet().then(value => { receiveOrchestration(value); return value; }); }
export function useOrchestration() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, getOrchestrationSnapshot, getOrchestrationSnapshot);
}
export function workerState(task: OrchestrationTask, session?: TerminalSession) {
  if (task.phase === 'completed') return 'completed';
  if (task.phase === 'failed') return 'failed';
  if (task.phase === 'closed' || task.phase === 'interrupted') return 'closed';
  if (task.activity === 'error') return 'failed';
  if (task.phase === 'starting') return 'starting';
  if (task.question && !task.question.answer || task.phase === 'uncertain' || task.activity === 'disconnected' || (session?.agentStatus ?? task.activity) === 'wait_input') return 'waiting';
  if ((session?.agentStatus ?? task.activity) === 'working') return 'working';
  return 'idle';
}
