// personalization.ts — shared, pure data for the appearance/language controls.
//
// Extracted from Explorer.tsx so the new SettingsModal and the file-tree's
// icon renderer can both consume one source of truth (DRY). Only static option
// tables + small pure helpers live here — all dispatch/persistence wiring stays
// in the components.

import type { ThemeColor, ThemeShape, IconTheme } from '../store/app-state';

// ─── Theme colours (swatch grid) ─────────────────────────────────────────────
export const THEME_COLORS: { code: ThemeColor; labelKey: string; swatch: string; ring: string }[] = [
  { code: 'light',      labelKey: 'theme.color.light',      swatch: '#FAFAF7', ring: '#c4956a' },
  { code: 'dark',       labelKey: 'theme.color.dark',       swatch: '#1a1917', ring: '#c4956a' },
  { code: 'cappuccino', labelKey: 'theme.color.cappuccino', swatch: '#1a1a1a', ring: '#4a4a4a' },
  { code: 'sakura',     labelKey: 'theme.color.sakura',     swatch: '#221b28', ring: '#f8b4c8' },
  { code: 'lavender',   labelKey: 'theme.color.lavender',   swatch: '#221f2e', ring: '#c8b6ff' },
  { code: 'mint',       labelKey: 'theme.color.mint',       swatch: '#142623', ring: '#7ae8c8' },
  // Natural-material palette — independent of shape and terminal font color.
  // Near-black with a faint hue, not "colored theme".
  { code: 'obsidian',   labelKey: 'theme.color.obsidian',   swatch: '#0a0a0a', ring: '#5a5a5a' },
  { code: 'cobalt',     labelKey: 'theme.color.cobalt',     swatch: '#0a1020', ring: '#5a85b8' },
  { code: 'moss',       labelKey: 'theme.color.moss',       swatch: '#0b1612', ring: '#6a9878' },
  // Spider-Man hero (pairs with the carbon shape).
  { code: 'crimson',    labelKey: 'theme.color.crimson',    swatch: '#2a0d10', ring: '#e23b42' },
  { code: 'sunset',     labelKey: 'theme.color.sunset',     swatch: '#241408', ring: '#f5803b' },
  { code: 'amber',      labelKey: 'theme.color.amber',      swatch: '#20180a', ring: '#e8a72c' },
  { code: 'emerald',    labelKey: 'theme.color.emerald',    swatch: '#0a1c12', ring: '#24c281' },
  { code: 'teal',       labelKey: 'theme.color.teal',       swatch: '#0a2125', ring: '#2bc4c4' },
  { code: 'indigo',     labelKey: 'theme.color.indigo',     swatch: '#12142e', ring: '#6172f0' },
  { code: 'fuchsia',    labelKey: 'theme.color.fuchsia',    swatch: '#210f1d', ring: '#d94aa0' },
];

// ─── Theme shapes (corner/surface treatment) ─────────────────────────────────
export const THEME_SHAPES: { code: ThemeShape; label: string }[] = [
  { code: 'soft',   label: 'Soft'   },
  { code: 'slab',   label: 'Slab'   },
  { code: 'sharp',  label: 'Sharp'  },
  { code: 'glass',  label: 'Glass'  },
  { code: 'panel',  label: 'Panel'  },
  { code: 'carbon', label: 'Carbon' },
];

// ─── Task board form (to-do list vs sticky notes) ────────────────────────────
// Two presentations of the same task data, chosen in the settings "Tasks"
// section. Icons are inlined in SettingsModal (mirrors the other sections).
export const TASK_VIEW_MODES: { code: 'list' | 'note'; labelKey: string; subKey: string }[] = [
  { code: 'list', labelKey: 'task.view.list', subKey: 'task.view.list.sub' },
  { code: 'note', labelKey: 'task.view.note', subKey: 'task.view.note.sub' },
];

// ─── File-tree icon art themes ───────────────────────────────────────────────
export const ICON_ART_THEMES: { id: IconTheme; folderSrc: string }[] = [
  { id: 'outline',          folderSrc: '/icons/themes/outline/folder-closed.svg'          },
  { id: 'material',         folderSrc: '/icons/themes/material/folder-closed.svg'         },
  { id: 'vscode-icons',     folderSrc: '/icons/themes/vscode-icons/folder-closed.svg'     },
  { id: 'catppuccin-mocha', folderSrc: '/icons/themes/catppuccin-mocha/folder-closed.svg' },
  { id: 'devicon',          folderSrc: '/icons/themes/devicon/folder-closed.svg'          },
  { id: 'fluent',           folderSrc: '/icons/themes/fluent/folder-closed.svg'           },
  { id: 'symbols',          folderSrc: '/icons/themes/symbols/folder-closed.svg'          },
  { id: 'coffee',           folderSrc: '/icons/themes/coffee/folder-closed.svg'           },
];

// Themes whose SVGs use fill="currentColor" and should be tinted by the active
// theme's --accent (rendered via mask-image instead of <img>).
export const MASK_TINT_THEMES: IconTheme[] = ['devicon'];
export function isMaskTintTheme(theme: IconTheme): boolean {
  return MASK_TINT_THEMES.includes(theme);
}

// ─── Languages ───────────────────────────────────────────────────────────────
export const LANGUAGES = [
  { code: 'en',    label: 'English',    glyph: 'A'  },
  { code: 'zh-CN', label: '简体中文',   glyph: '文' },
  { code: 'zh-TW', label: '繁體中文',   glyph: '文' },
  { code: 'ja',    label: '日本語',     glyph: 'あ' },
  { code: 'ko',    label: '한국어',     glyph: '가' },
  { code: 'es',    label: 'Español',    glyph: 'Ñ'  },
  { code: 'fr',    label: 'Français',   glyph: 'Fr' },
  { code: 'de',    label: 'Deutsch',    glyph: 'De' },
  { code: 'pt',    label: 'Português',  glyph: 'Pt' },
  { code: 'ru',    label: 'Русский',    glyph: 'Я'  },
  { code: 'vi',    label: 'Tiếng Việt', glyph: 'Vi' },
];
