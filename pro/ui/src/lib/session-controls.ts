import { useSyncExternalStore } from 'react';
import { invoke, type ToolControlStatus } from '../tauri';

export type SessionControl = 'computer' | 'browser';
const EMPTY: SessionControl[] = [];
const sessions = new Map<string, { generation: string; controls: SessionControl[] }>();
const listeners = new Set<() => void>();

/** Capture configured capabilities before launching; later settings changes apply to future sessions. */
export async function readLaunchControls(tool: string | null): Promise<SessionControl[]> {
  if (!tool || tool === 'remote' || tool === 'terminal') return EMPTY;
  const kinds: SessionControl[] = ['computer', 'browser'];
  const enabled = await Promise.all(kinds.map(async kind => {
    try {
      const status = await invoke<ToolControlStatus>('get_tool_control', { kind });
      return status.ready && status.agents.some(agent => agent.tool === tool && agent.enabled && !agent.conflict);
    } catch { return false; }
  }));
  return kinds.filter((_, index) => enabled[index]);
}

export function setSessionControls(id: string, generation: string, controls: SessionControl[]) {
  sessions.set(id, { generation, controls }); listeners.forEach(listener => listener());
}
export function clearSessionControls(id: string, generation: string) {
  if (sessions.get(id)?.generation !== generation) return;
  sessions.delete(id); listeners.forEach(listener => listener());
}
export function useSessionControls(id: string) {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => sessions.get(id)?.controls ?? EMPTY, () => EMPTY);
}
