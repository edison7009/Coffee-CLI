// Cached frontend mirror of the Rust tool registry (src/tools/).
//
// Loaded exactly once via `list_tools` IPC during App boot, then read
// synchronously by every component that needs a display name for a
// tool id (launchpad cards, tab labels, picker options, history rows,
// session titles). Replaces the five hardcoded `id → label` tables
// that used to live in CenterPanel / FourSplitGrid / MultiAgentGrid /
// TierTerminal / HistoryBoard.
//
// Until the load resolves, `getToolDisplayName(id)` falls back to the
// id itself — visible during the ~ms window between mount and IPC
// response. Components rendered after `loadToolInfo()` resolves see
// the canonical display name.
//
// Pseudo-tools not in the registry (`terminal`, `remote`) get the
// fallback path: callers either special-case them or pass through
// the id. Don't add them to the Rust registry — they don't have a
// binary to probe and don't need hook installation.

import { commands } from '../tauri';

interface ToolInfo {
  id: string;
  displayName: string;
}

let cache: Map<string, string> | null = null;
let pending: Promise<void> | null = null;

export async function loadToolInfo(): Promise<void> {
  if (cache) return;
  if (pending) return pending;
  pending = (async () => {
    try {
      const tools: ToolInfo[] = await commands.listTools();
      cache = new Map(tools.map((t) => [t.id, t.displayName]));
    } catch (e) {
      // IPC failure shouldn't block app boot — components will just
      // see id-as-label until a later retry. Log and move on.
      console.warn('[tool-info] list_tools IPC failed:', e);
      cache = new Map();
    }
  })();
  return pending;
}

export function getToolDisplayName(id: string): string {
  return cache?.get(id) ?? id;
}

// Tabs that show the status-grid ("Dynamic Island") indicator: every AI CLI.
// Hook-wired tools (claude/codex/opencode/mimocode/hermes/kimicode) drive it
// live off session.agentStatus; the rest have no status bus and sit at
// static 'idle' green — the "fake island" baseline so every AI-CLI tab reads
// consistently. Non-CLI tabs (terminal/remote/history/splits/installer) get
// no indicator.
export const TAB_STATUS_TOOLS = new Set<string>([
  'claude', 'codex', 'grok', 'opencode', 'mimocode', 'hermes',
  'antigravity', 'qwen', 'openclaw',
  'pi', 'crush', 'aider', 'kimicode', 'goose', 'copilot',
]);

// Tools whose last reply can be read back from an on-disk transcript —
// gates TierTerminal's "copy last reply" button / context-menu item.
// Backend: get_last_agent_reply in src/server.rs (claude transcript_path,
// codex rollout, kimi wire.jsonl, hermes state.db). Other AI CLIs have no
// transcript reader yet, so they don't get the button.
export const COPY_REPLY_TOOLS = new Set<string>([
  'claude', 'codex', 'kimicode', 'hermes',
]);
