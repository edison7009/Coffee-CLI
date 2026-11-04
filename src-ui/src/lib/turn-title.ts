import type { ClaudeMessage } from './claude-protocol';

/** The running turn's title: the description Claude Code gives its latest tool call in this
 *  turn (e.g. a Bash or Agent call's `description`), the way Claude Desktop titles a working
 *  turn. Sub-agent tool calls do not retitle the main turn. Undefined until one has a description. */
export function turnTitle(messages: readonly ClaudeMessage[], turnStartedAt: number | undefined): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user' || (turnStartedAt !== undefined && message.timestamp < turnStartedAt)) return undefined;
    if (!message.toolName || message.parentId) continue;
    const description = message.input?.description;
    if (typeof description === 'string' && description.trim()) return description.trim().replace(/\s+/g, ' ');
  }
  return undefined;
}
