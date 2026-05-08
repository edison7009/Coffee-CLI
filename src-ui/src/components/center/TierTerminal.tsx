// TierTerminal.tsx — xterm.js terminal renderer with PTY backend.
//
// Pure terminal — no text interception, no overlay. Output from the child
// process is piped byte-for-byte to xterm.
//
// Perf note: this component is wrapped in React.memo at the bottom of this
// file. All state that affects rendering is passed in via props so that
// unrelated global state changes (agent status, other tabs' folder changes,
// etc.) don't cascade into this component.

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { clipboardRead, clipboardWrite } from '../../lib/clipboard';
import { subscribeTerminalEvents } from '../../lib/pty-event-bus';
import { registerTerminalFocus } from '../../lib/focus-registry';
import { registerTabActions, getTabActions } from '../../lib/tab-actions';
import { registerFileDropTarget, formatPathsForInsert } from '../../lib/file-drop';
import { notifyUserInputSubmitted } from '../../lib/agent-status-bus';
import { commands } from '../../tauri';
import { useAppDispatch, useAppState, type ToolType, type ThemeColor } from '../../store/app-state';
import { useT } from '../../i18n/useT';
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
function deriveSelectionBg(hex: string, isDark: boolean): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return isDark ? 'rgba(196,149,106,0.3)' : 'rgba(196,149,106,0.25)';
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 0xff) * 0.8);
  const g = Math.round(((n >> 8) & 0xff) * 0.8);
  const b = Math.round((n & 0xff) * 0.8);
  return `rgba(${r},${g},${b},${isDark ? 0.4 : 0.3})`;
}

// xterm's caret was a leftover from raw-shell mode (terminal / remote) — every
// other surface the user touches (each AI agent's input box, the Compose
// textarea) paints its own caret, so xterm's was either redundant or a
// stranded artifact. Always paint the cursor in the background color so the
// WebGL renderer effectively erases it; the DOM renderer is also covered by
// `.xterm-cursor { display: none }` in TierTerminal.css.
function buildXtermTheme(themeName: string, hasBg: boolean | undefined, schemeId?: string) {
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
    cursor: bgOpaque,
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

interface TierTerminalProps {
  sessionId: string;
  tool: ToolType;
  /** Display name of the tool (from the local built-in catalog). Used by
   * splash + launch-failed panels; lets the splash show a friendly name
   * even for agents that aren't in the hardcoded `toolLabel` fallback. */
  toolName?: string;
  theme: ThemeColor;
  lang: string;
  isActive: boolean;
  toolData?: string;
  folderPath?: string | null;
  hasBg?: boolean;
  bgUrl?: string;
  bgType?: 'image' | 'video' | 'none';
  termColorScheme?: string;
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
  sessionId, tool, toolName, theme, lang, isActive, toolData, folderPath, hasBg, bgUrl, bgType, termColorScheme, sentinelEnabled,
}: TierTerminalProps) {
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
  const wrapRef  = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef   = useRef<FitAddon | null>(null);

  // ── Startup splash state ─────────────────────────────────────────────────
  const [showSplash, setShowSplash] = useState(true);
  const [splashFading, setSplashFading] = useState(false);
  const splashStartRef = useRef(Date.now());
  const altScreenRef = useRef(false); // True when TUI enters alternate screen buffer

  // ── Launch failure detection ─────────────────────────────────────────────
  const hasOutputRef = useRef(false); // Set to true when PTY emits visible output
  const [processExited, setProcessExited] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  // First exit event to arrive (onExit from child-watcher, or onStatus from
  // reader EOF) wins the right to write the "[Process exited]" scrollback
  // line. Prevents duplication when both fire. The child-watcher's onExit
  // typically arrives first with the real exit code; reader-EOF onStatus
  // then arrives with a hardcoded 0 and correctly becomes a no-op.
  const exitMessageWrittenRef = useRef(false);
  // Rolling buffer for agent-to-agent marker scanning. PTY chunks can split
  // `[COFFEE-TELL:...]` / `[COFFEE-DONE:...]` across boundaries; the buffer
  // reassembles chunks so markers match reliably. `markerScanOffsetRef`
  // tracks how far we've already scanned to avoid re-firing the same
  // dispatch when a later chunk arrives and re-triggers the scan. See the
  // scanner in `onData` below for the consume/advance logic.
  const markerScanBufRef = useRef<string>('');
  const markerScanOffsetRef = useRef<number>(0);

  // ── Terminal context menu ────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const t = useT();

  const toolLabel: Record<string, string> = {
    claude: 'Claude Code',
    qwen: 'Qwen Code', hermes: 'Hermes Agent', opencode: 'OpenCode', openclaw: 'OpenClaw',
    codex: 'Codex CLI', gemini: 'Gemini CLI',
    remote: t('tool.remote'), terminal: t('tool.terminal'),
  };

  // ── xterm.js init ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!termRef.current || xtermRef.current) return;

    let mounted = true;
    const unlisteners: (() => void)[] = [];

    const isLinux = navigator.userAgent.toLowerCase().includes('linux');
    const isMac = navigator.userAgent.toLowerCase().includes('mac');
    // Embedded CascadiaMono (woff2) guarantees consistent box-drawing glyphs on
    // every platform — no more border misalignment from font-fallback jitter.
    // Platform-native fonts remain as fallbacks if the embedded font fails to load.
    //
    // Nerd Font names are inserted right after CascadiaMono so per-character
    // font fallback covers the Unicode private-use-area glyphs (powerline
    // separators, git/branch icons, etc.) that oh-my-posh / starship / p10k
    // emit and that CascadiaMono lacks. Users who haven't installed a Nerd
    // Font see no change (these names just don't resolve); users who have
    // installed one — which oh-my-posh's setup explicitly tells them to do —
    // automatically get the missing glyphs without us bundling a 5 MB font.
    const NERD_FONTS = "'CaskaydiaCove Nerd Font', 'JetBrainsMono Nerd Font', 'MesloLGS NF', 'FiraCode Nerd Font', 'Hack Nerd Font'";
    const fontFamily = isLinux
      ? `CascadiaMono, ${NERD_FONTS}, 'Ubuntu Mono', 'Noto Sans Mono', 'DejaVu Sans Mono', 'Liberation Mono', monospace`
      : isMac
        ? `CascadiaMono, ${NERD_FONTS}, ui-monospace, Menlo, Monaco, 'Courier New', monospace`
        : `CascadiaMono, ${NERD_FONTS}, 'Cascadia Mono', Consolas, 'Courier New', monospace`;
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
      // that's a constant power draw users feel as warmth. Off by default —
      // also redundant since the cursor itself is invisible (theme.cursor =
      // bg color), but kept for renderer paths that ignore the color trick.
      cursorBlink: false,
      scrollback: 5000,
      theme: buildXtermTheme(theme, hasBg, termColorScheme),
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
    let useWebgl = false;
    try {
      const testCanvas = document.createElement('canvas');
      const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
      if (gl) {
        const debugExt = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
        if (debugExt) {
          const renderer = (gl as WebGLRenderingContext).getParameter(debugExt.UNMASKED_RENDERER_WEBGL) as string;
          const isSoftware = /llvmpipe|softpipe|swrast|swiftshader|software|microsoft basic render|mesa offscreen/i.test(renderer);
          useWebgl = !isSoftware;
          console.log(`[TierTerminal] GPU: ${renderer} → ${useWebgl ? 'WebGL' : 'DOM'} (software=${isSoftware})`);
        } else {
          // No debug extension — assume the GPU is real. Modern browsers
          // hide UNMASKED_RENDERER_WEBGL behind a privacy flag in some
          // contexts; defaulting to DOM here was the old behavior and
          // caused the same per-window CPU spike on locked-down builds.
          useWebgl = true;
          console.log('[TierTerminal] GPU info hidden → WebGL (assuming hardware acceleration)');
        }
      } else {
        console.log('[TierTerminal] WebGL unavailable → DOM renderer');
      }
    } catch {
      console.warn('[TierTerminal] WebGL probe failed → DOM renderer');
    }

    // Always use WebGL renderer when possible — DOM renderer does NOT support
    // customGlyphs or rescaleOverlappingGlyphs, causing ASCII art (Claude mascot,
    // box borders) to misalign. WebGL supports allowTransparency for wallpapers.
    if (useWebgl) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => { webgl.dispose(); });
        term.loadAddon(webgl);
      } catch (err) {
        console.error('[TierTerminal] WebGL instantiation failed, falling back to DOM renderer', err);
      }
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
    term.onData((data) => {
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
    });

    // Handle native Copy/Paste shortcuts
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown') {
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
          clipboardRead().then(text => {
            if (text) term.paste(normalizePasteNewlines(text));
          });
          return false;
        }

        // Linux convention: Ctrl+Shift+C always copies, Ctrl+Shift+V always pastes
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
          if (term.hasSelection()) clipboardWrite(term.getSelection());
          return false;
        }
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
          e.preventDefault();
          clipboardRead().then(text => {
            if (text) term.paste(normalizePasteNewlines(text));
          });
          return false;
        }
      }
      return true; // Let xterm handle all other keys natively
    });

    // Clickable links: URLs (http/https/file) + absolute file paths.
    // Underlines matched tokens on hover; click opens via Tauri's open_url
    // command (delegates to the OS shell — system browser for URLs, default
    // handler for local files like report.html).
    // URLs are ASCII per RFC 3986; the -￿ guard stops the match at
    // any non-ASCII char so trailing CJK punctuation/text (e.g. "https://x，看到…")
    // doesn't get swallowed into the link. File paths keep the looser set so
    // Windows paths with Chinese folder names still match.
    const LINK_RE = /(https?:\/\/[^\s<>()"'-￿]+|file:\/\/\/[^\s<>()"'-￿]+|[A-Za-z]:[/\\][^\s<>()"']+)/g;
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
              const url = /^[A-Za-z]:[/\\]/.test(raw)
                ? 'file:///' + raw.replace(/\\/g, '/')
                : raw;
              commands.openUrl(url).catch(() => {});
            },
          });
        }
        callback(links);
      },
    });

    xtermRef.current = term;
    fitRef.current   = fit;

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
          hasOutputRef.current = true;
          xtermRef.current?.write(data);

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
        onStatus: (running, exitCode) => {
          if (!mounted || running) return;
          setProcessExited(true);
          dispatch({ type: 'SET_AGENT_STATUS', id: sessionId, status: 'idle' });
          if (exitMessageWrittenRef.current) return;
          exitMessageWrittenRef.current = true;
          const msg = exitCode === 0
            ? '\r\n\x1b[32m[Process exited normally]\x1b[0m\r\n'
            : `\r\n\x1b[31m[Process exited with code ${exitCode}]\x1b[0m\r\n`;
          xtermRef.current?.write(msg);
        },
        onExit: (exitCode) => {
          // Authoritative "process is actually dead" signal from the Rust
          // child-watcher thread. Critical for the lockup scenario where an
          // intermediate cmd.exe keeps the PTY slave open so reader never
          // sees EOF — without this, the terminal looked frozen forever.
          if (!mounted) return;
          setProcessExited(true);
          dispatch({ type: 'SET_AGENT_STATUS', id: sessionId, status: 'idle' });
          if (exitMessageWrittenRef.current) return;
          exitMessageWrittenRef.current = true;
          const msg = exitCode === 0
            ? '\r\n\x1b[32m[Process exited normally]\x1b[0m\r\n'
            : `\r\n\x1b[31m[Process exited with code ${exitCode}]\x1b[0m\r\n`;
          xtermRef.current?.write(msg);
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

        // VibeID routes through the backend's own `'vibeid'` match arm, which
        // spawns `claude` with `/vibeid` as the initial positional prompt.
        // No frontend remap + no PTY-write hack: Claude Code's REPL parses the
        // slash command natively on first input.
        await commands.tierTerminalStart(sessionId, tool, initialCols, initialRows, theme, lang, toolData, folderPath ?? undefined, sentinelEnabled);

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

// (VibeID no longer needs a frontend auto-prompt timer — the backend
        // spawns `claude /vibeid` directly, so the REPL fires the skill on its
        // very first parse pass.)
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
      xtermRef.current = null;
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
    term.options.theme = buildXtermTheme(theme, hasBg, termColorScheme);
  }, [theme, termColorScheme, hasBg]);

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
  useEffect(() => {
    if (!isActive) return;
    let f1 = 0, f2 = 0;
    f1 = requestAnimationFrame(() => {
      f2 = requestAnimationFrame(() => {
        fitRef.current?.fit();
        xtermRef.current?.focus();
        const term = xtermRef.current;
        if (!term || term.cols <= 0 || term.rows <= 0) return;
        const prev = lastResizeRef.current;
        if (prev && prev.cols === term.cols && prev.rows === term.rows) return;
        lastResizeRef.current = { cols: term.cols, rows: term.rows };
        commands.tierTerminalResize(sessionId, term.cols, term.rows).catch(() => {});
      });
    });
    return () => { cancelAnimationFrame(f1); cancelAnimationFrame(f2); };
  }, [isActive, sessionId]);

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
      // of entering alt-screen. Threshold 1500 ms post-splash-start; once
      // we've passed the 800 ms branding window AND output is flowing AND
      // the process is alive, the tool is clearly running. Tighter than
      // the prior 2500 ms because tools usually finish painting their
      // banner well within 1 s — anything slower would make the splash
      // feel "stuck" over a visibly working REPL.
      if (hasOutputRef.current && elapsed > 1500) {
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
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ x: e.clientX, y: e.clientY, hasSelection: !!xtermRef.current?.hasSelection() });
        }}
      >
        <div ref={termRef} className="tier-xterm" />
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
          onPaste={() => {
            clipboardRead().then(text => {
              if (text && xtermRef.current) xtermRef.current.paste(normalizePasteNewlines(text));
            });
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
                tool === 'insights_prerun' ? `${t('tool.vibeid' as any)} (1/2)` :
                tool === 'vibeid'          ? `${t('tool.vibeid' as any)} (2/2)` :
                (toolName || (tool && toolLabel[tool]) || 'Loading');
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

// Temporarily exported without memo wrapper while investigating a
// regression where CLI tools wouldn't launch. All other perf wins (split
// contexts, useAppDispatch, focus registry, pty-event-bus, tab-switch rAF,
// dead menu scanner removal) are still active.
export const TierTerminal = TierTerminalImpl;
