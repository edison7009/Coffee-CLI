import type { ClaudeTranslate } from './claude-i18n';

export type DirectoryStatus = 'available' | 'missing' | 'not_directory' | 'unavailable';
export function directoryFailure(error: unknown) {
  const match = /^COFFEE_DIRECTORY:(missing|not_directory|unavailable):([\s\S]*)$/.exec(String(error));
  return match ? { status: match[1] as Exclude<DirectoryStatus, 'available'>, path: match[2] } : undefined;
}
export function directoryFailureMessage(error: unknown, t: ClaudeTranslate): string | undefined {
  const failure = directoryFailure(error);
  return failure ? `${t(failure.status === 'unavailable' ? 'directory.unavailable' : 'directory.missing')}\n${failure.path}` : undefined;
}
