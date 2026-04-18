// Workstation shared types — consumed by all workstation/*.tsx components.

/**
 * CLI kind = which AI tool the user wants inside a card's container.
 * We never ship the CLI; we detect what's installed on host and use that.
 */
export type CliKind = 'claude' | 'codex' | 'gemini' | 'qwen';

/**
 * Card lifecycle. Deliberately minimal — no "offline" state; if the runtime
 * is missing the activate button is just disabled at the UI layer.
 */
export type NodeStatus = 'inactive' | 'activating' | 'active' | 'failed';

/**
 * How a card's fresh container gets its initial state.
 * - `copy-local`: clone the user's host ~/.claude (or equivalent) — inherits
 *   auth, skills, settings. Best default for "it just works".
 * - `fresh`: empty ~/.claude; the user authenticates from zero inside.
 */
export type InitMode = 'copy-local' | 'fresh';

/**
 * One role/position on the canvas. Per product philosophy, a blueprint
 * only ships NAME + STRUCTURE — no model, no skills, no prompt. All
 * runtime config is the user's responsibility once the card is activated.
 */
export interface AgentNodeData {
  id: string;
  name: string;            // "主程序", "概念设计师"
  hint?: string;           // optional one-line description shown as tooltip
  position: { x: number; y: number };

  // Runtime state (not in blueprint; lives in canvas state)
  status: NodeStatus;
  cli?: CliKind;           // chosen at activation time
  runtime?: RuntimeKind;   // chosen at activation time (per-card, not per-team)
  initMode?: InitMode;
}

export interface AgentEdge {
  source: string;
  target: string;
}

/**
 * Blueprint = pure metadata. Names + structure + author attribution. No
 * content-layer config. Immutable once shipped.
 */
export interface Blueprint {
  id: string;
  name: string;            // "游戏工作室"
  icon: string;            // emoji or image URL
  description: string;
  author: string;          // "@alice"
  nodes: Array<{
    id: string;
    name: string;
    hint?: string;
    position: { x: number; y: number };
  }>;
  edges: AgentEdge[];
}

/**
 * Detection result for CLIs available on the host. Drives the activate
 * dialog's enabled/disabled radios.
 */
export interface CliAvailability {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  qwen: boolean;
}

/**
 * Which OCI-compatible runtime a specific team uses. Chosen per-team, not
 * per-host: the user might pick Docker for Game Team but Podman for Media
 * Team on the same machine. Platform stays out of the runtime business;
 * we just call whatever binary the user picked.
 */
export type RuntimeKind = 'docker' | 'podman';

/**
 * Host capacity read from the system. Phase 1 uses a rough estimate
 * (ram_gb - 4) * 1000 / 300; Phase 3 will replace with measured values.
 * `runtimesAvailable` lists whichever OCI runtimes are on PATH — teams
 * pick one from this list (may contain 0, 1, or 2 entries).
 */
export interface SystemCapacity {
  ramGb: number;
  cpuCores: number;
  platform: string;        // "darwin" | "linux" | "windows"
  estMaxAgents: number;
  runtimesAvailable: RuntimeKind[];   // subset of ['docker', 'podman']
}

/**
 * A live team on the canvas — the runtime incarnation of a Blueprint.
 * Runtime choice lives per-card (AgentNodeData.runtime), not per-team:
 * a single team may mix Docker and Podman freely. This doc is here to
 * remind readers that TeamState intentionally stays content-free.
 */
export interface TeamState {
  id: string;              // uuid, local-only
  blueprintId: string;     // source template; 'custom' if hand-built
  name: string;            // user-editable, defaults to blueprint.name
  nodes: AgentNodeData[];
  edges: AgentEdge[];
}
