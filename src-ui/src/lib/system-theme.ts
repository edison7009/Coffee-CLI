// system-theme.ts — map the OS light/dark preference onto Coffee CLI theme codes.
//
// "跟随系统 / Follow system" appearance: when enabled, the OS light mode maps to
// the `light` palette (明亮) and the OS dark mode maps to `obsidian` (代码黑).
// Kept as pure helpers so both the store (first-paint init) and App.tsx (live
// change subscription) share one source of truth — no duplicated magic strings.

import type { ThemeColor } from '../store/app-state';

// OS appearance → Coffee CLI theme code.
export const SYSTEM_THEME_PAIR: Record<'light' | 'dark', ThemeColor> = {
  light: 'light',
  dark: 'obsidian',
};

/** True when the OS currently prefers a dark appearance. */
export function systemPrefersDark(): boolean {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** Resolve the theme code the OS preference currently implies. */
export function systemThemeColor(): ThemeColor {
  return systemPrefersDark() ? SYSTEM_THEME_PAIR.dark : SYSTEM_THEME_PAIR.light;
}
