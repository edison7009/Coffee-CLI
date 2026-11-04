import type { TerminalSession } from '../store/app-state';
import { isClaudeConversation, isCodexConversation, isDshConversation, isOpenCodeConversation, isPiConversation } from './chat-tools';
import { controlClaude, sendClaudeInteractive, sendClaudeMessage } from './claude-session';
import { sendCodexInteractive, sendCodexMessage } from './codex-session';
import { sendDshMessage } from './dsh-session';
import { sendOpenCodeMessage } from './opencode-session';
import { sendPiMessage } from './pi-session';
import { submitTerminalPrompt } from './terminal-control';

/** Send through the existing conversation or terminal without opening another session. */
export async function sendSessionPrompt(session: Pick<TerminalSession, 'id' | 'tool' | 'claudeMode' | 'codexMode' | 'opencodeMode' | 'piMode' | 'parentId'> | undefined, text: string): Promise<boolean> {
  if (!session?.tool || !text.trim()) return false;
  try {
    if (isCodexConversation(session)) return await (session.parentId ? sendCodexMessage(session.id, text) : sendCodexInteractive(session.id, text));
    if (isDshConversation(session)) return await sendDshMessage(session.id, text);
    if (isOpenCodeConversation(session)) return await sendOpenCodeMessage(session.id, text);
    if (isPiConversation(session)) return await sendPiMessage(session.id, text);
    if (isClaudeConversation(session)) {
      if (/^\/plan\s+\S/.test(text)) {
        await controlClaude(session.id, { subtype: 'set_permission_mode', mode: 'plan' });
        return await sendClaudeMessage(session.id, text.replace(/^\/plan\s+/, ''));
      }
      // Workers belong to their coordinator and keep their conversation.
      return await (session.parentId ? sendClaudeMessage(session.id, text) : sendClaudeInteractive(session.id, text));
    }
    await submitTerminalPrompt(session.id, text);
    return true;
  } catch { return false; }
}
