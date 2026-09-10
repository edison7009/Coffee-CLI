// personalization.ts — shared, pure data for the appearance/language controls.
//
// Extracted from Explorer.tsx so the new SettingsModal and the file-tree's
// icon renderer can both consume one source of truth (DRY). Only static option
// tables + small pure helpers live here — all dispatch/persistence wiring stays
// in the components.

import type { ThemeColor, ThemeShape, IconTheme } from '../store/app-state';
import type { I18nKey } from '../i18n/en';

// ─── Theme colours (swatch grid) ─────────────────────────────────────────────
export const THEME_COLORS: { code: ThemeColor; labelKey: I18nKey; swatch: string; ring: string }[] = [
  // Columns: neutral, rose, orange, green, blue, violet; rows: soft to deep.
  // Stable codes preserve saved preferences when a palette is renamed.
  { code: 'light',      labelKey: 'theme.color.light',      swatch: '#eeece6', ring: '#5c6267' },
  { code: 'sakura',     labelKey: 'theme.color.sakura',     swatch: '#262024', ring: '#dab2be' },
  { code: 'amber',      labelKey: 'theme.color.amber',      swatch: '#272219', ring: '#d2b28e' },
  { code: 'mint',       labelKey: 'theme.color.mint',       swatch: '#1f2723', ring: '#b0c9bc' },
  { code: 'glacier',    labelKey: 'theme.color.glacier',    swatch: '#20252d', ring: '#adc3dd' },
  { code: 'lavender',   labelKey: 'theme.color.lavender',   swatch: '#25212b', ring: '#c7b3d4' },

  { code: 'cappuccino', labelKey: 'theme.color.cappuccino', swatch: '#1e1e1e', ring: '#b3b3b3' },
  { code: 'crimson',    labelKey: 'theme.color.crimson',    swatch: '#1c1619', ring: '#c58e9a' },
  { code: 'sunset',     labelKey: 'theme.color.sunset',     swatch: '#1e1915', ring: '#bd9270' },
  { code: 'emerald',    labelKey: 'theme.color.emerald',    swatch: '#161e19', ring: '#8ab59e' },
  { code: 'cobalt',     labelKey: 'theme.color.cobalt',     swatch: '#171d26', ring: '#86a5cd' },
  { code: 'fuchsia',    labelKey: 'theme.color.fuchsia',    swatch: '#1e1824', ring: '#ad90bf' },

  { code: 'obsidian',   labelKey: 'theme.color.obsidian',   swatch: '#0a0a0a', ring: '#858585' },
  { code: 'slate',      labelKey: 'theme.color.slate',      swatch: '#130f11', ring: '#ad7480' },
  { code: 'dark',       labelKey: 'theme.color.dark',       swatch: '#15110e', ring: '#a97d5c' },
  { code: 'moss',       labelKey: 'theme.color.moss',       swatch: '#101812', ring: '#6d9d82' },
  { code: 'indigo',     labelKey: 'theme.color.indigo',     swatch: '#101620', ring: '#6789b6' },
  { code: 'teal',       labelKey: 'theme.color.teal',       swatch: '#15101b', ring: '#9a78ae' },
];

// ─── Theme shapes (corner/surface treatment) ─────────────────────────────────
// Frost shares Glass's full chrome; only the frosted backdrop differs (a
// blurred copy of the desktop wallpaper rendered in-page — FrostBackdrop.tsx).
// App.tsx normalizes it to data-shape="glass" + data-frost="frost" so every
// [data-shape="glass"] rule applies unchanged.
export const THEME_SHAPES: { code: ThemeShape; label: string }[] = [
  { code: 'soft',   label: 'Soft'   },
  { code: 'slab',   label: 'Slab'   },
  { code: 'sharp',  label: 'Sharp'  },
  { code: 'glass',  label: 'Glass'  },
  { code: 'frost',  label: 'Frost'  },
  { code: 'panel',  label: 'Panel'  },
  { code: 'carbon', label: 'Carbon' },
  { code: 'monogram', label: 'Monogram' },
];

// Frost reuses the entire glass chrome treatment; only the frosted backdrop
// differs. App.tsx + the index.html pre-paint script normalize it to
// data-shape="glass" + data-frost="frost", and CenterPanel treats it like glass
// for the terminal-as-transparent rule.
const FROST_SHAPES: ThemeShape[] = ['frost'];
export function isFrostShape(shape: ThemeShape): boolean {
  return FROST_SHAPES.includes(shape);
}

// ─── Task board form (to-do list vs sticky notes) ────────────────────────────
// Two presentations of the same task data, chosen in the settings "Tasks"
// section. Icons are inlined in SettingsModal (mirrors the other sections).
export const TASK_VIEW_MODES: { code: 'list' | 'note' | 'prompt'; labelKey: I18nKey; subKey: I18nKey }[] = [
  { code: 'list', labelKey: 'task.view.list', subKey: 'task.view.list.sub' },
  { code: 'note', labelKey: 'task.view.note', subKey: 'task.view.note.sub' },
  { code: 'prompt', labelKey: 'task.view.prompt', subKey: 'task.view.prompt.sub' },
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
