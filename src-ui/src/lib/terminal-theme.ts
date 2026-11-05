// Terminal colour schemes, xterm theme building and small pure helpers
// shared by TierTerminal. Split out of TierTerminal.tsx.

import type { IBufferLine } from '@xterm/xterm';
import { THEME_COLORS } from './personalization';

// ─── Terminal Color Schemes ──────────────────────────────────────────────────
// Full ANSI palettes for readability on different wallpapers.
// "default" = use built-in warm theme, no override.

// Each scheme overrides ONLY the terminal foreground (and matching cursor)
// color. The 16 ANSI palette stays whatever the active theme provides, so
// switching schemes only re-tints the text — no full theme swap, no style
// shift. The chip's own swatch in the picker reuses the same fg value.
export interface TermColorScheme {
  id: string;
  fg: string;
}

export const TERM_COLOR_SCHEMES: TermColorScheme[] = [
  { id: 'red',    fg: '#ff5252' },
  { id: 'orange', fg: '#ff8a00' },
  { id: 'yellow', fg: '#ffd740' },
  { id: 'green',  fg: '#69f0ae' },
  { id: 'cyan',   fg: '#18ffff' },
  { id: 'blue',   fg: '#448aff' },
  { id: 'pink',   fg: '#ff4081' },
  { id: 'purple', fg: '#b388ff' },
];

// Mirror of `--bg-terminal` from global.css. Kept in JS so the terminal can
// pick the right background synchronously on theme prop change — reading the
// CSS variable lags by one switch (child effects fire before App.tsx writes
// `data-theme`). All families follow "terminal bg == bg-app" for a continuous
// surface. The background + selection accent come straight from THEME_COLORS
// (the same table the appearance grid paints), so a palette can never drift
// between the swatch the user picked and the terminal they get. Each family
// carries a night and a day value; `isDark` selects the half on screen — which
// also keeps OSC 11 (Claude Code's /theme auto) honest in every palette.
export function themePair(themeName: string) {
  return THEME_COLORS.find(c => c.code === themeName);
}

// Collapse any mix of CRLF / bare CR into plain LF before handing text to
// xterm.paste. Windows puts CRLF into the clipboard and most TUIs on the
// other side of the PTY treat the CR as an "Enter" (submit) keystroke —
// so a 5-line paste becomes 5 submissions plus 5 visible blank lines.
// Normalizing here gives every paste path a single line-ending contract
// regardless of where the clipboard text originally came from
// (Notepad / browser / another terminal / macOS / Linux).
export function normalizePasteNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// Derive a slightly-darker, alpha-blended selection background from the
// scheme's fg (or the warm coffee fallback). Multiplying RGB by 0.8 first
// gives the "比主题色深点" feel before xterm composites it over the bg.
// Alpha stays deliberately high: at 0.3-0.4 the highlight was effectively
// invisible against dark backgrounds, so users concluded drag selection
// was broken when it was actually working (issue #92).
export function deriveSelectionBg(hex: string, isDark: boolean): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return isDark ? 'rgba(196,149,106,0.55)' : 'rgba(196,149,106,0.45)';
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 0xff) * 0.8);
  const g = Math.round(((n >> 8) & 0xff) * 0.8);
  const b = Math.round((n & 0xff) * 0.8);
  return `rgba(${r},${g},${b},${isDark ? 0.55 : 0.45})`;
}

export const LINK_RE = /(https?:\/\/[^\s<>()"'-￿]+|file:\/\/\/[^\s<>()"'-￿]+)/g;

/** A buffer line's text and the terminal column of each character: wide characters span two columns. */
export function lineCells(line: IBufferLine) {
  let text = '';
  const cols: number[] = [];
  for (let col = 0; col < line.length; col++) {
    const chars = line.getCell(col)?.getChars();
    if (!chars) continue; // empty cell or the right half of a wide char
    for (let i = 0; i < chars.length; i++) cols.push(col);
    text += chars;
  }
  return { text, cols };
}

// Some verified TUIs paint their own caret, so xterm's cursor would be a
// duplicate or stranded artifact. Paint its cell in the terminal background
// for those tools only. Every other tool keeps xterm's foreground caret; the
// conservative default makes new and terminal-only tools usable immediately.
// Build the xterm fontFamily stack. `userFont` (from Settings) is prepended
// so it wins for the glyphs it has; the bundled CascadiaMono + Nerd Fonts +
// platform monospace faces follow, and the CJK cascade backstops Chinese/
// Japanese/Korean (so picking a Latin-only font never re-breaks CJK).
// Embedded CascadiaMono guarantees consistent box-drawing; the per-glyph
// cascade skips names absent on the host so the right OS face always wins.
export function buildFontFamily(userFont?: string): string {
  const ua = navigator.userAgent.toLowerCase();
  const isLinux = ua.includes('linux');
  const isMac = ua.includes('mac');
  const NERD = "'CaskaydiaCove Nerd Font', 'JetBrainsMono Nerd Font', 'MesloLGS NF', 'FiraCode Nerd Font', 'Hack Nerd Font'";
  const CJK = "'PingFang SC', 'PingFang TC', 'Hiragino Sans', 'Apple SD Gothic Neo', 'Microsoft YaHei', 'Microsoft JhengHei', 'Yu Gothic UI', 'Malgun Gothic', 'Noto Sans CJK SC', 'Noto Sans CJK TC', 'Noto Sans CJK JP', 'Noto Sans CJK KR', 'WenQuanYi Micro Hei'";
  const base = isLinux
    ? `CascadiaMono, ${NERD}, 'Ubuntu Mono', 'Noto Sans Mono', 'DejaVu Sans Mono', 'Liberation Mono', ${CJK}, monospace`
    : isMac
      ? `CascadiaMono, ${NERD}, ui-monospace, Menlo, Monaco, 'Courier New', ${CJK}, monospace`
      : `CascadiaMono, ${NERD}, 'Cascadia Mono', Consolas, 'Courier New', ${CJK}, monospace`;
  return userFont ? `"${userFont}", ${base}` : base;
}

export function buildXtermTheme(themeName: string, hasBg: boolean | undefined, schemeId?: string, showXtermCursor = true, isDark = true) {
  const scheme = schemeId ? TERM_COLOR_SCHEMES.find(s => s.id === schemeId) : undefined;
  const pair = themePair(themeName);
  const bgOpaque = (isDark ? pair?.swatch : pair?.daySwatch) ?? (isDark ? '#0a0a0a' : '#eeece6');
  const bg = hasBg ? 'rgba(0,0,0,0)' : bgOpaque;

  // Build the default warm palette first (full 16 ANSI colors), then let
  // the scheme — if any — re-tint only the foreground and cursor.
  const defaultFg = isDark ? '#e8e4de' : '#2d2c2a';
  const fg = scheme?.fg ?? defaultFg;
  // Selection priority: terminal-color-scheme chip (if set) → app theme accent
  // → coffee. So picking sakura/indigo/mint etc. recolors the highlight even
  // without choosing a per-terminal fg chip.
  const selectionAccent = scheme?.fg ?? (isDark ? pair?.ring : pair?.dayRing) ?? '#c4956a';
  const selectionBackground = deriveSelectionBg(selectionAccent, isDark);

  const base = isDark ? {
    selectionBackground,
    black: '#0c0c0c', red: '#e07070', green: '#7ec77e', yellow: '#d4a846',
    blue: '#78a8d4', magenta: '#b07cc6', cyan: '#5fc4c0', white: '#e8e4de',
    brightBlack: '#6b6762',
  } : {
    selectionBackground,
    black: '#2d2c2a', red: '#cc3333', green: '#2d7a2d', yellow: '#8a6000',
    blue: '#2952a3', magenta: '#7a3d8a', cyan: '#1a6b6b', white: '#f4f3ee',
    brightBlack: '#5a5854',
  };

  return {
    ...base,
    background: bg,
    foreground: fg,
    // Self-rendered-caret TUIs blend the xterm cell into the background while
    // its character remains readable. All other tools get a visible caret.
    cursor: showXtermCursor ? fg : bgOpaque,
    cursorAccent: fg,
  };
}
