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
  name: string;            // display name — pre-filled from blueprint, editable on launch
  avatar?: string;         // emoji or URL; defaults to '👤' in the dialog
  description?: string;    // longer purpose description (what this role does)
  hint?: string;           // legacy one-line tooltip from blueprint (kept for compat)
  position: { x: number; y: number };

  // Runtime state (not in blueprint; set when the agent is launched)
  status: NodeStatus;
  cli?: CliKind;
  runtime?: RuntimeKind;
  initMode?: InitMode;     // deprecated

  // Heartbeat — optional scheduled cron inside the container. User-authored,
  // never auto-filled. Empty/disabled by default to keep costs at zero.
  heartbeatEnabled?: boolean;
  heartbeatInterval?: string;    // human form: "10m" / "1h" / "daily-9am"
  heartbeatPrompt?: string;      // what to run on each beat
}

/**
 * Payload delivered by ActivateDialog's onConfirm. Keeps call sites tidy
 * and lets us grow the fields without re-threading signatures everywhere.
 */
export interface AgentLaunchConfig {
  avatar: string;
  name: string;
  description: string;
  cli: CliKind;
  runtime: RuntimeKind;
  heartbeat?: {
    interval: string;
    prompt: string;
  };
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
    avatar?: string;       // optional default avatar for this role
    description?: string;  // optional longer description
    hint?: string;         // optional tooltip (legacy)
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
 * Deployment choice per card:
 * - 'docker' / 'podman': container-isolated (Full tier)
 * - 'none': run directly on the host, no container (Lite tier — the
 *   escape hatch for users without Docker/Podman, or who just want
 *   a quick attach without paying the isolation cost)
 */
export type RuntimeKind = 'docker' | 'podman' | 'none';

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
