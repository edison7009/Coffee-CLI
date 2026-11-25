import type { AgentStatus } from '../store/app-state';

// Codex's default `tui.terminal_title` is ["activity", "project-name"].
// The activity item emits one of these frames while work is in flight and
// disappears when the turn is idle.
const CODEX_ACTIVITY_FRAMES = new Set([
  '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏',
]);

// Current Codex writes "[ ! ] Action Required" and blinks it as
// "[ . ] Action Required". Accept the compact [!] form as well so this keeps
// working with older/newer display-spacing changes.
const ACTION_REQUIRED_RE = /^\[\s*([!.])\s*\](?:\s+Action Required)?(?=\s|$)\s*/i;

export interface CodexTerminalTitleState {
  status: AgentStatus;
  /** Stable title for Coffee's tab strip, with Codex's activity prefix removed. */
  displayTitle: string;
}

/** Read Codex's own OSC 0 terminal title as the authoritative agent state. */
export function parseCodexTerminalTitle(title: string): CodexTerminalTitleState {
  const actionRequired = title.match(ACTION_REQUIRED_RE);
  if (actionRequired) {
    return {
      status: 'wait_input',
      displayTitle: cleanTitle(title.slice(actionRequired[0].length)),
    };
  }

  let sawActivity = false;
  const withoutActivity = title
    .split(/\s+/)
    .filter((part) => {
      if (CODEX_ACTIVITY_FRAMES.has(part)) {
        sawActivity = true;
        return false;
      }
      return true;
    })
    .join(' ');

  return {
    status: sawActivity ? 'working' : 'idle',
    displayTitle: cleanTitle(withoutActivity),
  };
}

function cleanTitle(title: string): string {
  return title
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
