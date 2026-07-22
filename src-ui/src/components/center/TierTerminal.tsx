// TierTerminal.tsx — xterm.js terminal renderer with PTY backend.
//
// Pure terminal — no text interception, no overlay. Output from the child
// process is piped byte-for-byte to xterm.
//
// Perf note: this component is wrapped in React.memo at the bottom of this
// file. All state that affects rendering is passed in via props so that
// unrelated global state changes (agent status, other tabs' folder changes,
// etc.) don't cascade into this component.

import { memo, useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { clipboardRead, clipboardWrite, clipboardReadImage } from '../../lib/clipboard';
import { subscribeTerminalEvents } from '../../lib/pty-event-bus';
import { rig } from '../../lib/latency-rig';
import * as outputScheduler from '../../lib/terminal-output-scheduler';
import { registerTerminalFocus } from '../../lib/focus-registry';
import { registerTabActions, getTabActions } from '../../lib/tab-actions';
import { registerFileDropTarget, formatPathsForInsert } from '../../lib/file-drop';
import { notifyUserInputSubmitted } from '../../lib/agent-status-bus';
import { onWindowForeground } from '../../lib/window-focus-filter';
import { commands } from '../../tauri';
import { useAppDispatch, useAppState, type ToolType, type ThemeColor } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { getToolDisplayName } from '../../lib/tool-info';
import '@xterm/xterm/css/xterm.css';
import './TierTerminal.css';

// Installer scripts are fetched at runtime from CF (hot-updatable, no release needed).
// Falls back to GitHub raw if CF is unreachable.
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
// `data-theme`). Must stay in sync with each [data-theme] block in global.css.
// Dark themes follow "terminal bg == bg-app" for a continuous surface.
// Light theme deliberately uses a softer cream than --bg-app: pure ivory
// #FAFAF7 is too bright for CLI mid-tone palettes (Claude Code's RGB tan
// branding, ANSI bright-black), and going too gray makes those same colors
// vanish. #eeebe2 keeps the daytime feel while giving dark + gray text
// 5–12:1 contrast so primary/secondary copy stays legible.
const THEME_TERMINAL_BG: Record<string, string> = {
  dark:       '#1a1917',
  light:      '#eeebe2',
  cappuccino: '#1a1a1a',
  sakura:     '#1a1520',
  lavender:   '#1a1826',
  mint:       '#0f1e1c',
  obsidian:   '#0a0a0a',
  cobalt:     '#0a1020',
  moss:       '#0b1612',
  crimson:    '#2a0d10',
  sunset:     '#241408',
  amber:      '#20180a',
  emerald:    '#0a1c12',
  teal:       '#0a2125',
  indigo:     '#12142e',
  fuchsia:    '#210f1d',
};

// Per-theme selection accent. Picked so each theme's selection highlight
// reads as a deeper variant of that theme's signature hue rather than the
// brand coffee for every theme. deriveSelectionBg further darkens these
// and applies alpha before they reach xterm.
const THEME_SELECTION_ACCENT: Record<string, string> = {
  dark:       '#c4956a',
  light:      '#c4956a',
  cappuccino: '#c4956a',
  sakura:     '#e08aa8',
  lavender:   '#a896d8',
  mint:       '#7ec4a8',
  obsidian:   '#9ca8b8',
  cobalt:     '#5a8cd0',
  moss:       '#88b87a',
  crimson:    '#e23b42',
  sunset:     '#f5803b',
  amber:      '#e8a72c',
  emerald:    '#24c281',
  teal:       '#2bc4c4',
  indigo:     '#6172f0',
  fuchsia:    '#d94aa0',
};

// Collapse any mix of CRLF / bare CR into plain LF before handing text to
// xterm.paste. Windows puts CRLF into the clipboard and most TUIs on the
// other side of the PTY treat the CR as an "Enter" (submit) keystroke —
// so a 5-line paste becomes 5 submissions plus 5 visible blank lines.
// Normalizing here gives every paste path a single line-ending contract
// regardless of where the clipboard text originally came from
// (Notepad / browser / another terminal / macOS / Linux).
function normalizePasteNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// Derive a slightly-darker, alpha-blended selection background from the
// scheme's fg (or the warm coffee fallback). Multiplying RGB by 0.8 first
// gives the "比主题色深点" feel before xterm composites it over the bg.
// Alpha stays deliberately high: at 0.3-0.4 the highlight was effectively
// invisible against dark backgrounds, so users concluded drag selection
// was broken when it was actually working (issue #92).
function deriveSelectionBg(hex: string, isDark: boolean): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return isDark ? 'rgba(196,149,106,0.55)' : 'rgba(196,149,106,0.45)';
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 0xff) * 0.8);
  const g = Math.round(((n >> 8) & 0xff) * 0.8);
  const b = Math.round((n & 0xff) * 0.8);
  return `rgba(${r},${g},${b},${isDark ? 0.55 : 0.45})`;
}

// In AI-agent tabs the upstream TUI (each agent's input box, the Compose
// textarea) paints its own caret, so xterm's cursor is either redundant or a
// stranded artifact — paint it in the background color so the WebGL renderer
// effectively erases it (the DOM renderer is covered by
// `.xterm-cursor { display: none }` in TierTerminal.css).
// Raw-shell tabs (local terminal / remote SSH) are the exception: no TUI
// draws a caret there, so the xterm cursor is the only input-position
// indicator — keep it visible with the foreground color (issue #95).
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

function buildXtermTheme(themeName: string, hasBg: boolean | undefined, schemeId?: string, rawShell = false) {
  const isDark = themeName !== 'light';
  const scheme = schemeId ? TERM_COLOR_SCHEMES.find(s => s.id === schemeId) : undefined;
  const bgOpaque = THEME_TERMINAL_BG[themeName] || (isDark ? '#0c0c0c' : '#eeebe2');
  const bg = hasBg ? 'rgba(0,0,0,0)' : bgOpaque;

  // Build the default warm palette first (full 16 ANSI colors), then let
  // the scheme — if any — re-tint only the foreground and cursor.
  const defaultFg = isDark ? '#e8e4de' : '#2d2c2a';
  const fg = scheme?.fg ?? defaultFg;
  // Selection priority: terminal-color-scheme chip (if set) → app theme accent
  // → coffee. So picking sakura/cobalt/mint etc. recolors the highlight even
  // without choosing a per-terminal fg chip.
  const selectionAccent = scheme?.fg ?? THEME_SELECTION_ACCENT[themeName] ?? '#c4956a';
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
    // AI-agent tabs: cursor painted in bg color = invisible (see comment at
    // the top of this section). Raw shells get a real, visible caret.
    cursor: rawShell ? fg : bgOpaque,
    cursorAccent: bgOpaque,
  };
}


// Sessions being detached to a new window — skip kill on unmount
export const detachedSessions = new Set<string>();

// ─── Terminal Context Menu ────────────────────────────────────────────────────

interface CtxMenu { x: number; y: number; hasSelection: boolean; }

function TermContextMenu({ menu, onClose, onCopy, onPaste, onSelectAll }: {
  menu: CtxMenu;
  onClose: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const t = useT();
  const mod = isMac ? '⌘' : 'Ctrl';

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const closeKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Delay so the triggering mousedown doesn't immediately close the menu
    const t = setTimeout(() => {
      document.addEventListener('mousedown', close);
      document.addEventListener('keydown', closeKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeKey);
    };
  }, [onClose]);

  // Clamp to viewport so menu never overflows off-screen
  const left = Math.min(menu.x, window.innerWidth  - 164);
  const top  = Math.min(menu.y, window.innerHeight - 116);

  return createPortal(
    <div ref={ref} className="term-ctx-menu" style={{ left, top }}>
      <button
        className={`term-ctx-item${menu.hasSelection ? '' : ' disabled'}`}
        onMouseDown={(e) => { e.preventDefault(); if (menu.hasSelection) onCopy(); }}
      >
        <span>{t('menu.copy')}</span><kbd>{mod}+C</kbd>
      </button>
      <button
        className="term-ctx-item"
        onMouseDown={(e) => { e.preventDefault(); onPaste(); }}
      >
        <span>{t('menu.paste')}</span><kbd>{mod}+V</kbd>
      </button>
      <div className="term-ctx-sep" />
      <button
        className="term-ctx-item"
        onMouseDown={(e) => { e.preventDefault(); onSelectAll(); }}
      >
        <span>{t('menu.select_all')}</span><kbd>{mod}+A</kbd>
      </button>
    </div>,
    document.body,
  );
}

// ── Shared WebGL renderer budget ─────────────────────────────────────────────
// Chromium/WebView2 caps *active* WebGL contexts at ~16 per renderer process.
// With one terminal per tab/pane, a long session blows past that and the
// browser force-loses the OLDEST context. We mirror VS Code's terminal (whose
// team maintains xterm.js) with two process-wide guards:
//   • `webglDisabled` latch — once ANY terminal fails to acquire, or loses, its
//     GL context, every terminal that hasn't already attached (this one, if it
//     just failed, + all future ones) renders via the DOM renderer instead.
//     Terminals that already hold a live context keep it — the latch only
//     stops new competition for a slot that isn't coming back. xterm
//     auto-falls back to DOM when no render addon is loaded, so this degrades
//     gracefully instead of stranding a tab on a dead renderer.
//   • one cached GPU probe — the probe opens a throwaway GL context, so running
//     it per-terminal wasted a context slot every time.
let webglDisabled = false;
let gpuIsHardware: boolean | null = null;

function detectHardwareWebgl(): boolean {
  try {
    const testCanvas = document.createElement('canvas');
    const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
    if (!gl) {
      console.log('[TierTerminal] WebGL unavailable → DOM renderer');
      return false;
    }
    const debugExt = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
    if (!debugExt) {
      // Privacy-hardened builds hide the renderer string; assume real hardware.
      // (Defaulting to DOM here used to spike CPU on locked-down machines.)
      console.log('[TierTerminal] GPU info hidden → WebGL (assuming hardware acceleration)');
      return true;
    }
    const renderer = (gl as WebGLRenderingContext).getParameter(debugExt.UNMASKED_RENDERER_WEBGL) as string;
    const isSoftware = /llvmpipe|softpipe|swrast|swiftshader|software|microsoft basic render|mesa offscreen/i.test(renderer);
    console.log(`[TierTerminal] GPU: ${renderer} → ${isSoftware ? 'DOM' : 'WebGL'} (software=${isSoftware})`);
    return !isSoftware;
  } catch {
    console.warn('[TierTerminal] WebGL probe failed → DOM renderer');
    return false;
  }
}

function probeWebglOnce(): boolean {
  if (gpuIsHardware === null) gpuIsHardware = detectHardwareWebgl();
  return gpuIsHardware;
}

// Max context-loss recoveries per terminal before we conclude WebGL is
// unstable for this process and latch to the DOM renderer process-wide.
// Mirrors Tabby's MAX_WEBGL_RECOVERY_ATTEMPTS = 3. A single loss (typically
// Chromium reclaiming one of its ~16 active contexts) is recoverable — we
// dispose + re-attach on next visibility. Only repeated loss on the SAME
// terminal trips the process-wide latch.
const MAX_WEBGL_RECOVERY_ATTEMPTS = 3;

// Attach the WebGL renderer to `term`, respecting the shared context budget.
// Idempotent per terminal (guards on `webglRef`); a no-op once the latch is
// tripped or on a software GPU. Safe to call on first reveal AND on tab
// re-activation — a tab that is never shown never spends a context, and a
// backgrounded tab releases its context (see detachWebglRenderer) so the ~16
// active-context slots stay free for visible tabs. DOM fallback loses
// customGlyphs / rescaleOverlappingGlyphs, so box-drawing may misalign on
// degraded terminals.
function attachWebglRenderer(
  term: Terminal,
  webglRef: { current: WebglAddon | null },
  attemptsRef: { current: number },
): void {
  if (webglDisabled || webglRef.current) return;
  if (!probeWebglOnce()) return; // software GPU → DOM renderer is cheaper
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      // Browser force-loses a context when the ~16 active-context cap is hit
      // or the GPU driver resets. Drop THIS terminal's renderer. Don't latch
      // process-wide on a single loss — re-attach is attempted on next
      // visibility (the tab is usually backgrounded when this fires, so the
      // re-attach lands on the next switch-back). Only after
      // MAX_WEBGL_RECOVERY_ATTEMPTS losses on the SAME terminal do we conclude
      // WebGL is unstable for this process and latch globally. Terminals that
      // already hold a live context (attached before this loss) are left alone
      // — revoking a still-working context would be more destructive than the
      // problem this is solving.
      try { webgl.dispose(); } catch { /* already gone */ }
      webglRef.current = null;
      attemptsRef.current += 1;
      if (attemptsRef.current >= MAX_WEBGL_RECOVERY_ATTEMPTS) {
        webglDisabled = true;
        console.warn(
          `[TierTerminal] WebGL context lost ${attemptsRef.current}× on one terminal → latching DOM renderer process-wide`,
        );
      }
    });
    term.loadAddon(webgl);
    webglRef.current = webgl;
    // Force an initial paint of the freshly-attached GL canvas. xterm's
    // setRenderer() already calls _fullRefresh(), but that render is
    // rAF-deferred and — when the attach lands on a tab that's ALREADY
    // visible (the switch-back path, where the IO/activation effect fires
    // after fit()) — the deferred render can race the canvasHidden mask's
    // onRender reveal, or land after the mask already fell back to its
    // 150 ms timeout. The new GL canvas then shows blank/stale until a
    // window resize forces ResizeObserver → fit() → re-render (issue #74,
    // "切换窗口卡住，重新拖动界面才正常"). An explicit refresh() re-marks
    // every row dirty and re-schedules, guaranteeing a painted GL frame
    // shortly after attach regardless of when the caller runs it.
    try {
      if (term.rows > 0) term.refresh(0, term.rows - 1);
    } catch { /* renderer not ready yet — first write surfaces it */ }
  } catch (err) {
    // No context available even now → give up on WebGL process-wide.
    webglDisabled = true;
    console.error('[TierTerminal] WebGL attach failed → DOM renderer', err);
  }
}

// Release this terminal's WebGL context WITHOUT tripping the recovery budget
// or the process-wide latch — this is the intentional lifecycle dispose when
// a tab is backgrounded (Orca's suspendRendering pattern). Frees one of the
// ~16 active-context slots so new tabs don't get force-degraded to DOM. xterm
// falls back to its DOM renderer; buffer state is preserved, so re-attach on
// next visibility picks up where it left off. No-op when already detached.
function detachWebglRenderer(
  webglRef: { current: WebglAddon | null },
): void {
  if (!webglRef.current) return;
  try { webglRef.current.dispose(); } catch { /* already gone */ }
  webglRef.current = null;
}

interface TierTerminalProps {
  sessionId: string;
  tool: ToolType;
  /** Display name override for the splash. When omitted, the splash
   *  resolves the tool id through the registry (lib/tool-info.ts). */
  toolName?: string;
  theme: ThemeColor;
  lang: string;
  isActive: boolean;
  toolData?: string;
  folderPath?: string | null;
  /** Resume token for "Continue this session" — when set, the mount
   *  effect passes it to tierTerminalStart, which spawns the tool with
   *  `--resume <token>` instead of a fresh launch. */
  resumeToken?: string;
  hasBg?: boolean;
  bgUrl?: string;
  bgType?: 'image' | 'video' | 'none';
  termColorScheme?: string;
  termFont?: string;
  /** Multi-agent only. When true, the backend wires this pane's
   *  `coffee-cli` MCP server + injects the cross-pane protocol prompt
   *  into the CLI's system instructions. When false (default), the
   *  pane runs hands-free but with NO peer awareness — it shares only
   *  the workspace folder with sibling panes. Ignored outside
   *  multi-agent grids (single-terminal tabs always pass false). */
  sentinelEnabled?: boolean;
}

// ─── Component ───────────────────────────────────────────────────────────────

function TierTerminalImpl({
  sessionId, tool, toolName, theme, lang, isActive, toolData, folderPath, resumeToken, hasBg, bgUrl, bgType, termColorScheme, termFont,
}: TierTerminalProps) {
  // Raw shells (local terminal / remote SSH) have no TUI painting its own
  // caret — the xterm cursor is the only input-position indicator, so these
  // tabs keep it visible (issue #95). Drives the theme + CSS below.
  const isRawShell = tool === 'terminal' || tool === 'remote';
  // Dispatch-only subscription. Never re-renders this component.
  const dispatch = useAppDispatch();
  // Sentinel scanner needs access to the latest state to look up sibling
  // panes (same parent tab, sentinelEnabled, etc.). Using the hook re-
  // renders this component on every state change, which would thrash the
  // xterm init effects. We keep the value in a ref and sync it with a
  // cheap effect — the onOutput closure reads through the ref.
  const { state: _appState } = useAppState();
  const appStateRef = useRef(_appState);
  useEffect(() => { appStateRef.current = _appState; }, [_appState]);

  const termRef  = useRef<HTMLDivElement>(null);
  // Frozen helper-textarea position held for the lifetime of an IME
  // composition (Windows) — see the compositionstart/end wiring in the
  // init effect. Null when no composition is active.
  const imeFrozenRef = useRef<{ left: string; top: string } | null>(null);
  const wrapRef  = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef   = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  // Per-terminal WebGL context-loss counter — drives the recovery budget in
  // attachWebglRenderer (see MAX_WEBGL_RECOVERY_ATTEMPTS). We latch to DOM
  // only after N losses on the same terminal instance, the signal that WebGL
  // is unstable here. Not reset on successful re-attach.
  const contextLossAttemptsRef = useRef(0);

  // ── Startup splash state ─────────────────────────────────────────────────
  const [showSplash, setShowSplash] = useState(true);
  const [splashFading, setSplashFading] = useState(false);
  const splashStartRef = useRef(Date.now());
  const altScreenRef = useRef(false); // True when TUI enters alternate screen buffer

  // ── Launch failure detection ─────────────────────────────────────────────
  const hasOutputRef = useRef(false); // Set to true when PTY emits visible output
  // Refined readiness signals for inline-mode CLIs (Claude Code etc. that
  // don't enter alt-screen). hasOutputRef alone trips on the first byte —
  // a "Connecting..." preamble was enough to dismiss the splash even when
  // the actual REPL was 8 s away. Tracking total bytes + last-output time
  // lets the splash wait for "substantial output, then a brief silence"
  // (CLI finished its first frame and is awaiting input).
  const outputBytesRef = useRef(0);
  const lastOutputAtRef = useRef(0);
  const [processExited, setProcessExited] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  // Rolling buffer for agent-to-agent marker scanning. PTY chunks can split
  // `[COFFEE-TELL:...]` / `[COFFEE-DONE:...]` across boundaries; the buffer
  // reassembles chunks so markers match reliably. `markerScanOffsetRef`
  // tracks how far we've already scanned to avoid re-firing the same
  // dispatch when a later chunk arrives and re-triggers the scan. See the
  // scanner in `onData` below for the consume/advance logic.
  const markerScanBufRef = useRef<string>('');
  const markerScanOffsetRef = useRef<number>(0);

  // ── Stale-frame ghost suppression on tab switch (issue #47) ──────────────
  // Inactive tabs are display:none (CenterPanel). While hidden, xterm's WebGL
  // canvas keeps its LAST drawn framebuffer. On switch-back the browser
  // composites that stale frame, and xterm's redraw is deferred to rAF (the
  // activation effect below even waits a double-rAF before fit()), so for
  // 1-2 frames the user sees the *previous* agent UI ghosted in before it
  // snaps to current. We mask the canvas the instant the tab re-activates
  // (pre-paint, via useLayoutEffect) so the solid terminal background shows
  // through instead, then unmask once xterm paints its first fresh frame.
  const [canvasHidden, setCanvasHidden] = useState(false);

  // ── Terminal context menu ────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const t = useT();

  // Splash labels for registered AI CLIs come straight from the Rust
  // tool registry (lib/tool-info.ts). The pseudo-tools `remote` /
  // `terminal` are not in the registry — keep their localized labels.
  const toolLabel: Record<string, string> = {
    remote: t('tool.remote'),
    terminal: t('tool.terminal'),
  };

  // ── xterm.js init ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!termRef.current || xtermRef.current) return;

    let mounted = true;
    const unlisteners: (() => void)[] = [];

    const fontFamily = buildFontFamily(termFont);
    const term = new Terminal({
      fontFamily,
      fontSize: 14,
      lineHeight: 1.3,
      letterSpacing: 0,
      fontWeight: '400',
      fontWeightBold: '400', // Prevent bold glyphs from using wider metrics
      // allowTransparency forces the WebGL compositor through an extra blend
      // pass on every frame. Only enable when there is actually a wallpaper
      // behind the terminal — opaque background is the common case and pays
      // measurably less GPU time on Apple Silicon / integrated GPUs.
      allowTransparency: hasBg,
      customGlyphs: true, // Pixel-perfect box-drawing on all platforms (canvas-drawn, font-independent)
      rescaleOverlappingGlyphs: true, // Force ambiguous-width chars (block chars ▀▄█) to single cell width
      // Cursor blink fires a GPU repaint every ~530ms for the entire app
      // lifetime. On laptops (especially Apple Silicon Air without a fan)
      // that's a constant power draw users feel as warmth. Off in AI-agent
      // tabs (cursor invisible there anyway) and raw shells alike — a
      // static, non-blinking caret costs nothing once painted.
      cursorBlink: false,
      // Default `cursorInactiveStyle: 'outline'` makes xterm flip the
      // cursor presentation on blur, which dirties the WebGL buffer and
      // re-composites the whole canvas — visible as a one-frame flicker
      // of the upstream CLI's own caret character (Claude Code, Codex)
      // every time the user clicks anywhere outside the terminal.
      // 'none' suppresses the inactive cursor entirely so blur is a
      // no-op for the renderer. The win is that the redraw stops; in raw
      // shells the caret simply hides while the terminal is unfocused.
      cursorInactiveStyle: 'none',
      scrollback: 5000,
      theme: buildXtermTheme(theme, hasBg, termColorScheme, isRawShell),
    });

    const fit = new FitAddon();
    term.loadAddon(fit);

    // Register focus function in the singleton focus registry.
    // CenterPanel handles the global focusin/mouseup listener and routes
    // focus to the active terminal — each tab no longer needs its own pair
    // of window listeners.
    const unregisterFocus = registerTerminalFocus(sessionId, () => {
      xtermRef.current?.focus();
    });

    // Wait for CascadiaMono to load before opening the terminal so xterm
    // measures cell metrics with the correct font (avoids box-drawing misalignment).
    const fontReady = document.fonts.load('14px CascadiaMono').catch(() => {});
    const initTerminal = async () => {
      await fontReady;
      if (!mounted || !termRef.current) return;

      term.open(termRef.current);

      // ── Fix CJK IME punctuation duplication on Linux WebKitGTK (Tauri) ──
      // On WebKitGTK + ibus, committing a CJK punctuation mark fires BOTH
      // xterm's composition path (compositionstart/update/end) AND its input
      // path, so each mark reaches the PTY twice and the whole run of
      // punctuation re-accumulates on every keystroke (测试，，。。 …). We cut
      // the composition path off at the source: capture-phase stopPropagation
      // on the hidden helper textarea's three composition events means xterm's
      // CompositionHelper never engages, leaving a single clean input path.
      //
      // __IS_LINUX__-gated on purpose — Chromium (Windows) / WKWebView (macOS)
      // never had this bug and rely on CompositionHelper for normal IME, so we
      // must not suppress it there. Ships on stable xterm 6.0.0 for every
      // platform; replaces the earlier Linux-only 6.1.0-beta release artifact.
      // Source: PR #38 / xtermjs#5374.
      if (__IS_LINUX__) {
        const imeTextarea = termRef.current.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
        if (imeTextarea) {
          const stopComposition = (e: Event) => e.stopPropagation();
          imeTextarea.addEventListener('compositionstart', stopComposition, { capture: true });
          imeTextarea.addEventListener('compositionupdate', stopComposition, { capture: true });
          imeTextarea.addEventListener('compositionend', stopComposition, { capture: true });
        }
      }

      // ── Windows IME candidate window position (issue #88) ──
      // Windows IME caches the helper textarea's position when it first gains
      // focus; later CSS moves are ignored until focus is truly lost and
      // regained. The re-anchor + blur/focus cycle lives in the wrap div's
      // onMouseDown/onClick handlers below — deliberately split across the
      // gesture, because cycling focus on mousedown breaks xterm drag
      // selection (issue #92).
      //
      // Freeze during composition: a TUI redraws on every keystroke and its
      // buffer cursor can hop between the input box and the output region
      // mid-composition; xterm's own _syncTextArea drags the helper textarea
      // (and the IME candidate window with it) along every hop — the "jumpy
      // candidate" users feel as 乱跳. We pin the textarea at compositionstart
      // and hold it until compositionend, so the candidate stays put for the
      // whole word/phrase. Clicks still re-anchor between compositions.
      if (!__IS_LINUX__ && navigator.userAgent.toLowerCase().includes('win')) {
        const imeTextarea = termRef.current.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
        if (imeTextarea) {
          const freeze = () => {
            imeFrozenRef.current = { left: imeTextarea.style.left, top: imeTextarea.style.top };
          };
          const unfreeze = () => { imeFrozenRef.current = null; };
          imeTextarea.addEventListener('compositionstart', freeze, { capture: true });
          imeTextarea.addEventListener('compositionend', unfreeze, { capture: true });
          unlisteners.push(() => {
            imeTextarea.removeEventListener('compositionstart', freeze, { capture: true });
            imeTextarea.removeEventListener('compositionend', unfreeze, { capture: true });
          });
          // xterm's internal _syncTextArea runs off its own cursor-move
          // listener (registered at open, before ours), so writing the frozen
          // spot back here wins within the same synchronous dispatch — no
          // intermediate paint, no visible jitter.
          const cursorMoveListener = term.onCursorMove(() => {
            const f = imeFrozenRef.current;
            if (f) {
              imeTextarea.style.left = f.left;
              imeTextarea.style.top = f.top;
            }
          });
          unlisteners.push(() => cursorMoveListener.dispose());
        }
      }

      // ── CJK IME symbol passthrough, commit side (issue #107) ───────────
      // Companion to the keydown/keypress passthrough in
      // attachCustomKeyEventHandler (full mechanism documented there). An IME
      // commit arrives as a plain `input` event on the helper textarea
      // (inputType 'insertText'). xterm's own `input` handler delivers it
      // only when `(!ev.composed || !_keyDownSeen)`; we deliver exactly the
      // complementary case (`ev.composed && keyDownSeen`) — i.e. the commits
      // xterm drops: WKWebView's commit-first flow with a modifier held
      // (Shift+symbol) and keys opted out via the passthrough handler. The
      // 229-first Chromium ordering is left to xterm's CompositionHelper
      // diff path (last229At guard), so every commit is delivered exactly
      // once on every platform. After forwarding we stopPropagation (so
      // xterm's listener can't double-deliver) and clear the textarea (so a
      // later 229-diff can't re-send stale text).
      //
      // Registered CAPTURE-phase on the container so it runs before xterm's
      // capture listener on the textarea itself. Composition commits
      // (pinyin words), emoji-picker inserts and paste are left completely
      // alone — xterm handles them as before.
      if (!__IS_LINUX__) {
        const imeTextarea = termRef.current.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
        if (imeTextarea) {
          const host = termRef.current;
          const markCompositionEnd = () => { ime.lastCompositionEndAt = performance.now(); };
          imeTextarea.addEventListener('compositionend', markCompositionEnd, { capture: true });
          const onImeCommitInput = (ev: Event) => {
            if (ev.target !== imeTextarea) return;
            const ie = ev as InputEvent;
            if (ie.inputType !== 'insertText' || !ie.data || ie.isComposing) return;
            // Non-ASCII commit — arm the caret-key swallow (see the custom
            // key handler) no matter which path delivers the text.
            if (/[^\x00-\x7f]/.test(ie.data)) ime.lastNonAsciiCommitAt = performance.now();
            // Screen readers read the textarea itself — leave it untouched.
            if (term.options.screenReaderMode) return;
            // Chromium ordering: a 229 keydown just preceded this commit —
            // xterm's CompositionHelper diff path owns it.
            if (performance.now() - ime.last229At < 50) return;
            // A composition session just finalized — CompositionHelper's
            // compositionend readout owns that commit.
            if (performance.now() - ime.lastCompositionEndAt < 100) return;
            // Mirror of xterm's delivery condition `(!ev.composed ||
            // !_keyDownSeen)`: only forward when xterm will NOT.
            if (!ie.composed || !ime.keyDownSeen) return;
            forwardInput(ie.data);
            ev.stopPropagation();
            imeTextarea.value = '';
          };
          host.addEventListener('input', onImeCommitInput, { capture: true });
          unlisteners.push(() => {
            host.removeEventListener('input', onImeCommitInput, { capture: true });
            imeTextarea.removeEventListener('compositionend', markCompositionEnd, { capture: true });
          });
        }
      }

      // Disable font ligatures on the DOM renderer rows to prevent
      // box-drawing characters from being merged into ligature glyphs.
      const xtermRows = termRef.current.querySelector('.xterm-rows') as HTMLElement | null;
      if (xtermRows) xtermRows.style.fontVariantLigatures = 'none';

    // GPU-accelerated rendering: WebGL is required for customGlyphs +
    // rescaleOverlappingGlyphs (correct ASCII art / Claude mascot / box
    // border alignment). DOM renderer silently drops those options AND
    // burns ~100% CPU per terminal under AI-CLI token streams.
    //
    // The only veto is software rasterization (llvmpipe, swrast,
    // SwiftShader, Mesa offscreen) — typically headless / VM Linux where
    // WebGL silently falls back to CPU. Modern integrated GPUs (Apple
    // M-series, Intel Iris Xe, AMD APU) handle xterm WebGL fine; the
    // older "dedicated-GPU only" gate was misclassifying Apple Silicon
    // and Intel UHD laptops as DOM-only and tanking their CPU.
    // WebGL is a scarce shared resource (Chromium caps it at ~16 contexts; see
    // attachWebglRenderer). Only spend a context once this terminal is actually
    // on-screen, so tabs opened but never viewed cost zero context. Kept once
    // attached (no renderer thrash on tab switch, matching VS Code's terminal).
    // This laziness is per-TAB, not per-pane: a split tab (FourSplitGrid) dims
    // its inactive panes with opacity, not display:none, so every pane in an
    // ACTIVE split tab already has offsetParent set and attaches WebGL
    // synchronously below — a 4-pane split alone can spend 4 of the ~16
    // budget the moment it's opened. The shared latch still caps the damage
    // (falls back to DOM once exhausted); this just isn't "lazy" within a
    // split the way it is across tabs.
    if (termRef.current!.offsetParent !== null) {
      // Already on-screen — the common case: a freshly-opened active tab.
      // Attach synchronously so the tab you're looking at never shows a
      // one-frame DOM→WebGL swap.
      attachWebglRenderer(term, webglRef, contextLossAttemptsRef);
    } else {
      // Created while hidden (background/restored tab, or a split pane whose
      // tab isn't shown). Attach on first reveal. Element-level visibility is
      // correct for both single tabs and split panes (all visible panes
      // intersect), unlike the focus-scoped `isActive` prop. One-shot.
      const webglIO = new IntersectionObserver((entries) => {
        // `mounted` guards a dispose race: a queued callback firing after the
        // effect cleanup would loadAddon() onto a disposed terminal, and the
        // catch inside attachWebglRenderer would wrongly trip the latch to DOM.
        if (mounted && entries.some((e) => e.isIntersecting)) {
          attachWebglRenderer(term, webglRef, contextLossAttemptsRef);
          webglIO.disconnect();
        }
      });
      webglIO.observe(termRef.current!);
      unlisteners.push(() => webglIO.disconnect());
    }

    fit.fit();

    // Forward keyboard input to Rust PTY backend.
    //
    // Status indicator wiring:
    //   - Claude   → UserPromptSubmit / Stop hooks are authoritative (coffee-cli-hook.py)
    //   - OpenCode → session.status events are authoritative (coffee-cli-opencode-plugin.js)
    //   - Codex    → notify only emits agent-turn-complete (idle); there is NO upstream
    //                "working" signal, so we keep an Enter-based optimistic update for
    //                Codex only. Local slash commands (/init, /diff, /clear, /quit, ...)
    //                are filtered via a tiny per-line buffer so they don't strand the
    //                dot in "working" until the 30s auto-idle fallback.
    let codexLine = '';
    // Single entry point for user-typed data on its way to the PTY. term.onData
    // covers xterm's own key handling; the CJK-IME symbol passthrough below
    // calls the same function for IME-committed text that deliberately bypasses
    // xterm's keydown path (issue #107).
    const forwardInput = (data: string) => {
      commands.tierTerminalInput(sessionId, data).catch(() => {});
      if (tool !== 'codex') return;
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        if (ch === '\r' || ch === '\n') {
          const submitted = codexLine.trimStart();
          codexLine = '';
          // Skip blank lines and Codex local slash commands.
          if (submitted.length > 0 && !submitted.startsWith('/')) {
            notifyUserInputSubmitted(sessionId, tool);
          }
        } else if (ch === '\x7f' || ch === '\b') {
          codexLine = codexLine.slice(0, -1);
        } else if (ch === '\x1b') {
          // Skip ANSI escape sequence (CSI / SS3 / etc.) — arrow keys, function keys.
          // Cheap consume: skip until we see a letter or '~', or end of chunk.
          i++;
          while (i < data.length) {
            const c = data[i];
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '~') break;
            i++;
          }
        } else if (ch >= ' ') {
          codexLine += ch;
        }
      }
    };
    term.onData(forwardInput);

    // ── CJK IME symbol passthrough (issue #107) ──────────────────────────
    // With a Chinese IME active, symbol keys (Shift+9 → （, Shift+/ → ？)
    // never open a composition session — the IME commits the fullwidth symbol
    // straight into the helper textarea (insertText). Two platform flows, both
    // broken in stock xterm (xterm.js #3533; VS Code #192509; Tabby #11013;
    // fcitx5-macos #223):
    //
    //   1. Raw-keydown IMEs (Sogou/fcitx/微信输入法 on Chromium): the keydown
    //      arrives as an ordinary ASCII keystroke (no composition, no 229).
    //      xterm evaluates it, fires the HALFWIDTH char into the PTY and
    //      preventDefault()s before the IME can translate → commit lost.
    //   2. 229 IMEs on WKWebView (macOS built-in Pinyin etc.): the commit
    //      lands FIRST (input event), the keyCode-229 keydown arrives AFTER.
    //      xterm's `input` handler bails because the user is still holding
    //      Shift (its private `_keyDownSeen` is true), and its 229-diff
    //      fallback captures the textarea value AFTER the commit landed →
    //      empty diff → nothing is ever sent. (Chromium's order is the
    //      reverse — 229 first — so the same IME works there.)
    //
    // Fix, three cooperating pieces:
    //   a. THIS HANDLER returns false for unmodified/shifted printable
    //      non-letter keys (keydown AND keypress) so flow-1 keys are never
    //      evaluated/prevented by xterm; the keystroke reaches the IME and
    //      its commit arrives as a plain `input` event. With no IME active
    //      the browser inserts the ASCII char itself — same event, same path,
    //      so English typing is unchanged.
    //   b. A capture-phase `input` listener on the container (wired in
    //      initTerminal below) forwards exactly the commits xterm will NOT
    //      deliver, mirroring xterm's own delivery condition
    //      `(!ev.composed || !_keyDownSeen)` — we deliver only when
    //      `ev.composed && keyDownSeen` — and clears the textarea afterwards
    //      so stale text can never be re-diffed. The 229-first Chromium
    //      ordering is left to xterm's diff path (last229At guard), so each
    //      commit is delivered exactly once on every platform.
    //   c. Pair-inserting IMEs (（）, “”, ‘’) synthesize an ArrowLeft after
    //      the commit to park the caret between the brackets; in a terminal
    //      that key must NOT reach the PTY (it moved the real cursor over
    //      just-typed text — "光标乱窜"). Arrow keys within 150ms of a
    //      non-ASCII commit are bounced back to the textarea (return false).
    //
    // Scope guards — everything else keeps xterm's native path:
    //   • letters a-z/A-Z stay with xterm (the A-Z keypress hack for macOS
    //     caps-lock IMEs depends on it, and pinyin composition works today);
    //   • Ctrl/Alt/Meta combos stay with xterm (shortcuts, copy/paste above);
    //   • composition sessions (pinyin word typing) stay with xterm's
    //     CompositionHelper;
    //   • Linux keeps its own input path (see the WebKitGTK duplication fix
    //     above) and screen-reader mode must not lose textarea updates.
    const ime = {
      // Mirror of xterm's private `_keyDownSeen` (set on every keydown,
      // cleared on every keyup) — piece (b) uses it to predict whether
      // xterm's `input` handler will deliver a given commit.
      keyDownSeen: false,
      // Last keyCode-229 keydown. Distinguishes the two platform orderings:
      // Chromium sends 229 BEFORE the commit (xterm's diff path delivers);
      // WKWebView commits first and sends 229 after (we deliver).
      last229At: 0,
      // Last non-ASCII commit — the window for piece (c)'s caret-key swallow.
      lastNonAsciiCommitAt: 0,
      // Last compositionend — belt-and-braces guard so a composition's final
      // commit can never be double-delivered by piece (b) alongside
      // CompositionHelper's compositionend readout.
      lastCompositionEndAt: 0,
    };
    const isImeSymbolKey = (e: KeyboardEvent): boolean =>
      !__IS_LINUX__ &&
      !term.options.screenReaderMode &&
      !e.ctrlKey && !e.altKey && !e.metaKey && // Shift is allowed — it IS the bug
      !e.isComposing && e.keyCode !== 229 &&
      e.key.length === 1 &&
      !/[a-zA-Z]/.test(e.key);

    // Handle native Copy/Paste shortcuts
    term.attachCustomKeyEventHandler((e) => {
      // IME bookkeeping (issue #107) — mirrors xterm's `_keyDownSeen` and
      // records the Chromium-style 229 ordering for the commit listener.
      if (e.type === 'keydown') {
        ime.keyDownSeen = true;
        if (e.keyCode === 229) ime.last229At = performance.now();
      } else if (e.type === 'keyup') {
        ime.keyDownSeen = false;
      }
      if (e.type === 'keydown') {
        rig.inputStart();
        // Pair-inserting IMEs synthesize a caret-move right after committing
        // （）/“”/‘’ — bounce it back to the textarea (moving the hidden
        // caret is harmless) instead of letting xterm fire it into the PTY
        // where it shifts the REAL cursor over just-typed text (issue #107).
        if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') &&
            !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !e.isComposing &&
            performance.now() - ime.lastNonAsciiCommitAt < 150) {
          return false;
        }
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

        // Copy: Ctrl+C / Cmd+C — only when text is selected (otherwise send SIGINT).
        if (cmdOrCtrl && e.code === 'KeyC') {
          if (term.hasSelection()) {
            clipboardWrite(term.getSelection());
            return false;
          }
        }

        // Paste: Ctrl+V / Cmd+V
        // IMPORTANT: e.preventDefault() stops the browser's native paste
        // event from firing after keydown — without it, xterm's built-in
        // paste handler ALSO fires on the same keystroke, inserting the
        // clipboard text twice.
        if (cmdOrCtrl && e.code === 'KeyV') {
          e.preventDefault();

          // Image-first paste (issue #89): if the clipboard holds a still
          // image, persist it as a temp file and paste that path so the AI
          // CLI can read it off the local filesystem. Routed through the
          // Tauri backend (arboard) — NOT navigator.clipboard.read(), which
          // would pop a WebView2 "wants to read the clipboard" prompt every
          // paste (issue #96, project clipboard rule).
          (async () => {
            const imgPath = await clipboardReadImage();
            if (imgPath) { term.paste(imgPath); return; }
            const text = await clipboardRead();
            if (text) term.paste(normalizePasteNewlines(text));
          })();
          return false;
        }

        // Linux convention: Ctrl+Shift+C always copies, Ctrl+Shift+V always pastes
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
          if (term.hasSelection()) clipboardWrite(term.getSelection());
          return false;
        }
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
          e.preventDefault();

          // Same image-first paste as Ctrl+V (issue #89); backend clipboard
          // read avoids the WebView2 permission prompt (issue #96).
          (async () => {
            const imgPath = await clipboardReadImage();
            if (imgPath) { term.paste(imgPath); return; }
            const text = await clipboardRead();
            if (text) term.paste(normalizePasteNewlines(text));
          })();
          return false;
        }
      }
      // CJK IME symbol passthrough (issue #107 — see the wiring comment
      // above). Returning false opts the key out of xterm's keydown/keypress
      // handling WITHOUT a preventDefault, so the IME (or the browser's own
      // text insertion when no IME is active) can commit the real character.
      if ((e.type === 'keydown' || e.type === 'keypress') && isImeSymbolKey(e)) {
        return false;
      }
      return true; // Let xterm handle all other keys natively
    });

    // ── Alternate-scroll mode (mouse wheel in full-screen TUIs) ───────────
    // Real terminals (Windows Terminal, iTerm2, xterm) translate the mouse
    // wheel into arrow-key presses when an app is in the ALTERNATE screen
    // buffer but has NOT enabled mouse tracking. xterm.js does not implement
    // this, so the wheel does *nothing* in pagers / menu-driven CLIs (less,
    // git log, man, fzf, ratatui apps): the alt-screen has no host scrollback
    // for xterm to scroll, and the app never receives the wheel. That is the
    // "win10 下控制台界面没法鼠标中间滑动 — 微软商店的终端却可以" report
    // (works in Windows Terminal, not here).
    //
    // Strictly scoped so we never fight xterm's own handling:
    //   • normal buffer            → return true → xterm scrolls its scrollback.
    //   • alt-screen + mouse mode  → return true → xterm forwards wheel→mouse
    //                                to the app (Claude/Codex capture the mouse
    //                                and do their own scrolling / Ctrl+T).
    //   • alt-screen + NO mouse    → emit Up/Down arrows so the TUI navigates,
    //                                then return false to swallow the no-op.
    term.attachCustomWheelEventHandler((e) => {
      try {
        const inAltScreen = term.buffer.active.type === 'alternate';
        const mouseOff = term.modes.mouseTrackingMode === 'none';
        if (!inAltScreen || !mouseOff || e.deltaY === 0) return true;

        // Normalize the platform's wheel delta into a line count. WebView2 on
        // Windows reports pixel deltas (deltaMode 0, ~100px/notch); some mice
        // / Linux report line deltas (deltaMode 1, ~3 lines/notch). Convert to
        // notches, then 3 arrow presses per notch (the xterm convention),
        // capped so a fast flick can't flood the PTY.
        const notches =
          e.deltaMode === 1 ? Math.abs(e.deltaY) / 3 :              // lines
          e.deltaMode === 2 ? Math.abs(e.deltaY) :                  // pages
          Math.abs(e.deltaY) / 100;                                // pixels
        const lines = Math.max(1, Math.min(Math.round(notches * 3), 9));

        // App-cursor-keys mode (DECCKM) decides SS3 (ESC O) vs CSI (ESC [);
        // most TUIs accept either, but honor it when xterm exposes it.
        const down = e.deltaY > 0;
        const appCursor = term.modes.applicationCursorKeysMode;
        const seq = appCursor
          ? (down ? '\x1bOB' : '\x1bOA')
          : (down ? '\x1b[B' : '\x1b[A');
        commands.tierTerminalInput(sessionId, seq.repeat(lines)).catch(() => {});
        e.preventDefault(); // we own this wheel event — no default browser scroll
        return false; // handled — suppress xterm's no-op scrollback attempt
      } catch {
        return true; // any introspection failure → fall back to xterm default
      }
    });

    // Clickable links: URLs only (http/https/file). Bare file/dir paths are
    // intentionally NOT matched — unquoted paths with spaces (e.g. Windows
    // "Coffee CLI_3.0.3...exe") can't be reliably bounded by a regex (would
    // truncate → open a missing path → OS error dialog, or over-match → open
    // the wrong file). Users select+copy paths instead. URLs are unambiguous
    // — clear scheme prefix, no spaces.
    // Underlines matched tokens on hover; click opens via Tauri's open_url
    // command (OS default browser).
    // URLs are ASCII per RFC 3986; the -￿ guard stops the match at
    // any non-ASCII char so trailing CJK punctuation/text (e.g. "https://x，看到…")
    // doesn't get swallowed into the link.
    const LINK_RE = /(https?:\/\/[^\s<>()"'-￿]+|file:\/\/\/[^\s<>()"'-￿]+)/g;
    term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = term.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) { callback([]); return; }
        // Build the line text alongside a JS-index → terminal-column map.
        // xterm's range.x is in terminal columns, but a CJK / emoji char is
        // one JS code-unit-ish but two columns wide. Using m.index directly
        // makes the hover underline drift left by one column per wide char
        // sitting before the URL on the same line. Cell iteration keeps the
        // mapping accurate regardless of wide-char prefix.
        let text = '';
        const colByStrIdx: number[] = [];
        const cellCount = line.length;
        for (let col = 0; col < cellCount; col++) {
          const cell = line.getCell(col);
          if (!cell) continue;
          const chars = cell.getChars();
          if (!chars) continue; // empty cell or the right half of a wide char
          for (let i = 0; i < chars.length; i++) colByStrIdx.push(col);
          text += chars;
        }
        const links: any[] = [];
        let m;
        LINK_RE.lastIndex = 0;
        while ((m = LINK_RE.exec(text)) !== null) {
          const raw = m[0].replace(/[),.]+$/, '');
          const firstCol = colByStrIdx[m.index] ?? m.index;
          // URL bodies are ASCII (width-1), so end column = first + length.
          const startCol = firstCol + 1;
          const endCol = firstCol + raw.length;
          links.push({
            range: {
              start: { x: startCol, y: bufferLineNumber },
              end: { x: endCol, y: bufferLineNumber },
            },
            text: raw,
            activate: () => {
              commands.openUrl(raw).catch(() => {});
            },
          });
        }
        callback(links);
      },
    });

    xtermRef.current = term;
    fitRef.current   = fit;
    // Register with the output scheduler before any PTY output can arrive —
    // onOutput (subscribed below in startPty) routes through
    // outputScheduler.enqueue instead of term.write directly, so the session
    // must exist first to avoid a dropped-first-chunk race.
    outputScheduler.registerSession(sessionId, term);
    // Latency rig OUTPUT STOP: term.onRender is xterm's real render-done
    // signal (better than rAF approximation). Always-on (see latency-rig.ts
    // header); near-zero cost — one performance.now() + bounded ring-buffer
    // write per render, no-ops when no output armed this frame.
    term.onRender(() => rig.outputRenderEnd());
    // Tool sets its own tab title via OSC 0/2 (e.g. Claude Code's conversation
    // summary) → xterm fires onTitleChange → mirror it to the tab title.
    // Falls back to cwd basename when no tool title is set (renderTabContent).
    term.onTitleChange(title => dispatch({ type: 'SET_TAB_TITLE', id: sessionId, title }));

    // Debug: track when cursor moves
    term.onCursorMove(() => {
      // Cursor move tracking removed - no longer needed
    });

    // Auto-focus so keyboard input works immediately
    term.focus();

    // ── Register event listeners BEFORE starting PTY ──────────────────────
    // This prevents the race condition where PTY output arrives before
    // the frontend has registered its listeners, causing a blank terminal.

    const startPty = async () => {
      try {
      let remoteConfig: any = {};
      try {
        if (tool === 'remote' && toolData) remoteConfig = JSON.parse(toolData);
      } catch (e) {}
      let hasInjectedPassword = false;

      // Subscribe to PTY events via the singleton bus. One listen() call per
      // event type lives in the bus; we just register per-session handlers
      // into a Map. No N-tab fan-out on hot path.
      const unsubEvents = await subscribeTerminalEvents(sessionId, {
        onOutput: (data) => {
          if (!mounted) return;
          rig.outputStart();
          hasOutputRef.current = true;
          outputBytesRef.current += data.length;
          lastOutputAtRef.current = Date.now();
          outputScheduler.enqueue(sessionId, data);

          // Handle SSH Auto-login via Password injection
          if (tool === 'remote' && remoteConfig.protocol === 'ssh' && remoteConfig.password && !hasInjectedPassword) {
            if (data.toLowerCase().includes('password:')) {
              hasInjectedPassword = true;
              setTimeout(() => {
                commands.tierTerminalRawWrite(sessionId, remoteConfig.password + '\r').catch(() => {});
              }, 200);
            }
          }

          // Track alt-screen flag for other TUI heuristics (splash, focus).
          // Agent status is now driven by hooks via agent-status-bus, not PTY scraping.
          if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
            altScreenRef.current = true;
          }
          if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) {
            altScreenRef.current = false;
          }

          // ── Sentinel Protocol scanner ───────────────────────────
          // Sentinel sits on TOP of MCP. Forward dispatch (pane A → pane B)
          // is handled by the MCP `send_to_pane` tool (see mcp_server.rs)
          // which gives the dispatching agent structured discovery +
          // failure responses. What this scanner handles is the BACKWARD
          // completion receipt:
          //
          //   [COFFEE-DONE:paneN->paneM]
          //     pane N has finished a task and wants to notify pane M.
          //     Gated by sentinelEnabled on BOTH panes (opt-in): with
          //     sentinel on, the frontend lights a green dot on pane N's
          //     badge AND injects "[From pane N] Task complete." + Enter
          //     into pane M's PTY input, which wakes pane M's LLM turn
          //     loop without polling. With sentinel off, the marker sits
          //     inert in pane N's scrollback and the user has to eyeball
          //     completion instead.
          //
          // We STRIP ANSI escape sequences before scanning. Claude Code's
          // TUI wraps response text in CSI sequences (color, bold, cursor
          // positioning, erase-line). Those bytes sit between marker
          // literals and around the text, breaking any regex that treats
          // the raw stream as plain text. Stripping CSI/OSC/single-char
          // escapes normalises the buffer so the regex sees what the
          // user sees.
          //
          // Buffer + offset:
          //   - PTY onData is chunky (256B–4KB); markers can split across
          //     chunks, so we accumulate into a buffer before scanning.
          //   - 8 KB bound keeps the buffer from growing unbounded.
          //   - `markerScanOffsetRef` advances past processed matches so
          //     the same DONE never fires twice when a later chunk
          //     re-triggers the scan.

          // Strip CSI/OSC/single-char ANSI escapes from the chunk before
          // appending. xterm still gets the raw `data` with escapes
          // intact for rendering; only the scan buffer is normalised.
          const cleanData = data
            .replace(/\x1b\[[0-9;?]*[@-~]/g, '')      // CSI (most common)
            .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (title, hyperlink)
            .replace(/\x1b[@-Z\\-_]/g, '');            // single-char escape
          markerScanBufRef.current += cleanData;

          const MAX_BUF = 8192;
          if (markerScanBufRef.current.length > MAX_BUF) {
            const toTrim = markerScanBufRef.current.length - MAX_BUF;
            markerScanBufRef.current = markerScanBufRef.current.slice(toTrim);
            markerScanOffsetRef.current = Math.max(
              0,
              markerScanOffsetRef.current - toTrim
            );
          }

          const unscanned = markerScanBufRef.current.slice(
            markerScanOffsetRef.current
          );
          if (unscanned.includes('[COFFEE-DONE:pane')) {
            const paneIdMatch = sessionId.match(/^(.+)::pane-(\d+)$/);
            if (paneIdMatch) {
              const tabId = paneIdMatch[1];
              const tab = appStateRef.current.terminals.find(t => t.id === tabId);
              const panes = tab?.multiAgent?.panes ?? [];
              let advancedTo = 0;

              // DONE: backward receipt, sentinel-gated on the emitter side.
              const doneRegex = /\[COFFEE-DONE:pane(\d+)->pane(\d+)\]/g;
              let doneM: RegExpExecArray | null;
              while ((doneM = doneRegex.exec(unscanned)) !== null) {
                const emitter = parseInt(doneM[1], 10);
                const target = parseInt(doneM[2], 10);
                const emitterPane = panes.find(p => p.paneIdx === emitter);
                if (emitterPane?.sentinelEnabled) {
                  dispatch({ type: 'SET_PANE_COMPLETION', tabId, paneIdx: emitter, ts: Date.now() });
                  const targetPane = panes.find(p => p.paneIdx === target);
                  if (targetPane?.sentinelEnabled && targetPane.tool !== null && target !== emitter) {
                    const targetId = `${tabId}::pane-${target}`;
                    const notify = `[From pane ${emitter}] Task complete.`;
                    // `paste()` (see registerTabActions below) handles the
                    // trailing CR — it schedules `\r` 30ms after the paste
                    // so the TUI treats it as Enter rather than part of
                    // the bracketed-paste buffer. Don't re-send the CR.
                    getTabActions(targetId)?.paste(notify);
                  }
                }
                advancedTo = Math.max(advancedTo, doneM.index + doneM[0].length);
              }

              if (advancedTo > 0) {
                markerScanOffsetRef.current += advancedTo;
              }
            }
          }
        },
        onStatus: (running, _exitCode) => {
          if (!mounted || running) return;
          setProcessExited(true);
          dispatch({ type: 'SET_AGENT_STATUS', id: sessionId, status: 'idle' });
        },
        onExit: (_exitCode) => {
          // Authoritative "process is actually dead" signal from the Rust
          // child-watcher thread. Critical for the lockup scenario where an
          // intermediate cmd.exe keeps the PTY slave open so reader never
          // sees EOF — without this, the terminal looked frozen forever.
          //
          // No banner written to the terminal on exit (tried this before —
          // see git history — it read as Coffee CLI editorializing over the
          // upstream tool's own output). The CLI's own exit text, if any,
          // already speaks for itself.
          if (!mounted) return;
          setProcessExited(true);
          dispatch({ type: 'SET_AGENT_STATUS', id: sessionId, status: 'idle' });
        },
        onCwd: (cwd) => {
          if (!mounted) return;
          dispatch({ type: 'SET_FOLDER', path: cwd });
        },
      });
      if (mounted) unlisteners.push(unsubEvents); else { unsubEvents(); return; }

      // All listeners registered — NOW start the PTY process
      if (!mounted) return;

      const initialCols = term.cols || 80;
      const initialRows = term.rows || 24;

        try {
          await commands.tierTerminalStart(sessionId, tool, initialCols, initialRows, theme, lang, toolData, folderPath ?? undefined, resumeToken, appStateRef.current.defaultShell);
        } catch (err) {
          // Resume / launch validation failures (missing cwd, bad token
          // format, binary not on PATH) land here. The upstream CLI's own
          // startup errors come through the PTY stream, not this path.
          console.error('[TierTerminal] tierTerminalStart failed', err);
          if (mounted) {
            term.write(`\r\n\x1b[31m${String(err)}\x1b[0m\r\n`);
          }
        }

        // Continuously report on-screen visibility to the backend so its
        // emitter can widen its coalesce window for a tab that's open but not
        // the one being looked at — independent of whole-window
        // BACKGROUND_MODE, which only covers the OS-hidden case. Unlike the
        // one-shot WebGL observer above, this one never disconnects: it flips
        // every tab switch for the life of the session. Placed after
        // tierTerminalStart resolves (not earlier, alongside the WebGL
        // observer) so the backend session is guaranteed to exist before the
        // first report — a race would otherwise silently drop it and this
        // session would default to full-cadence forever.
        if (mounted && termRef.current) {
          const visibilityIO = new IntersectionObserver((entries) => {
            // Re-check `mounted` inside the callback (not just at registration
            // above): IntersectionObserver callbacks are delivered via the
            // browser's rendering-update step, not synchronously with
            // disconnect(), so one can still be in flight when cleanup runs.
            // Backend no-ops on an unknown session either way, but matching
            // the WebGL observer's discipline keeps this from firing at all.
            if (!mounted) return;
            const visible = entries.some((e) => e.isIntersecting);
            commands.setSessionActive(sessionId, visible).catch(() => {});
            outputScheduler.setActive(sessionId, visible);
            // WebGL lifecycle (Orca suspendRendering pattern): release this
            // tab's GL context when hidden so it doesn't hold one of the ~16
            // active-context slots, and re-attach on reveal. The canvasHidden
            // mask (useLayoutEffect above) covers the re-attach transition —
            // it masks the canvas until xterm's first post-attach render fires
            // onRender → reveal. attachWebglRenderer is idempotent (no-op if
            // already attached or process latched); detachWebglRenderer is a
            // no-op when already detached. Element-level intersection is
            // correct for both whole-tab display:none toggles AND split panes,
            // so non-active panes in a split tab (still visible) keep their
            // contexts.
            if (visible) {
              attachWebglRenderer(term, webglRef, contextLossAttemptsRef);
            } else {
              detachWebglRenderer(webglRef);
            }
          });
          visibilityIO.observe(termRef.current);
          unlisteners.push(() => visibilityIO.disconnect());
        }

        // After PTY is running, wait two frames for layout to settle then
        // send the true terminal size. This fixes TUI adaptive-width tools
        // (Claude Code, etc.) that respond to SIGWINCH — the initial fit may
        // have run before the container reached its final dimensions.
        await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        if (mounted && fitRef.current && xtermRef.current) {
          fitRef.current.fit();
          const t2 = xtermRef.current;
          if (t2.cols > 0 && t2.rows > 0) {
            commands.tierTerminalResize(sessionId, t2.cols, t2.rows).catch(() => {});
          }
        }

        // Trust prompt is shown to the user directly. Previously auto-skipped,
        // but we want the user to see the real agent screen and decide.
      } catch (err) {
        console.warn('[TierTerminal] startPty failed:', err);
        term.writeln(`\x1b[31mFailed to start terminal: ${err}\x1b[0m`);
        if (mounted) setStartFailed(true);
      }
    };

    startPty();
    }; // end initTerminal

    initTerminal();

    // Resize observer — CRITICAL: Never call fit() when the container is hidden
    // (display:none gives zero dimensions, causing xterm to collapse to 1 column)
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      // Skip if container has zero dimensions (hidden tab)
      if (width < 10 || height < 10) return;
      try { fit.fit(); } catch {}
      // Notify PTY backend of the new size so the CLI tool can redraw
      try {
        const cols = term.cols;
        const rows = term.rows;
        if (cols > 0 && rows > 0) {
          commands.tierTerminalResize(sessionId, cols, rows).catch(() => {});
        }
      } catch {}
    });
    ro.observe(termRef.current!);

    return () => {
      mounted = false;
      unregisterFocus();
      ro.disconnect();
      term.dispose();
      outputScheduler.unregisterSession(sessionId);
      xtermRef.current = null;
      webglRef.current = null;
      unlisteners.forEach(u => u());
      // Skip kill if this session was detached to a new window
      if (detachedSessions.has(sessionId)) {
        detachedSessions.delete(sessionId);
      } else {
        commands.tierTerminalKill(sessionId).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Theme sync ───────────────────────────────────────────────────────────

  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.theme = buildXtermTheme(theme, hasBg, termColorScheme, isRawShell);
  }, [theme, termColorScheme, hasBg, isRawShell]);

  // ── Terminal font sync (live, no PTY restart) ────────────────────────────
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.fontFamily = buildFontFamily(termFont);
    // Glyph metrics changed → refit, but ONLY when visible. termFont is global,
    // so this effect fires in every tab incl. hidden (display:none) ones, where
    // fit() would read ~0 size and collapse the grid to ~1 col. The activation
    // path re-fits with the new font when a hidden tab is shown again.
    const el = termRef.current;
    if (el && el.clientWidth > 10 && el.clientHeight > 10) {
      try { fitRef.current?.fit(); } catch {}
    }
  }, [termFont]);

  // ── IME focus-scroll guard ───────────────────────────────────────────────
  // Defense-in-depth for the `overflow: clip` fix in TierTerminal.css.
  // Scroll events DO NOT bubble, so a listener on `wrapRef` alone misses
  // scrolls happening on descendants like `.xterm` (xterm.js creates that
  // element, so it's not directly reffable). We use capture-phase listening
  // to catch scroll events from any descendant element and snap them back.
  // This guards against WebView2 builds without `overflow: clip` support
  // and any future descendant that silently becomes scrollable.
  useEffect(() => {
    const root = wrapRef.current;
    if (!root) return;
    const onScroll = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target || !root.contains(target)) return;
      if (target.scrollLeft !== 0) target.scrollLeft = 0;
    };
    root.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => root.removeEventListener('scroll', onScroll, { capture: true });
  }, []);

  // ── macOS Cmd+C copy fix ─────────────────────────────────────────────────
  // On macOS, Tauri installs a default app menu (we set none — see
  // server.rs `tauri::Builder::default()`), and its Edit ▸ Copy item binds
  // ⌘C to the native `copy:` action. Menu key-equivalents are handled by
  // AppKit BEFORE the keystroke ever reaches the webview, so the ⌘C branch of
  // `attachCustomKeyEventHandler` above NEVER runs on macOS — that handler is
  // why copy works on Windows/Linux (no menu bar intercepts Ctrl+C). Worse,
  // native `copy:` copies the DOM text selection, but xterm paints its
  // selection on a WebGL/canvas layer (not a DOM selection), so the menu copies
  // nothing and the user's clipboard is left untouched. That's issue #35.
  //
  // We can't easily stop the menu, but WebKit's `copy:` still dispatches a DOM
  // `copy` event first. We intercept it (capture phase, scoped to this
  // terminal's subtree so HTML inputs elsewhere keep their native copy), inject
  // xterm's real selection into the event's clipboardData, and preventDefault
  // so the empty native copy can't overwrite it. macOS-only and purely
  // additive: Windows/Linux keep using the keydown handler unchanged, and if
  // the event ever lacks clipboardData we bail without preventing the native
  // copy, so the worst case is today's behavior (plus right-click ▸ Copy).
  useEffect(() => {
    const isMac = navigator.userAgent.toLowerCase().includes('mac');
    if (!isMac) return;
    const root = wrapRef.current;
    if (!root) return;
    const onCopy = (e: ClipboardEvent) => {
      const term = xtermRef.current;
      if (!term || !term.hasSelection() || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', term.getSelection());
      e.preventDefault();
    };
    root.addEventListener('copy', onCopy, { capture: true });
    return () => root.removeEventListener('copy', onCopy, { capture: true });
  }, []);

  // ── Tab actions registry ────────────────────────────────────────────────
  // Expose "paste into this tab's xterm" and "where is the cursor on screen"
  // to the app-level Gambit overlay. Gambit is rendered outside the
  // TierTerminal tree, so it can't access xtermRef directly — it looks up
  // the active tab's actions in the registry instead.
  useEffect(() => {
    const unregister = registerTabActions(sessionId, {
      paste: (text: string): boolean => {
        const term = xtermRef.current;
        // If the xterm isn't mounted yet (tab still loading, PTY spawn in
        // flight, etc.) report failure so the caller can preserve the
        // source draft instead of silently losing it.
        if (!term) return false;
        // term.paste() goes through onData, which our handler forwards to the
        // PTY with bracketed-paste framing when the TUI has enabled it.
        // Newlines and IME composition round-trip correctly. Follow with CR
        // to submit.
        //
        // Defer the CR so it arrives as a separate PTY read. Claude Code's
        // Ink input handler enters a paste-end digestion state for ~100ms
        // after the bracketed-paste close (`\x1b[201~`) — any CR that lands
        // inside that window is absorbed as part of the paste buffer, so the
        // text stays in the prompt without submitting. The original 30ms
        // worked on older Claude versions; modern builds need ≥120ms (live
        // measurement on 2026-04-26 was 152–164ms across two pane types).
        // 150ms with the natural ~10ms timer slack puts us comfortably past
        // the window. Windows ConPTY coalesces PTY writes differently but
        // the delay is harmless there.
        term.paste(normalizePasteNewlines(text));
        setTimeout(() => {
          commands.tierTerminalInput(sessionId, '\r').catch(() => {});
        }, 150);
        return true;
      },
      insertText: (text: string): boolean => {
        const term = xtermRef.current;
        if (!term) return false;
        // Same path as paste() but without the trailing CR — file-drop
        // mirrors OS-native terminal behavior: path appears at the cursor
        // as if typed, user edits/sends from there.
        term.paste(normalizePasteNewlines(text));
        return true;
      },
      cursorScreenPos: () => {
        const wrap = wrapRef.current;
        const term = xtermRef.current;
        if (!wrap || !term) return null;
        const wrapRect = wrap.getBoundingClientRect();
        const screenEl = termRef.current?.querySelector('.xterm-screen') as HTMLElement | null;
        const cellW = screenEl && term.cols > 0 ? screenEl.clientWidth / term.cols : 8;
        const cellH = screenEl && term.rows > 0 ? screenEl.clientHeight / term.rows : 17;
        // .tier-xterm-wrap has padding: 20px 0 20px 24px
        return {
          x: wrapRect.left + 24 + term.buffer.active.cursorX * cellW,
          y: wrapRect.top + 20 + term.buffer.active.cursorY * cellH + cellH + 4,
        };
      },
    });
    return unregister;
  }, [sessionId]);

  // ── File-drop target ────────────────────────────────────────────────────
  // Match OS-native terminal behavior: dragging a file onto the terminal
  // inserts its absolute path at the cursor as if typed. Only the active
  // tab claims the rect — inactive tabs return null and are skipped.
  const isActiveRef = useRef(isActive);
  useEffect(() => { isActiveRef.current = isActive; }, [isActive]);
  useEffect(() => {
    return registerFileDropTarget({
      priority: 100,
      rect: () => {
        if (!isActiveRef.current) return null;
        return wrapRef.current?.getBoundingClientRect() ?? null;
      },
      insert: (paths) => {
        getTabActions(sessionId)?.insertText(formatPathsForInsert(paths));
      },
    });
  }, [sessionId]);

  // ── Active tab focus restoration ─────────────────────────────────────────
  // Cache last-sent size so we skip redundant PTY resize calls when tab
  // switches back to the same dimensions (no window resize in between).
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);

  // When this session becomes the active tab, refit + focus after layout.
  // Uses double-rAF instead of a 150ms setTimeout so perceived switch latency
  // drops from 150ms to ~32ms (two frames).
  //
  // useLayoutEffect (not useEffect) so the mask below is committed BEFORE the
  // browser paints the now-visible tab — useEffect runs post-paint, which is
  // exactly when the stale WebGL frame would flash through (issue #47). We
  // only mask when xterm already exists (a real switch-back, not first mount,
  // where the splash covers init and there is no stale frame yet).
  useLayoutEffect(() => {
    if (!isActive) return;
    if (xtermRef.current) setCanvasHidden(true);

    // Synchronously re-attach WebGL if it was detached on hide. The visibility
    // IntersectionObserver's attach is ASYNC and races this effect's rAF
    // fit()+refresh(): when the IO attach lands AFTER that refresh, the new GL
    // canvas never receives an initial render before the mask's onRender
    // reveal (or its 150 ms fallback), so the switch-back shows a blank/stale
    // canvas stuck until a resize forces fit() (issue #74). Attaching here —
    // pre-rAF, pre-paint — makes the rAF refresh below render to the GL canvas,
    // so the onRender reveal lands on a freshly-painted frame (issue #47).
    // Idempotent: attachWebglRenderer no-ops if already attached or the
    // process-wide DOM latch is tripped. offsetParent gates on real
    // on-screen-ness (correct for both single tabs and split panes); the IO
    // observer remains the attach trigger for panes whose isActive doesn't
    // toggle. `xtermRef.current` gates out first mount, where initTerminal's
    // own offsetParent/IO path owns the first attach and the splash covers
    // any race.
    if (
      xtermRef.current && !webglRef.current &&
      termRef.current && termRef.current.offsetParent !== null
    ) {
      attachWebglRenderer(xtermRef.current, webglRef, contextLossAttemptsRef);
    }

    let f1 = 0, f2 = 0;
    let revealed = false;
    let renderSub: { dispose: () => void } | null = null;
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      renderSub?.dispose();
      renderSub = null;
      setCanvasHidden(false);
    };

    f1 = requestAnimationFrame(() => {
      f2 = requestAnimationFrame(() => {
        // fit() can throw if the container is momentarily zero-size during a
        // layout race — guard it (same as the ResizeObserver path) so a throw
        // never skips the onRender subscription + resize IPC below and strand
        // the resize. reveal() is still backstopped by the fallback regardless.
        try { fitRef.current?.fit(); } catch {}
        xtermRef.current?.focus();
        const term = xtermRef.current;
        if (!term || term.cols <= 0 || term.rows <= 0) { reveal(); return; }
        // Force a redraw of the current buffer, then unmask on the first real
        // frame xterm draws — guarantees the fresh content is on the canvas
        // before we reveal it.
        renderSub = term.onRender(() => reveal());
        term.refresh(0, term.rows - 1);
        const prev = lastResizeRef.current;
        if (!prev || prev.cols !== term.cols || prev.rows !== term.rows) {
          lastResizeRef.current = { cols: term.cols, rows: term.rows };
          commands.tierTerminalResize(sessionId, term.cols, term.rows).catch(() => {});
        }
      });
    });

    // Safety net: never strand the canvas masked if onRender doesn't fire.
    const fallback = setTimeout(reveal, 150);
    return () => {
      cancelAnimationFrame(f1);
      cancelAnimationFrame(f2);
      clearTimeout(fallback);
      renderSub?.dispose();
      revealed = true;
    };
  }, [isActive, sessionId]);

  // ── Stale-frame ghost on window foreground (issue #47 comment) ──────────
  // While the OS window is backgrounded the browser throttles rAF to ~1 fps
  // (or pauses it entirely), so xterm's WebGL canvas stops repainting even
  // though the active agent keeps streaming into the buffer — the scheduler
  // writes immediately for the foreground tab, so the buffer races ahead of
  // the canvas. On alt-tab back, the compositor shows that now-stale canvas
  // for 1-2 frames before rAF resumes and xterm catches up: the same "残影"
  // as a tab switch, just triggered by the OS focus change rather than the
  // tab bar. The tab-switch mask above doesn't catch it (isActive doesn't
  // change), so reuse the canvasHidden mechanism here: mask pre-paint, force
  // a refresh on the next frame, reveal on the first real render. Only the
  // active terminal masks — background tabs already had their GL context
  // detached by the visibility IO and re-attach via their own path.
  // window-focus-filter absorbs the spurious blur+focus pair from
  // start_dragging (Windows), so this only fires on real alt-tabs.
  useEffect(() => {
    const unsubscribe = onWindowForeground(() => {
      if (!isActiveRef.current) return;
      const term = xtermRef.current;
      if (!term) return;
      setCanvasHidden(true);
      let revealed = false;
      let renderSub: { dispose: () => void } | null = null;
      let f1 = 0, fallback = 0;
      const reveal = () => {
        if (revealed) return;
        revealed = true;
        renderSub?.dispose();
        renderSub = null;
        cancelAnimationFrame(f1);
        clearTimeout(fallback);
        setCanvasHidden(false);
      };
      f1 = requestAnimationFrame(() => {
        try { if (term.rows > 0) term.refresh(0, term.rows - 1); } catch {}
        renderSub = term.onRender(() => reveal());
      });
      // Same safety-net rationale as the activation effect: never strand the
      // canvas masked if onRender doesn't fire (idle terminal, no dirty rows).
      fallback = setTimeout(reveal, 180);
    });
    return unsubscribe;
  }, []);

  // ── Startup splash dismissal ────────────────────────────────────────────
  // Detect real TUI via alternate screen buffer entry (\x1b[?1049h).
  // This precisely distinguishes "database migration text" from "actual TUI rendered".
  // Also: dismiss immediately if the process exited or IPC failed — no need to
  // make the user wait the full timeout when the tool clearly can't start.
  useEffect(() => {
    if (!showSplash) return;
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      setSplashFading(true);
      // 300 ms fade-out (was 600). The splash is dismissed quickly
      // now that we trigger on first real output, so the underlying
      // tool content is usually already painted; a long crossfade
      // makes the splash "linger" visibly on top of the live REPL.
      setTimeout(() => setShowSplash(false), 300);
    };
    const poll = setInterval(() => {
      const elapsed = Date.now() - splashStartRef.current;
      if (elapsed < 800) return; // brief branding flash
      // Immediate bail-out: process already exited or IPC call failed
      if (processExited || startFailed) {
        dismiss();
        clearInterval(poll);
        return;
      }
      // Primary signal: TUI has entered alternate screen buffer (\x1b[?1049h),
      // set by the PTY output handler. Covers Claude/Codex/OpenCode/Hermes.
      if (altScreenRef.current) {
        dismiss();
        clearInterval(poll);
        return;
      }
      // Inline-mode signal: some tools (current Claude Code builds, simple
      // CLIs) print their banner directly to the regular terminal instead
      // of entering alt-screen. We need a "first frame painted" proxy
      // that's stronger than "any output", because CLIs commonly print a
      // tiny preamble ("Connecting...", auth-check spinners, ~20 bytes)
      // and then go silent for several seconds before the real REPL
      // appears — dismissing on the preamble leaves the user staring at
      // an empty terminal. Combined gate:
      //   • outputBytes ≥ 512 — filters trivial preambles; a real banner
      //     (logo + version + prompt) easily clears this.
      //   • silence ≥ 500 ms — output stream has paused, meaning the CLI
      //     finished writing its first frame and is awaiting input.
      //   • elapsed > 1500 ms — branding window respected.
      // If a CLI prints continuously without pause, we never trip silence
      // and fall through to the maxWait fallback below.
      const sinceLastOutput = Date.now() - lastOutputAtRef.current;
      if (
        outputBytesRef.current >= 512 &&
        sinceLastOutput >= 500 &&
        elapsed > 1500
      ) {
        dismiss();
        clearInterval(poll);
        return;
      }
      // Continuously-emitting inline CLIs never trip the silence gate above:
      // Claude Code's idle input box repaints a cursor-blink frame roughly
      // every 500 ms, so `sinceLastOutput` keeps resetting and the splash would
      // otherwise hang until the 15 s maxWait even though the REPL is already
      // up. Once a real frame is painted (≥512 B) and the branding window has
      // passed, the tool IS interactive — dismiss without requiring silence.
      if (outputBytesRef.current >= 512 && elapsed > 2000) {
        dismiss();
        clearInterval(poll);
        return;
      }
      // Fallback timeout: shell tabs are fast (3s), AI CLI tools may
      // take longer (15s) before the first meaningful frame.
      const maxWait = tool === 'terminal' ? 3000 : 15000;
      if (elapsed > maxWait) {
        dismiss();
        clearInterval(poll);
      }
    }, 150);
    return () => clearInterval(poll);
  }, [showSplash, processExited, startFailed]);

  // ── Render ───────────────────────────────────────────────────────────────

  const solidBg = THEME_TERMINAL_BG[theme] || (theme === 'light' ? '#eeebe2' : '#0c0c0c');
  const terminalBg = hasBg ? 'transparent' : solidBg;

  return (
    <div className="tier-terminal" style={{ background: terminalBg, position: 'relative' }}>
      {/* Custom background (image/video) behind terminal text */}
      {hasBg && bgUrl && (
        <div className="tier-terminal-bg">
          {bgType === 'video' ? (
            <video src={bgUrl} autoPlay loop muted playsInline />
          ) : (
            <img src={bgUrl} alt="" draggable={false} />
          )}
        </div>
      )}
      {/* No mid-session "could not return to conversation" banner. The
          resume flow itself works fine; the banner was the bug — it
          painted every non-zero exit (deliberate /exit, model swap,
          transient teardown) as a fatal failure, making the feature
          read as broken when the underlying spawn was healthy. The
          upstream CLI's own stdout already explains anything actually
          worth surfacing; we don't need to layer our own verdict. */}

      {/* xterm.js: handles all rendering, input, and scrolling. */}
      <div
        ref={wrapRef}
        className="tier-xterm-wrap"
        // Hidden for the 1-2 frames after a tab switch-back so the stale WebGL
        // framebuffer never flashes; the backdrop behind the wrap shows through
        // until xterm repaints — solid theme bg (opaque), the wallpaper layer
        // (hasBg), or the glass tint (transparent themes), whichever applies.
        // See the activation effect above (issue #47).
        style={canvasHidden ? { opacity: 0 } : undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ x: e.clientX, y: e.clientY, hasSelection: !!xtermRef.current?.hasSelection() });
        }}
        onMouseDown={(e) => {
          // Windows IME fix (issue #88), part 1 of 2: on left-click, re-anchor
          // the hidden .xterm-helper-textarea to the buffer cursor (the TUI
          // input box), so Windows IME later re-reads the input-box position
          // instead of the click point. Coordinate formula matches xterm's own
          // _syncTextArea (left = cursorX * cellW, top = cursorY * cellH,
          // relative to .xterm-screen). Left-click only; middle/right have
          // their own paths.
          //
          // The blur/focus cycle that makes IME actually re-read this position
          // is deliberately NOT here — cycling focus on mousedown interrupts
          // the in-progress mouse gesture and breaks xterm drag selection
          // (issue #92). It runs in onClick, once the gesture is over.
          if (!__IS_LINUX__ && navigator.userAgent.toLowerCase().includes('win') && e.button === 0) {
            // Never move the textarea mid-composition — the candidate window
            // is pinned for the composition's lifetime (see init effect).
            if (imeFrozenRef.current) return;
            const term = xtermRef.current;
            const textarea = termRef.current?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
            const screenEl = termRef.current?.querySelector('.xterm-screen') as HTMLElement | null;
            if (term && textarea && screenEl) {
              const cellW = term.cols > 0 ? screenEl.clientWidth / term.cols : 8;
              const cellH = term.rows > 0 ? screenEl.clientHeight / term.rows : 17;
              const cx = Math.min(term.buffer.active.cursorX, term.cols - 1);
              const cy = term.buffer.active.cursorY;
              textarea.style.left = `${cx * cellW}px`;
              textarea.style.top = `${cy * cellH}px`;
            }
          }
        }}
        onClick={() => {
          // Windows IME fix (issue #88), part 2 of 2: the mouse gesture is
          // complete, so blur/refocus the helper textarea to force Windows IME
          // to re-read the position anchored on mousedown. Skipped when the
          // gesture produced a selection — that was a drag-select, not an
          // intent to type, and cycling focus there serves no purpose
          // (issue #92).
          if (!__IS_LINUX__ && navigator.userAgent.toLowerCase().includes('win')) {
            // Blurring now would cancel an in-flight composition — let it
            // finish; the next click re-anchors.
            if (imeFrozenRef.current) return;
            if (xtermRef.current?.hasSelection()) return;
            const textarea = termRef.current?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
            if (textarea) {
              textarea.blur();
              setTimeout(() => textarea.focus(), 0);
            }
          }
        }}
        onPaste={async (e) => {
          // Issue #89: Support pasting images from clipboard into terminal
          // (same as Gambit supports). Save image to temp file and paste path.
          const items = e.clipboardData?.items;
          if (!items) return; // Let xterm handle it

          // Check if there's an image in the clipboard
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.startsWith('image/')) {
              e.preventDefault(); // Only prevent default if there's actually an image
              const blob = item.getAsFile();
              if (!blob) continue;

              const reader = new FileReader();
              reader.onload = async (evt) => {
                const dataUrl = evt.target?.result as string;
                if (!dataUrl || !dataUrl.startsWith('data:')) return;

                // Extract base64 and extension from data URL
                // Format: data:image/png;base64,iVBORw0KG...
                const match = dataUrl.match(/^data:image\/([^;]+);base64,(.+)$/);
                if (!match) return;

                const [, ext, base64] = match;

                try {
                  // Save to temp file via Tauri command
                  const path = await commands.saveClipboardImage(base64, ext);

                  // Paste the file path into terminal
                  const term = xtermRef.current;
                  if (term) {
                    term.paste(path);
                  }
                } catch (err) {
                  console.error('Failed to save clipboard image:', err);
                }
              };
              reader.readAsDataURL(blob);
              break; // Only handle first image
            }
          }

          // If no image found, let the event propagate to xterm for normal text paste
        }}
      >
        {/* Raw shells get the `raw-shell` class so the CSS cursor-hiding
            rule skips them (issue #95 — see TierTerminal.css). */}
        <div ref={termRef} className={`tier-xterm${isRawShell ? ' raw-shell' : ''}`} />
      </div>

      {/* Terminal right-click context menu */}
      {ctxMenu && (
        <TermContextMenu
          menu={ctxMenu}
          onClose={closeCtxMenu}
          onCopy={() => {
            const text = xtermRef.current?.getSelection();
            if (text) clipboardWrite(text);
            closeCtxMenu();
          }}
          onPaste={async () => {
            // Image-first paste (issue #89), then text. Backend clipboard
            // read (arboard) avoids the WebView2 permission prompt (issue #96).
            const imgPath = await clipboardReadImage();
            if (imgPath) {
              xtermRef.current?.paste(imgPath);
              closeCtxMenu();
              return;
            }
            const text = await clipboardRead();
            if (text && xtermRef.current) xtermRef.current.paste(normalizePasteNewlines(text));
            closeCtxMenu();
          }}
          onSelectAll={() => {
            xtermRef.current?.selectAll();
            closeCtxMenu();
          }}
        />
      )}

      {/* Gambit — the floating compose window — is rendered once at the App
          level (see ActiveGambit). It reads the active tab's session state
          and uses the tab-actions registry to paste into whichever xterm is
          active, so TierTerminal no longer needs to host it. */}

      {/* No "tool failed to launch" / "process exited unexpectedly"
          fallback overlay. If the tool isn't on PATH the OS prints its
          own command-not-found message into xterm; if it crashes mid-run
          the CLI's own stderr is already in the scrollback. Layering our
          generic Coffee CLI verdict on top either echoes that message
          in vaguer wording or — worse — flags deliberate /exit and
          model-swap restarts as failures. The tool speaks for itself. */}

      {/* Startup splash — covers ugly init output with branded loading screen */}
      {showSplash && (
        <div
          className={`tier-loading-splash ${splashFading ? 'fade-out' : ''}`}
          style={{ background: solidBg }}
        >
          {/* Animated coffee cup + label + dots — grouped as one visual unit */}
          <div className="splash-group">
            <div className="splash-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <mask id={`splashMask-${sessionId}`}>
                    <path fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                      d="M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4">
                      {/* Linux gate — see Explorer.tsx brand-icon for full rationale. */}
                      {!__IS_LINUX__ && (
                        <animate attributeName="d" dur="3s" repeatCount="indefinite"
                          values="M8 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4;M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4"/>
                      )}
                    </path>
                    <path d="M4 7h16v0h-16v12h16v-32h-16Z">
                      <animate fill="freeze" attributeName="d" begin="1s" dur="0.6s" to="M4 2h16v5h-16v12h16v-24h-16Z"/>
                    </path>
                  </mask>
                </defs>
                <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
                  <path fill="currentColor" fillOpacity="0" strokeDasharray="48"
                    d="M17 9v9c0 1.66 -1.34 3 -3 3h-6c-1.66 0 -3 -1.34 -3 -3v-9Z">
                    <animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="48;0"/>
                    <animate fill="freeze" attributeName="fill-opacity" begin="1.6s" dur="0.4s" to="1"/>
                  </path>
                  <path fill="none" strokeDasharray="16" strokeDashoffset="16"
                    d="M17 9h3c0.55 0 1 0.45 1 1v3c0 0.55 -0.45 1 -1 1h-3">
                    <animate fill="freeze" attributeName="stroke-dashoffset" begin="0.6s" dur="0.3s" to="0"/>
                  </path>
                </g>
                <path fill="currentColor" d="M0 0h24v24H0z" mask={`url(#splashMask-${sessionId})`}/>
              </svg>
            </div>
            {(() => {
              const splashText =
                toolName ||
                (tool && (toolLabel[tool] ?? getToolDisplayName(tool))) ||
                'Loading';
              // Pick splash font by CONTENT language, not UI language. The tab
              // for Claude Code shows "Claude Code" in any UI locale, and the
              // italic-serif art treatment only reads well for Latin glyphs.
              // Conversely, CJK splash text (人格测试 / 終端 / etc.) breaks
              // under italic serif and needs the stable bold display.
              const hasCJK = /[一-鿿぀-ヿ가-힯]/.test(splashText);
              return <span className="splash-label" lang={hasCJK ? 'zh' : 'en'}>{splashText}</span>;
            })()}
            <div className="splash-dots">
              <span className="splash-dot" />
              <span className="splash-dot" />
              <span className="splash-dot" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// React.memo restored 2026-07-05. Was temporarily removed in 68664a4
// (2026-04-14) while investigating a launch regression ("splash shows but
// PTY never produces output") that was never confirmed to be caused by memo —
// it has been "temporary" for ~3 months and launches work fine, so the
// regression was almost certainly fixed by a later commit and memo was a false
// attribution. Using no-arg memo (shallow-compares ALL props) instead of the
// original custom comparator, which was incomplete — it only checked 7 props
// and missed resumeToken/hasBg/bgUrl/bgType/termColorScheme/termFont/
// sentinelEnabled, so those prop changes would have wrongly skipped a
// re-render. If the launch regression recurs in dev (StrictMode double-invoke),
// revert this; Phase 1-3 do not depend on memo.
export const TierTerminal = memo(TierTerminalImpl);
