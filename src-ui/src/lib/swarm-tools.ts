/** Tools whose welcome screen gathers a star field into their icon (ToolSwarm). */
export const SWARM_TOOLS = ['claude', 'codex', 'dsh', 'opencode', 'pi', 'antigravity', 'cursor', 'kiro', 'muse', 'goose', 'kilo', 'kimicode', 'grok', 'cline', 'codebuddy', 'copilot', 'qwen'] as const;
export type SwarmTool = typeof SWARM_TOOLS[number];
export const isSwarmTool = (tool: string | null | undefined): tool is SwarmTool => !!tool && (SWARM_TOOLS as readonly string[]).includes(tool);
