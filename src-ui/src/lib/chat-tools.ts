import type { ToolType } from '../store/app-state';

const ENHANCED_TOOLS = new Set<ToolType>([
  'claude', 'codex', 'kimicode',
]);

/** Tools with source-grounded enhanced integration. All other tools stay
 * terminal-only, even when their native TUI happens to resemble a selector. */
export function supportsEnhancedTool(tool: ToolType | null | undefined): boolean {
  return Boolean(tool && ENHANCED_TOOLS.has(tool));
}

export function supportsConversationTool(tool: ToolType | null | undefined): boolean {
  return supportsEnhancedTool(tool);
}
