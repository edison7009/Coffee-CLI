import type { AgentStatus, ToolType } from '../store/app-state';

// Read-only signals, checked against Herdr's per-agent detection manifests:
// https://github.com/herdrdev/herdr/tree/5bd900d88c80d95f5b145397e45bbeea398b8165/src/detect/manifests
// Unknown titles/screens stay unknown; output activity alone is not work.
const SCREEN_TOOLS = new Set<ToolType>([
  'qwen', 'hermes', 'grok', 'antigravity', 'pi', 'copilot', 'cursor', 'cline', 'kiro', 'muse', 'mimocode', 'kilo',
]);

export function supportsAdditionalAgentStatus(tool: ToolType): boolean {
  return SCREEN_TOOLS.has(tool);
}

export function parseAdditionalAgentTitle(title: string, tool: ToolType): { status: AgentStatus; displayTitle: string } | null {
  const text = title.trim();
  const marks = tool === 'qwen' ? /^([◐✳])\uFE0E?\s+/u
    : tool === 'hermes' ? /^([⏳⚠✓])[\uFE0E\uFE0F]?\s+/u : null;
  const prefix = marks?.exec(text);
  if (prefix) return {
    status: prefix[1] === '✓' ? 'idle' : /[✳⚠]/u.test(prefix[1]) ? 'wait_input' : 'working',
    displayTitle: text.slice(prefix[0].length),
  };
  if (tool === 'grok') {
    if (/⚠[\uFE0E\uFE0F]?\s+Action Required\b/u.test(text)) return { status: 'wait_input', displayTitle: text.replace(/⚠[\uFE0E\uFE0F]?\s+Action Required\s*/u, '') };
    if (/(?:^|\s)[\u2801-\u28FF](?=\s|$)/u.test(text)) return { status: 'working', displayTitle: text.replace(/(?:^|\s)[\u2801-\u28FF](?=\s|$)/u, '').trim() };
    if (/(?:^| - )grok$/i.test(text)) return { status: 'idle', displayTitle: text };
  }
  return null;
}

/** Input is already rendered live bottom-buffer text, never raw PTY chunks or scrollback. */
export function parseAdditionalAgentScreen(lines: string[], tool: ToolType): AgentStatus | null {
  if (!SCREEN_TOOLS.has(tool)) return null;
  const recent = lines.slice(-20).filter(line => line.trim()).map(line => line.trim());
  const tail = recent.slice(-8);
  const text = tail.join('\n');
  const has = (pattern: RegExp) => tail.some(line => pattern.test(line));
  switch (tool) {
    case 'mimocode':
    case 'kilo':
      // MiMo's prompt footer and Kilo's manifest share the OpenCode hints.
      if (/△ Permission required/u.test(text)
        || (/esc dismiss/i.test(text) && /enter (?:confirm|submit|toggle)/i.test(text) && /↑↓ select|⇆ tab/u.test(text))) return 'wait_input';
      if (has(/\besc (?:again to )?interrupt\b/i)) return 'working';
      break;
    case 'qwen':
      if (has(/^⠏\s+.*(?:Waiting for user confirmation|等待用户确认|等待用戶確認)\.\.\.$/i)
        || (/yes, allow once/i.test(text) && /apply this change\?|allow execution of|do you want to proceed\?|shell command execution/i.test(text))) return 'wait_input';
      if (has(/^(?:[\u2801-\u28FF]|\.{1,2})?\s*.*\(\d+(?:m(?:\s+\d+s)?|s).*\s·\sesc to cancel\)$/iu)) return 'working';
      break;
    case 'hermes':
      if ((/allow once/i.test(text) && /deny/i.test(text) && /enter(?: to)? confirm|↑\/↓(?: to)? select/i.test(text))
        || (/hermes needs your|type your answer/i.test(text) && /enter send|press enter|enter(?: to)? confirm/i.test(text))) return 'wait_input';
      if (has(/msg=interrupt|ctrl\+c (?:to interrupt|cancel)/i)) return 'working';
      break;
    case 'grok':
      if (has(/^┃\s+[0-9a-z]+\s+\([●○]\)\s/u)
        || (/:select/i.test(text) && /ctrl\+o:yolo/i.test(text) && /ctrl\+c:cancel/i.test(text))) return 'wait_input';
      if (has(/^[\u2801-\u28FF]\s.*\[stop\]$/u)
        || (/ctrl\+\.:shortcuts/i.test(text) && /(?:esc|ctrl\+c):cancel/i.test(text))) return 'working';
      if (/ctrl\+\.:shortcuts/i.test(text)) return 'idle';
      break;
    case 'antigravity':
      if (/navigate/i.test(recent.slice(-2).join(' ')) && /tab amend|esc skip/i.test(recent.slice(-2).join(' '))) return 'wait_input';
      if (has(/^─{3,}\s*esc to cancel\b/i) || has(/^[\u2801-\u28FF]+\s+\S/u)) return 'working';
      if (has(/^\? for shortcuts$/i)) return 'idle';
      break;
    case 'pi':
      if (has(/^(?:── )?[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working(?: ─+)?$/u)) return 'working';
      break;
    case 'copilot':
      if (/esc(?: to)? cancel/i.test(text) && /enter(?: to)? (?:select|confirm|submit|accept)/i.test(text)) return 'wait_input';
      if (has(/^(?:◎\s+Waiting for background agents\b|.*\besc (?:to cancel|cancel|again to cancel|interrupt)\b)/i)) return 'working';
      break;
    case 'cursor':
      if (/waiting for approval/i.test(text) && /run this command\?/i.test(text) && /run \(once\) \(y\)|skip \(esc or n\)/i.test(text)) return 'wait_input';
      if (has(/ctrl\+c to stop/i) || has(/^(?:⬡|⬢|[\u2801-\u28FF]+)\s+\p{Alphabetic}+\w*ing\b/u)) return 'working';
      break;
    case 'cline':
      if (/Cline needs permission/i.test(text) && /Approve tool call\?/i.test(text) && /\[y\] Approve/i.test(text) && /\[n\] Deny/i.test(text)) return 'wait_input';
      if (has(/^[\u2801-\u28FF]\s+\S/u) || has(/^Thinking\.\.\. \(esc to cancel\)$/i)) return 'working';
      if (/\(Tab\)/.test(text) && /Shift\+Tab/.test(text) && has(/^❯(?:\s.*)?$/u)) return 'idle';
      break;
    case 'kiro':
      if (/esc to close/i.test(text) && /to navigate/i.test(text) && has(/^[>❯]\s*(?:allow|always allow|deny|always deny)$/i)) return 'wait_input';
      if (/kiro is working/i.test(text) && /type to steer/i.test(text) && /ctrl\+s to queue/i.test(text)) return 'working';
      if (has(/^[>›]\s*ask a question or describe a task(?:\s+(?:enter|↵))?$/i)) return 'idle';
      break;
    case 'muse':
      if ((/Enter to select/i.test(text) && /Tab for an optional note/i.test(text))
        || (/Enter to toggle/i.test(text) && /Esc to interrupt/i.test(text))
        || (/Allow this stage once/i.test(text) && /Always allow in this workspace/i.test(text))) return 'wait_input';
      if (has(/esc to interrupt/i)) return 'working';
      if (has(/^⟩(?:\s.*)?$/u)) return 'idle';
      break;
  }
  return null;
}
