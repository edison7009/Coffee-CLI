import { useAppState } from '../store/app-state';
import { en } from './en';
import type { I18nKey } from './en';
import { zhCN } from './zh-CN';
import { zhTW } from './zh-TW';
import { ja } from './ja';
import { ko } from './ko';
import { es } from './es';
import { fr } from './fr';
import { de } from './de';
import { pt } from './pt';
import { ru } from './ru';
import { vi } from './vi';

const strings: Record<string, Record<string, string>> = {
  en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, es, fr, de, pt, ru, vi,
};

export function useT() {
  const { state } = useAppState();
  return function t(key: I18nKey, vars?: Record<string, string | number>): string {
    const dict = strings[state.currentLang] ?? en;
    let str = dict[key] ?? (en as Record<string, string>)[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replace(`{${k}}`, String(v));
      }
    }
    return str;
  };
}
