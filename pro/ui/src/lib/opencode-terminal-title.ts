import type { AgentStatus } from '../store/app-state';

/** Frames emitted by Coffee's process-local OpenCode v2 TUI adapter. */
export function parseOpenCodeTerminalTitle(title: string): {
  status: AgentStatus | undefined;
  displayTitle: string;
} | null {
  const frame = title.match(/^CoffeeCLI:OpenCode:v2:(idle|working|wait_input|unknown) \| (.*)$/);
  if (!frame) return null;
  return {
    status: frame[1] === 'unknown' ? undefined : frame[1] as AgentStatus,
    displayTitle: frame[2].trim() || 'OpenCode',
  };
}
