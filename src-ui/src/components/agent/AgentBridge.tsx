import { WorktreeJanitor } from '../center/WorktreeControl';
import { OrchestrationBridge } from './OrchestrationBridge';

/** Lives with the workspace: coordinator/worker orchestration and worktree cleanup. */
export function AgentBridge() {
  return <><OrchestrationBridge /><WorktreeJanitor /></>;
}
