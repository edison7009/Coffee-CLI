import { en, type I18nKey } from '../i18n/en';
import type { ClaudeCommand } from './claude-protocol';

export type ClaudeTranslate = (key: I18nKey, vars?: Record<string, string | number>) => string;

const effortKeys: Record<string, I18nKey> = {
  low: 'claude.effort.low', medium: 'claude.effort.medium', high: 'claude.effort.high',
  xhigh: 'claude.effort.xhigh', max: 'claude.effort.max', default: 'opencode.variant_default',
};
export function claudeEffortLabel(level: string, t: ClaudeTranslate): string {
  if (level === 'ultra') return 'Ultra';
  return effortKeys[level] ? t(effortKeys[level]) : level === 'ultracode' ? 'Ultracode' : level || t('claude.effort.title');
}

// Skills of the signed-in account carry no built-in flag, and a person's own skill may share their name, so the
// opening of the original text identifies them. Reworded upstream text simply stays in its original language.
const accountSkills: Record<string, string> = {
  'built-in-browser': 'Read this skill', 'chrome-browser': 'Read this skill', 'computer-use': 'Read this skill',
  'deep-research': 'Use this skill', docs: 'docs (editable docs', docx: 'Use this skill', 'google-workspace': 'Read this before',
  'import-memory': 'Import a memory export', morning: "Render the user's morning brief", pdf: 'Use this skill', pptx: 'Use this skill',
  'setup-writing-style': 'Learns how the user writes', 'skill-creator': 'Create new skills', xlsx: 'Use this skill',
};
/** Claude Code reports these in English. Commands we have no text for, and people's own, keep what they were given. */
export function claudeCommandDescription(command: ClaudeCommand, t: ClaudeTranslate): string {
  const key = `claude.command.${command.name}`;
  const lead = Object.hasOwn(accountSkills, command.name) ? accountSkills[command.name] : undefined;
  const ours = command.builtin === true || (lead !== undefined && command.description.startsWith(lead));
  return ours && Object.hasOwn(en, key) ? t(key as I18nKey) : command.description;
}
