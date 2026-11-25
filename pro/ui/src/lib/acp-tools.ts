// The tools whose desktop conversation runs over ACP (Agent Client Protocol): one shared session, protocol, view and
// composer for all of them. Keep in step with `acp_args` in src/acp_session.rs, which holds how each one starts.
export const ACP_TOOLS = ['antigravity', 'cursor', 'kiro', 'muse', 'goose', 'kilo', 'kimicode', 'grok', 'cline', 'codebuddy', 'copilot', 'qwen'] as const;
export type AcpTool = typeof ACP_TOOLS[number];
const SET: ReadonlySet<string> = new Set(ACP_TOOLS);
export const isAcpTool = (tool: string | undefined | null): tool is AcpTool => !!tool && SET.has(tool);
/** A new tab's view: Antigravity, the first and checked end to end, opens as a conversation; the others keep their
 *  terminal until the person picks the desktop view. */
export const acpDefaultMode = (tool: string): 'terminal' | 'conversation' => tool === 'antigravity' ? 'conversation' : 'terminal';
/** The person's terminal / desktop choice for an ACP tool, under the key every tool uses, else its default. */
export function acpLaunchMode(tool: string): 'terminal' | 'conversation' {
  let saved: string | null = null;
  try { saved = localStorage.getItem(`coffee:${tool}-launch-mode`); } catch { /* optional preference */ }
  return saved === 'terminal' || saved === 'conversation' ? saved : acpDefaultMode(tool);
}
