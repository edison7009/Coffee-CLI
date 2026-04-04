import { useAppState } from '../store/app-state';
import { en } from './en';
import type { I18nKey } from './en';
import { zhCN } from './zh-CN';

const strings = { en, 'zh-CN': zhCN } as const;

export function useT() {
  const { state } = useAppState();
  return function t(key: I18nKey, vars?: Record<string, string | number>): string {
    const dict = strings[state.currentLang] as Record<string, string>;
    let str = dict[key] ?? (en as Record<string, string>)[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replace(`{${k}}`, String(v));
      }
    }
    return str;
  };
}
