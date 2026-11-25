import type { AgentStatus } from '../store/app-state';

// Claude Code 2.1.228 replaced the 2.1.220 Braille frames with ◐/◑ (also
// verified in 2.1.278). Accept both pairs for older installations. Every
// non-busy state, including permission prompts, uses the static U+2733 prefix,
// so terminal title alone supports two states.
const CLAUDE_ACTIVITY_FRAMES = new Set(['⠂', '⠐', '◐', '◑']);
const CLAUDE_IDLE_MARK = '✳';

export interface ClaudeTerminalTitleState {
  status: AgentStatus;
  /** Stable title for Coffee's tab strip, without Claude's status prefix. */
  displayTitle: string;
}

/** Read Claude Code's native OSC 0 terminal title without guessing TUI state. */
export function parseClaudeTerminalTitle(title: string): ClaudeTerminalTitleState {
  const trimmed = title.trim();
  const prefix = trimmed.split(/\s+/, 1)[0];
  const hasKnownPrefix = CLAUDE_ACTIVITY_FRAMES.has(prefix) || prefix === CLAUDE_IDLE_MARK;

  return {
    status: CLAUDE_ACTIVITY_FRAMES.has(prefix) ? 'working' : 'idle',
    displayTitle: hasKnownPrefix ? trimmed.slice(prefix.length).trim() : trimmed,
  };
}
