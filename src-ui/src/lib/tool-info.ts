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

// Legacy / orphan tool labels — tools that no longer have a live registry
// entry but still surface in the history list. The backend keeps a scanner
// alive for orphan jsonl files (see server.rs collect_gemini_legacy_history_
// candidates) so users don't lose access to old conversations after a tool
// gets retired from the launchpad.
const LEGACY_DISPLAY_NAMES: Record<string, string> = {
  // Gemini CLI consumer access ends 2026-06-18; the launchpad tile was
  // swapped for Antigravity CLI on 2026-05-19. Existing `~/.gemini/tmp/`
  // sessions still appear in history under this label.
  gemini: 'Gemini CLI (legacy)',
};

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
  return cache?.get(id) ?? LEGACY_DISPLAY_NAMES[id] ?? id;
}
