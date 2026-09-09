import type { AgentStatus } from '../store/app-state';

// OMP's title-generator.ts (v17.2.12) emits `π <state> <label>`:
// https://github.com/can1357/oh-my-pi/blob/v17.2.12/packages/coding-agent/src/utils/title-generator.ts
// Windows uses `:` for working; other platforms animate the Braille frames.
// The space after π matters: `π: label` has title-state reporting disabled.
const OMP_STATE_PREFIX_RE = /^π\s+([>!:⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])(?=\s|$)\s*/u;

export interface OmpTerminalTitleState {
  status: AgentStatus;
  /** Stable session label without OMP's brand and state separator. */
  displayTitle: string;
}

/** Read OMP's native terminal title without inspecting its rendered TUI. */
export function parseOmpTerminalTitle(title: string): OmpTerminalTitleState {
  const trimmed = title.trim();
  const prefix = trimmed.match(OMP_STATE_PREFIX_RE);
  if (!prefix) return { status: 'idle', displayTitle: trimmed };

  return {
    status: prefix[1] === '!' ? 'wait_input' : prefix[1] === '>' ? 'idle' : 'working',
    displayTitle: trimmed.slice(prefix[0].length).trim() || 'π',
  };
}
