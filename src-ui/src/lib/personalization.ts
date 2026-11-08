// personalization.ts — shared, pure data for the appearance/language controls.
//
// Extracted from Explorer.tsx so the new SettingsModal and the file-tree's
// icon renderer can both consume one source of truth (DRY). Only static option
// tables + small pure helpers live here — all dispatch/persistence wiring stays
// in the components.

import type { ThemeColor, ThemeMode, ThemeShape, IconTheme } from '../store/app-state';
import type { I18nKey } from '../i18n/en';

// ─── Theme colours (swatch grid) ─────────────────────────────────────────────
// One entry per colour family. Every family carries both halves of its palette:
// the night values (applied when data-mode="dark") and the day values (applied
// when data-mode="light", see the [data-mode="light"] blocks in global.css), so
// the appearance grid can render any of the three modes from one table and
// follow-system just swaps which half is on screen. Swatch = the palette's
// --bg-app, ring = its --accent; keep both in sync with the CSS.
//
// labelKey is the family's one name: the card reads the same in all three
// mode tabs (a name per half would double the grid's text and still describe
// only one hue).
export const THEME_COLORS: {
  code: ThemeColor; labelKey: I18nKey;
  swatch: string; ring: string; daySwatch: string; dayRing: string;
}[] = [
  // Columns: neutral, rose, orange, green, blue, violet; rows: mist, soft, vivid, deep. Each new row turns a column
  // to a neighbouring hue; vivid sits between soft and deep at a higher saturation, unlike the mid row retired
  // in v3.5.4, which read as a copy of its neighbours. Stable codes preserve saved preferences when renamed.
  { code: 'oat',        labelKey: 'theme.color.oat',        swatch: '#25221e', ring: '#b5a68b', daySwatch: '#f2f0ee', dayRing: '#7a6849' },
  { code: 'coral',      labelKey: 'theme.color.coral',      swatch: '#27201f', ring: '#dab7b2', daySwatch: '#f8f5f4', dayRing: '#77433b' },
  { code: 'gold',       labelKey: 'theme.color.gold',       swatch: '#292517', ring: '#d2c28e', daySwatch: '#faf8f2', dayRing: '#7f6e34' },
  { code: 'olive',      labelKey: 'theme.color.olive',      swatch: '#23281e', ring: '#bdc9b0', daySwatch: '#f6f8f4', dayRing: '#5b7043' },
  { code: 'lagoon',     labelKey: 'theme.color.lagoon',     swatch: '#1e2d2f', ring: '#add8dd', daySwatch: '#f4f9f9', dayRing: '#34777f' },
  { code: 'iris',       labelKey: 'theme.color.iris',       swatch: '#22202d', ring: '#bab3d4', daySwatch: '#f5f4f8', dayRing: '#483d75' },

  { code: 'light',      labelKey: 'theme.color.light',      swatch: '#24221f', ring: '#9aa0a6', daySwatch: '#f6f4ef', dayRing: '#5c6267' },
  { code: 'sakura',     labelKey: 'theme.color.sakura',     swatch: '#262024', ring: '#dab2be', daySwatch: '#f9f8f8', dayRing: '#773b4d' },
  { code: 'amber',      labelKey: 'theme.color.amber',      swatch: '#272219', ring: '#d2b28e', daySwatch: '#faf9f7', dayRing: '#7f5c34' },
  { code: 'mint',       labelKey: 'theme.color.mint',       swatch: '#1f2723', ring: '#b0c9bc', daySwatch: '#f8f9f9', dayRing: '#437059' },
  { code: 'glacier',    labelKey: 'theme.color.glacier',    swatch: '#20252d', ring: '#adc3dd', daySwatch: '#f8f9fa', dayRing: '#34567f' },
  { code: 'lavender',   labelKey: 'theme.color.lavender',   swatch: '#25212b', ring: '#c7b3d4', daySwatch: '#f9f8f9', dayRing: '#5f3d75' },

  { code: 'steel',      labelKey: 'theme.color.steel',      swatch: '#121619', ring: '#849cad', daySwatch: '#edeff1', dayRing: '#416178' },
  { code: 'fuchsia',    labelKey: 'theme.color.fuchsia',    swatch: '#21131c', ring: '#df9dc7', daySwatch: '#f8f2f5', dayRing: '#7a2e5e' },
  { code: 'copper',     labelKey: 'theme.color.copper',     swatch: '#23150e', ring: '#de9673', daySwatch: '#faf3ef', dayRing: '#844425' },
  { code: 'jade',       labelKey: 'theme.color.jade',       swatch: '#102722', ring: '#a1c9c0', daySwatch: '#f2f8f6', dayRing: '#387164' },
  { code: 'sapphire',   labelKey: 'theme.color.sapphire',   swatch: '#12172c', ring: '#96a3e5', daySwatch: '#f1f3f9', dayRing: '#253584' },
  { code: 'orchid',     labelKey: 'theme.color.orchid',     swatch: '#29112a', ring: '#d5a1d7', daySwatch: '#f7f2f8', dayRing: '#753078' },

  { code: 'obsidian',   labelKey: 'theme.color.obsidian',   swatch: '#0a0a0a', ring: '#858585', daySwatch: '#eaecee', dayRing: '#3c4a5d' },
  { code: 'slate',      labelKey: 'theme.color.slate',      swatch: '#130f11', ring: '#ad7480', daySwatch: '#efe9ea', dayRing: '#65343f' },
  { code: 'dark',       labelKey: 'theme.color.dark',       swatch: '#15110e', ring: '#a97d5c', daySwatch: '#f0ebe8', dayRing: '#6b482e' },
  { code: 'moss',       labelKey: 'theme.color.moss',       swatch: '#101812', ring: '#6d9d82', daySwatch: '#e9eeec', dayRing: '#39604a' },
  { code: 'indigo',     labelKey: 'theme.color.indigo',     swatch: '#101620', ring: '#6789b6', daySwatch: '#e8ebf0', dayRing: '#2c486d' },
  { code: 'teal',       labelKey: 'theme.color.teal',       swatch: '#15101b', ring: '#9a78ae', daySwatch: '#ede9ef', dayRing: '#523663' },
];

// ─── Theme mode (light / night / follow the OS) ──────────────────────────────
// The tab row beside the "Colors" label. A mode picks which half of every
// colour family above gets applied; `system` follows the OS light/dark
// preference live (App.tsx listens to prefers-color-scheme).
export const THEME_MODES: { code: ThemeMode; labelKey: I18nKey }[] = [
  { code: 'light',  labelKey: 'theme.mode.light'  },
  { code: 'dark',   labelKey: 'theme.mode.dark'   },
  { code: 'system', labelKey: 'theme.mode.system' },
];

/** The half of the palette to paint: `system` defers to the OS preference. */
export function resolveThemeMode(mode: ThemeMode, systemDark: boolean): 'light' | 'dark' {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}

// ─── Theme shapes (corner/surface treatment) ─────────────────────────────────
// Frost shares Glass's full chrome; only the frosted backdrop differs (a
// blurred copy of the desktop wallpaper rendered in-page — FrostBackdrop.tsx).
// App.tsx normalizes it to data-shape="glass" + data-frost="frost" so every
// [data-shape="glass"] rule applies unchanged.
export const THEME_SHAPES: { code: ThemeShape; labelKey: I18nKey }[] = [
  { code: 'soft',   labelKey: 'theme.shape.soft'   },
  { code: 'slab',   labelKey: 'theme.shape.slab'   },
  { code: 'sharp',  labelKey: 'theme.shape.sharp'  },
  { code: 'glass',  labelKey: 'theme.shape.glass'  },
  { code: 'frost',  labelKey: 'theme.shape.frost'  },
  { code: 'panel',  labelKey: 'theme.shape.panel'  },
  { code: 'carbon', labelKey: 'theme.shape.carbon' },
  { code: 'monogram', labelKey: 'theme.shape.monogram' },
  { code: 'characters', labelKey: 'theme.shape.characters' },
  { code: 'basalt', labelKey: 'theme.shape.basalt' },
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
