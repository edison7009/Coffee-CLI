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
import { isTauri, commands } from '../../../tauri';
import { useAppState } from '../../../store/app-state';
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
  const { dispatch } = useAppState();
  const [activatingNodeId, setActivatingNodeId] = useState<string | null>(null);
  // Map of agent node id → container id returned by launch_agent. Kept in
  // a ref so the attach handler can read it without re-rendering nodes.
  const containerIds = useMemo(() => new Map<string, string>(), [team.id]);

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
    const node = nodes.find(n => n.id === id)?.data as AgentNodeData | undefined;
    if (!node) return;
    const containerId = containerIds.get(id);
    const runtime = node.runtime;
    const cli = node.cli;

    if (!isTauri) {
      onToast('dev preview 无法 attach — 请在 Tauri 环境运行');
      return;
    }
    if (!containerId || !runtime || runtime === 'none' || !cli) {
      onToast('分身暂不支持 attach（未隔离或信息缺失）');
      return;
    }

    // Open a new Coffee CLI tab at the outer level, tooled as 'agent-attach'.
    // Rust's tier_terminal_start parses toolData and spawns
    // `<runtime> exec -it <containerId> <cli>` under portable-pty.
    const sid = crypto.randomUUID();
    const toolData = JSON.stringify({
      runtime,
      containerId,
      cli,
      avatar: node.avatar ?? '👤',
      name: node.name,
    });
    dispatch({
      type: 'ADD_TERMINAL',
      session: {
        id: sid,
        tool: 'agent-attach',
        toolData,
        folderPath: null,
        scanData: null,
      },
    });
    dispatch({ type: 'SET_ACTIVE_TERMINAL', id: sid });
  }, [nodes, containerIds, dispatch, onToast]);

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

      // Dev preview (non-Tauri): fake the activation so the UI still demos.
      if (!isTauri) {
        onToast(`即将启动 ${config.name} · ${config.cli} · ${config.runtime} ...（dev preview，无容器）`);
        setTimeout(() => {
          updateNode(id, { status: 'active' });
        }, 1500);
        return;
      }

      // Phase 3c: actually spin up the container.
      onToast(`启动 ${config.name} · ${config.cli} · ${config.runtime} ...`);
      commands
        .launchAgent({
          teamId: team.id,
          agentId: id,
          cli: config.cli,
          runtime: config.runtime,
          avatar: config.avatar,
          name: config.name,
          description: config.description,
          heartbeat: config.heartbeat,
        })
        .then(containerId => {
          // Remember the container id so handleAttach can exec into it.
          containerIds.set(id, containerId);
          updateNode(id, { status: 'active' });
          onToast(`${config.name} 已上岗 · 容器 ${containerId.slice(0, 12)}`);
        })
        .catch(err => {
          updateNode(id, { status: 'failed' });
          onToast(`启动失败：${err}`);
        });
    },
    [activatingNodeId, team.id, updateNode, onToast],
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
