import type { TerminalSession } from '../store/app-state';
import { isClaudeConversation, isCodexConversation } from './chat-tools';
import { controlClaude, sendClaudeMessage } from './claude-session';
import { sendCodexMessage } from './codex-session';
import { submitTerminalPrompt } from './terminal-control';

/** Send through the existing conversation or terminal without opening another session. */
export async function sendSessionPrompt(session: Pick<TerminalSession, 'id' | 'tool' | 'claudeMode' | 'codexMode'> | undefined, text: string): Promise<boolean> {
  if (!session?.tool || !text.trim()) return false;
  try {
    if (isCodexConversation(session)) return await sendCodexMessage(session.id, text);
    if (isClaudeConversation(session)) {
      if (/^\/plan\s+\S/.test(text)) {
        await controlClaude(session.id, { subtype: 'set_permission_mode', mode: 'plan' });
        return await sendClaudeMessage(session.id, text.replace(/^\/plan\s+/, ''));
      }
      return await sendClaudeMessage(session.id, text);
    }
    await submitTerminalPrompt(session.id, text);
    return true;
  } catch { return false; }
}
