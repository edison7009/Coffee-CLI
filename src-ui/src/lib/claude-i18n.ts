import type { I18nKey } from '../i18n/en';

export type ClaudeTranslate = (key: I18nKey, vars?: Record<string, string | number>) => string;

const effortKeys: Record<string, I18nKey> = {
  low: 'claude.effort.low', medium: 'claude.effort.medium', high: 'claude.effort.high',
  xhigh: 'claude.effort.xhigh', max: 'claude.effort.max', default: 'opencode.variant_default',
};
export function claudeEffortLabel(level: string, t: ClaudeTranslate): string {
  if (level === 'ultra') return 'Ultra';
  return effortKeys[level] ? t(effortKeys[level]) : level === 'ultracode' ? 'Ultracode' : level || t('claude.effort.title');
}
