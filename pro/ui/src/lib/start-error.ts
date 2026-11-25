import type { I18nKey } from '../i18n/en';

/**
 * A session's error as the conversation shows it: a tool that could not be started because its program is missing
 * reads as "not installed" instead of the operating system's message, and one already open elsewhere (Codex lets one
 * writer hold a thread: the ChatGPT app, another terminal, an editor extension or another tab) says so; anything else is shown as it came.
 */
export function startErrorText(error: string, tool: string, t: (key: I18nKey, vars?: Record<string, string | number>) => string): string {
  const missing = /could not start/i.test(error) && /no such file|not found|cannot find|os error 2|enoent/i.test(error);
  if (missing) return t('conversation.tool_missing', { tool });
  if (/already has an active writer|thread-store conflict/i.test(error)) return t('conversation.in_use');
  return error;
}
