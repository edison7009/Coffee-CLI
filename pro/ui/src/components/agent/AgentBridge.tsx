import { WorktreeJanitor } from '../center/WorktreeControl';
import { MobileRpcBridge } from './MobileRpcBridge';
import { OrchestrationBridge } from './OrchestrationBridge';

/** Lives with the workspace: coordinator/worker orchestration, Web access requests and worktree cleanup. */
export function AgentBridge() {
  return <><OrchestrationBridge /><MobileRpcBridge /><WorktreeJanitor /></>;
}
