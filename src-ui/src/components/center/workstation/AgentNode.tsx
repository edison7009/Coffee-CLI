// AgentNode — one role card on the canvas. Rendered by react-flow as a
// custom node type. Phase 1 responsibilities:
//   - show name + optional hint tooltip
//   - show a status dot (inactive / activating / active / failed)
//   - surface "click to activate" affordance when inactive; "click to
//     attach" when active
//
// Destruction lives on the canvas toolbar for now to keep the card quiet.

import { Handle, Position } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import type { AgentNodeData, NodeStatus, CliKind } from './types';

// Extra callbacks injected by the canvas before rendering each node.
type AgentNodeRuntimeData = AgentNodeData & {
  onActivate?: (id: string) => void;
  onAttach?: (id: string) => void;
  [key: string]: unknown;
};

export type AgentFlowNode = Node<AgentNodeRuntimeData, 'agent'>;

const STATUS_COLOR: Record<NodeStatus, string> = {
  inactive:   'var(--text-2, #9e9c98)',
  activating: 'var(--accent, #C4956A)',
  active:     '#34d399',
  failed:     '#ef4444',
};

const STATUS_LABEL: Record<NodeStatus, string> = {
  inactive:   '未激活',
  activating: '激活中',
  active:     '已激活',
  failed:     '激活失败',
};

const CLI_LABEL: Record<CliKind, string> = {
  claude: 'Claude',
  codex:  'Codex',
  gemini: 'Gemini',
  qwen:   'Qwen',
};

export function AgentNode({ data }: NodeProps<AgentFlowNode>) {
  const { id, name, hint, status, cli } = data;

  const handleClick = () => {
    if (status === 'inactive' || status === 'failed') {
      data.onActivate?.(id);
    } else if (status === 'active') {
      data.onAttach?.(id);
    }
  };

  return (
    <div
      className={`agent-node agent-node--${status}`}
      title={hint}
      onClick={handleClick}
    >
      <Handle type="target" position={Position.Top} className="agent-node-handle" />

      <div className="agent-node-header">
        <span className="agent-node-name">{name}</span>
        <span
          className="agent-node-dot"
          style={{ background: STATUS_COLOR[status] }}
          title={STATUS_LABEL[status]}
        />
      </div>

      <div className="agent-node-meta">
        {status === 'active' && cli ? (
          <span className="agent-node-cli-badge">{CLI_LABEL[cli]}</span>
        ) : status === 'activating' ? (
          <span className="agent-node-hint">启动容器中...</span>
        ) : status === 'failed' ? (
          <span className="agent-node-hint agent-node-hint--error">点击重试</span>
        ) : (
          <span className="agent-node-hint">点击激活</span>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="agent-node-handle" />
    </div>
  );
}
