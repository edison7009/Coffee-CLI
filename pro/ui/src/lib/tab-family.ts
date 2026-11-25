// Which open tabs are another tab's sub-windows (a worker it assigned): Code's tab strip and Clean's rail show only
// the parent, with its sub-windows one hover away. A sub-window whose parent tab is gone shows as a tab of its own.
import type { TerminalSession } from '../store/app-state';
import { workerState, type OrchestrationTask } from './orchestration';

export interface TabChild { id: string; title: string; tool: TerminalSession['tool']; state: ReturnType<typeof workerState> | 'idle' }

export function tabFamilies(terminals: TerminalSession[], tasks: OrchestrationTask[]) {
  const byId = new Map(terminals.map(tab => [tab.id, tab]));
  const children = new Map<string, TabChild[]>();
  const childIds = new Set<string>();
  for (const tab of terminals) {
    if (!tab.tool) continue;
    const task = tasks.find(item => item.sessionId === tab.id && !item.detached);
    const parentId = task?.parentId ?? tab.parentId;
    if (!parentId || parentId === tab.id || !byId.get(parentId)?.tool) continue;
    childIds.add(tab.id);
    const list = children.get(parentId) ?? [];
    list.push({ id: tab.id, title: task?.title || tab.pinnedTitle || tab.toolTitle?.trim() || '', tool: tab.tool,
      state: task ? workerState(task, tab) : tab.agentStatus === 'working' ? 'working' : tab.agentStatus === 'wait_input' ? 'waiting' : 'idle' });
    children.set(parentId, list);
  }
  return { children, childIds };
}

/** The one state a parent's count shows for its sub-windows: one waiting on you first, then one at work. */
export function familyState(children: TabChild[]): 'waiting' | 'working' | 'idle' {
  return children.some(child => child.state === 'waiting') ? 'waiting' : children.some(child => child.state === 'working' || child.state === 'starting') ? 'working' : 'idle';
}
