// WorkstationCanvas — the "team blueprint on a canvas" view.
//
// Renders nodes from the current TeamState via react-flow. Each node is
// an AgentNode (card). Clicking an inactive card opens ActivateDialog.
// Top-right shows the team's chosen runtime (Docker / Podman). We build
// the canvas; the user picks the runtime, picks the CLI, picks the
// config — all of that is content we don't touch.

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  addEdge,
  ReactFlowProvider,
} from '@xyflow/react';
import type { Connection, Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { AgentNode } from './AgentNode';
import type { AgentFlowNode } from './AgentNode';
import { ActivateDialog } from './ActivateDialog';
import type {
  TeamState,
  CliAvailability,
  RuntimeKind,
  AgentNodeData,
  AgentLaunchConfig,
} from './types';

interface Props {
  team: TeamState;
  availability: CliAvailability;
  availableRuntimes: RuntimeKind[];
  onTeamChange: (team: TeamState) => void;
  onToast: (msg: string) => void;
}

const nodeTypes = { agent: AgentNode };

function CanvasInner({
  team,
  availability,
  availableRuntimes,
  onTeamChange: _onTeamChange,
  onToast,
}: Props) {
  const [activatingNodeId, setActivatingNodeId] = useState<string | null>(null);

  const initialNodes: AgentFlowNode[] = useMemo(
    () => team.nodes.map(n => ({
      id: n.id,
      type: 'agent' as const,
      position: n.position,
      data: { ...n } as AgentNodeData & { [key: string]: unknown },
    })),
    [team.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const initialEdges: Edge[] = useMemo(
    () => team.edges.map((e, i) => ({
      id: `e-${i}`,
      source: e.source,
      target: e.target,
    })),
    [team.id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [team.id, initialNodes, initialEdges, setNodes, setEdges]);

  const updateNode = useCallback(
    (id: string, patch: Partial<AgentNodeData>) => {
      setNodes(ns => ns.map(n =>
        n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
      ));
    },
    [setNodes],
  );

  const handleActivate = useCallback((id: string) => {
    setActivatingNodeId(id);
  }, []);

  const handleAttach = useCallback((id: string) => {
    onToast(`即将 attach 到卡片 ${id} ...（Phase 4 实现）`);
  }, [onToast]);

  const handleConfirmActivate = useCallback(
    (config: AgentLaunchConfig) => {
      if (!activatingNodeId) return;
      const id = activatingNodeId;
      setActivatingNodeId(null);

      updateNode(id, {
        status: 'activating',
        name: config.name,
        avatar: config.avatar,
        description: config.description,
        cli: config.cli,
        runtime: config.runtime,
        heartbeatEnabled: config.heartbeat != null,
        heartbeatInterval: config.heartbeat?.interval,
        heartbeatPrompt: config.heartbeat?.prompt,
      });
      onToast(`即将启动 ${config.name} · ${config.cli} · ${config.runtime} ...（Phase 3c 实现真容器）`);

      setTimeout(() => {
        updateNode(id, { status: 'active' });
      }, 1500);
    },
    [activatingNodeId, updateNode, onToast],
  );

  const onConnect = useCallback(
    (params: Connection) => setEdges(eds => addEdge(params, eds)),
    [setEdges],
  );

  const nodesWithHandlers = useMemo(
    () => nodes.map(n => ({
      ...n,
      data: {
        ...n.data,
        onActivate: handleActivate,
        onAttach: handleAttach,
      },
    })),
    [nodes, handleActivate, handleAttach],
  );

  const activatingNode = activatingNodeId
    ? (nodes.find(n => n.id === activatingNodeId)?.data as AgentNodeData | undefined)
    : undefined;

  return (
    <div className="workstation-canvas">
      <div className="workstation-canvas-flow">
        <ReactFlow
          nodes={nodesWithHandlers}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} color="rgba(128,128,128,0.15)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {activatingNode && (
        <ActivateDialog
          roleName={activatingNode.name}
          roleDefaults={{
            avatar: activatingNode.avatar,
            description: activatingNode.description ?? activatingNode.hint,
          }}
          agentId={activatingNode.id}
          teamId={team.id}
          availability={availability}
          availableRuntimes={availableRuntimes}
          onConfirm={handleConfirmActivate}
          onCancel={() => setActivatingNodeId(null)}
        />
      )}
    </div>
  );
}

export function WorkstationCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
