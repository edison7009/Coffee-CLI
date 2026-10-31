import type { TerminalSession, ToolType } from '../store/app-state';

export function isClaudeConversation(session: Pick<TerminalSession, 'tool' | 'claudeMode'> | undefined): boolean {
  return session?.tool === 'claude' && session.claudeMode !== 'terminal';
}

export function isCodexConversation(session: Pick<TerminalSession, 'tool' | 'codexMode'> | undefined): boolean {
  return session?.tool === 'codex' && session.codexMode === 'conversation';
}

/** DeepSeek Harness has no terminal mode in Coffee CLI: every tab is a desktop conversation. */
export function isDshConversation(session: Pick<TerminalSession, 'tool'> | undefined): boolean {
  return session?.tool === 'dsh';
}

export function isConversationSession(session: TerminalSession | undefined): boolean {
  return isClaudeConversation(session) || isCodexConversation(session) || isDshConversation(session);
}

const ENHANCED_TOOLS = new Set<ToolType>([
  'claude', 'codex', 'kimicode',
]);

const SELF_RENDERED_CARET_TOOLS = new Set<ToolType>([
  'claude', 'codex', 'kimicode',
]);

/** Tools with source-grounded enhanced integration. All other tools stay
 * terminal-only, even when their native TUI happens to resemble a selector. */
export function supportsEnhancedTool(tool: ToolType | null | undefined): boolean {
  return Boolean(tool && ENHANCED_TOOLS.has(tool));
}

/** Only hide xterm's cursor when the upstream TUI is verified to paint its own. */
export function usesSelfRenderedCaret(tool: ToolType | null | undefined): boolean {
  return Boolean(tool && SELF_RENDERED_CARET_TOOLS.has(tool));
}
