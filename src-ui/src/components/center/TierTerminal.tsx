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
import { subscribeTerminalEvents } from '../../lib/pty-event-bus';
import { registerTerminalFocus } from '../../lib/focus-registry';
import { registerTabActions } from '../../lib/tab-actions';
import { notifyUserInputSubmitted } from '../../lib/agent-status-bus';
import { commands } from '../../tauri';
import { useAppDispatch, type ToolType, type ThemeColor } from '../../store/app-state';
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

function buildXtermTheme(isDark: boolean, hasBg: boolean | undefined, hideCursor: boolean, schemeId?: string) {
  const scheme = schemeId ? TERM_COLOR_SCHEMES.find(s => s.id === schemeId) : undefined;
  const bg  = hasBg ? 'rgba(0,0,0,0)' : (isDark ? '#0c0c0c' : '#f4f3ee');
  const bgOpaque = isDark ? '#0c0c0c' : '#f4f3ee';

  // Build the default warm palette first (full 16 ANSI colors), then let
  // the scheme — if any — re-tint only the foreground and cursor.
  const defaultFg = isDark ? '#e8e4de' : '#2d2c2a';
  const fg = scheme?.fg ?? defaultFg;

  const base = isDark ? {
    selectionBackground: 'rgba(196,149,106,0.3)',
    black: '#0c0c0c', red: '#e07070', green: '#7ec77e', yellow: '#d4a846',
    blue: '#78a8d4', magenta: '#b07cc6', cyan: '#5fc4c0', white: '#e8e4de',
    brightBlack: '#6b6762',
  } : {
    selectionBackground: 'rgba(196,149,106,0.25)',
    black: '#2d2c2a', red: '#cc3333', green: '#2d7a2d', yellow: '#8a6000',
    blue: '#2952a3', magenta: '#7a3d8a', cyan: '#1a6b6b', white: '#f4f3ee',
    brightBlack: '#9e9c98',
  };

  return {
    ...base,
    background: bg,
    foreground: fg,
    cursor: hideCursor ? bgOpaque : fg,
    cursorAccent: bgOpaque,
  };
}

// Installer scripts live in Web-Home/ and are served directly from coffeecli.com.
// Falls back to GitHub raw if the website is unreachable.
const INSTALLER_URLS: Record<string, string[]> = {
  'agent-tools-installer.ps1': [
    'https://coffeecli.com/agent-tools-installer.ps1',
    'https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/scripts/agent-tools-installer.ps1',
  ],
  'agent-tools-installer.sh': [
    'https://coffeecli.com/agent-tools-installer.sh',
    'https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/scripts/agent-tools-installer.sh',
  ],
};

async function fetchInstallerScript(filename: string): Promise<string> {
  const urls = INSTALLER_URLS[filename] ?? [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) return await res.text();
    } catch { /* try next */ }
  }
  throw new Error(`Failed to fetch installer script: ${filename}`);
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
  theme: ThemeColor;
  lang: string;
  isActive: boolean;
  toolData?: string;
  folderPath?: string | null;
  hasBg?: boolean;
  bgUrl?: string;
  bgType?: 'image' | 'video' | 'none';
  termColorScheme?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

function TierTerminalImpl({
  sessionId, tool, theme, lang, isActive, toolData, folderPath, hasBg, bgUrl, bgType, termColorScheme,
}: TierTerminalProps) {
  // Dispatch-only subscription. Never re-renders this component.
  const dispatch = useAppDispatch();

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

  // ── Terminal context menu ────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const t = useT();

  const toolLabel: Record<string, string> = {
    claude: 'Claude Code',
    qwen: 'Qwen Code', installer: 'Coffee Installer', hermes: 'Hermes', opencode: 'OpenCode',
    remote: t('tool.remote'), terminal: t('tool.terminal'),
  };

  // ── xterm.js init ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!termRef.current || xtermRef.current) return;

    let mounted = true;
    const unlisteners: (() => void)[] = [];

    const isDark = theme !== 'light';
    const isLinux = navigator.userAgent.toLowerCase().includes('linux');
    const isMac = navigator.userAgent.toLowerCase().includes('mac');
    // Embedded CascadiaMono (woff2) guarantees consistent box-drawing glyphs on
    // every platform — no more border misalignment from font-fallback jitter.
    // Platform-native fonts remain as fallbacks if the embedded font fails to load.
    const fontFamily = isLinux
      ? "CascadiaMono, 'Ubuntu Mono', 'Noto Sans Mono', 'DejaVu Sans Mono', 'Liberation Mono', monospace"
      : isMac
        ? "CascadiaMono, ui-monospace, Menlo, Monaco, 'Courier New', monospace"
        : "CascadiaMono, 'Cascadia Mono', Consolas, 'Courier New', monospace";
    const term = new Terminal({
      fontFamily,
      fontSize: 14,
      lineHeight: 1.3,
      letterSpacing: 0,
      fontWeight: '400',
      fontWeightBold: '400', // Prevent bold glyphs from using wider metrics
      allowTransparency: true, // Required for rgba background (custom wallpaper behind terminal)
      customGlyphs: true, // Pixel-perfect box-drawing on all platforms (canvas-drawn, font-independent)
      rescaleOverlappingGlyphs: true, // Force ambiguous-width chars (block chars ▀▄█) to single cell width
      cursorStyle: 'bar' as const,
      // Claude Code manages its own cursor via ANSI sequences; hide xterm's native
      // cursor so it doesn't appear at Claude's internal cursor position.
      // Other tools (codex) use xterm's cursor at the normal prompt.
      cursorBlink: tool !== 'claude',
      scrollback: 5000,
      theme: buildXtermTheme(isDark, hasBg, tool === 'claude', termColorScheme),
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
    // border alignment). DOM renderer silently drops those options.
    //
    // The trap: on headless or VM Linux the WebGL context falls back to
    // a software rasterizer (llvmpipe, swrast, SwiftShader) that burns
    // CPU. Detect software renderers explicitly and force DOM there —
    // misaligned mascot is a lesser evil than a hot fan.
    //
    // Win/Mac keep the dedicated-GPU gate for compatibility with prior
    // heat/throttling reports on integrated GPUs on those platforms.
    let useWebgl = false;
    try {
      const testCanvas = document.createElement('canvas');
      const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
      if (gl) {
        const debugExt = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
        if (debugExt) {
          const renderer = (gl as WebGLRenderingContext).getParameter(debugExt.UNMASKED_RENDERER_WEBGL) as string;
          const isSoftware = /llvmpipe|softpipe|swrast|swiftshader|software|microsoft basic render|mesa offscreen/i.test(renderer);
          const isDedicated = /nvidia|geforce|radeon|amd|rx\s?\d|arc\s?a/i.test(renderer);
          useWebgl = !isSoftware && (isLinux || isDedicated);
          console.log(`[TierTerminal] GPU: ${renderer} → ${useWebgl ? 'WebGL' : 'DOM'} (software=${isSoftware}, dedicated=${isDedicated})`);
        } else {
          console.log('[TierTerminal] GPU info unavailable → DOM renderer (cannot verify hardware acceleration)');
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

    // Forward keyboard input to Rust PTY backend
    term.onData((data) => {
      commands.tierTerminalInput(sessionId, data).catch(() => {});
      // Optimistic status update — Dynamic Island style. A newline means
      // the user just submitted; turn the dot to "executing" immediately
      // so the UI reacts before any hook event arrives. Scoped to Claude
      // only — the other CLIs have a steady "executing" pulse and don't
      // consume agentStatus, so emitting for them is wasted dispatch.
      if ((data.includes('\r') || data.includes('\n')) && tool === 'claude') {
        notifyUserInputSubmitted(sessionId, tool);
      }
    });

    // Handle native Copy/Paste shortcuts
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown') {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

        // Copy: Ctrl+C / Cmd+C — only when text is selected (otherwise send SIGINT)
        if (cmdOrCtrl && e.code === 'KeyC') {
          if (term.hasSelection()) {
            navigator.clipboard.writeText(term.getSelection());
            return false;
          }
        }

        // Paste: Ctrl+V / Cmd+V
        if (cmdOrCtrl && e.code === 'KeyV') {
          navigator.clipboard.readText().then(text => {
            if (text) term.paste(text);
          }).catch(() => {});
          return false;
        }

        // Linux convention: Ctrl+Shift+C always copies, Ctrl+Shift+V always pastes
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
          if (term.hasSelection()) navigator.clipboard.writeText(term.getSelection());
          return false;
        }
        if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
          navigator.clipboard.readText().then(text => {
            if (text) term.paste(text);
          }).catch(() => {});
          return false;
        }
      }
      return true; // Let xterm handle all other keys natively
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
        },
        onStatus: (running, exitCode) => {
          if (!mounted || running) return;
          setProcessExited(true);
          dispatch({ type: 'SET_AGENT_STATUS', id: sessionId, status: 'idle' });
          const msg = exitCode === 0
            ? '\r\n\x1b[32m[Process exited normally]\x1b[0m\r\n'
            : `\r\n\x1b[31m[Process exited with code ${exitCode}]\x1b[0m\r\n`;
          xtermRef.current?.write(msg);
        },
        onCwd: async (cwd) => {
          if (!mounted) return;
          dispatch({ type: 'SET_FOLDER', path: cwd });
          try {
            const data = await commands.scanFolder(cwd);
            if (mounted) dispatch({ type: 'SET_SCAN', data });
          } catch (e) {
            console.warn('[Terminal] CWD scan failed:', e);
          }
        },
      });
      if (mounted) unlisteners.push(unsubEvents); else { unsubEvents(); return; }

      // All listeners registered — NOW start the PTY process
      if (!mounted) return;

      const initialCols = term.cols || 80;
      const initialRows = term.rows || 24;

        await commands.tierTerminalStart(sessionId, tool, initialCols, initialRows, theme, lang, toolData, folderPath ?? undefined);

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

        // For installer, write the script to a temp file via a Rust command
        // and execute it by path. We used to base64-encode the script inline
        // via `powershell -EncodedCommand`, but that runs into Windows CMD's
        // 8191-char command line limit for any non-trivial script — the
        // command gets echoed instead of run.
        if (tool === 'installer') {
          setTimeout(async () => {
            try {
              const isWin = window.navigator.userAgent.toLowerCase().includes('windows');
              if (isWin) {
                const script = await fetchInstallerScript('agent-tools-installer.ps1');
                const tempPath = await commands.writeTempScript(script, 'ps1');
                const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${tempPath}"\r`;
                commands.tierTerminalRawWrite(sessionId, cmd).catch(() => {});
              } else {
                const script = await fetchInstallerScript('agent-tools-installer.sh');
                const tempPath = await commands.writeTempScript(script, 'sh');
                const cmd = `bash "${tempPath}"\r`;
                commands.tierTerminalRawWrite(sessionId, cmd).catch(() => {});
              }
            } catch (err) {
              console.error("Failed to launch standalone installer script", err);
              commands.tierTerminalRawWrite(sessionId, `Write-Host "Failed to launch installer script: ${err}" -ForegroundColor Red\r`).catch(() => {});
            }
          }, 1000);
        }
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
    term.options.theme = buildXtermTheme(theme !== 'light', hasBg, tool === 'claude', termColorScheme);
  }, [theme, tool, termColorScheme, hasBg]);

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
      paste: (text: string) => {
        const term = xtermRef.current;
        if (!term) return;
        // term.paste() goes through onData, which our handler forwards to the
        // PTY with bracketed-paste framing when the TUI has enabled it.
        // Newlines and IME composition round-trip correctly. Follow with CR
        // to submit.
        term.paste(text);
        commands.tierTerminalInput(sessionId, '\r').catch(() => {});
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
      setTimeout(() => setShowSplash(false), 600);
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
      // Fallback timeout: shell + installer are fast (3s), AI CLI tools may
      // take longer (15s) before the first meaningful frame.
      const maxWait = (tool === 'terminal' || tool === 'installer') ? 3000 : 15000;
      if (elapsed > maxWait) {
        dismiss();
        clearInterval(poll);
      }
    }, 150);
    return () => clearInterval(poll);
  }, [showSplash, processExited, startFailed]);

  // ── Render ───────────────────────────────────────────────────────────────

  const solidBg = theme === 'light' ? '#f4f3ee' : '#0c0c0c';
  const terminalBg = hasBg ? 'transparent' : solidBg;

  // Show fallback UI when splash is gone but terminal has no content
  const showFallback = !showSplash && !hasOutputRef.current && (processExited || startFailed);

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
            if (text) navigator.clipboard.writeText(text).catch(() => {});
            closeCtxMenu();
          }}
          onPaste={() => {
            navigator.clipboard.readText().then(text => {
              if (text && xtermRef.current) xtermRef.current.paste(text);
            }).catch(() => {});
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

      {/* Fallback UI when tool fails to launch or exits before producing output */}
      {showFallback && (
        <div className="tier-launch-failed" style={{ background: solidBg }}>
          <div className="launch-failed-group">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent, #C4956A)', opacity: 0.7 }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="launch-failed-title">
              {(tool && toolLabel[tool]) || 'Tool'}
            </span>
            <span className="launch-failed-hint">
              {startFailed
                ? t('launch.error.ipc_failed' as any) || 'Could not connect to backend'
                : t('launch.error.tool_exited' as any) || 'Process exited unexpectedly'}
            </span>
            <span className="launch-failed-sub">
              {t('launch.error.check_install' as any) || 'Make sure the tool is installed and available in your PATH'}
            </span>
          </div>
        </div>
      )}

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
                      <animate attributeName="d" dur="3s" repeatCount="indefinite"
                        values="M8 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4;M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4"/>
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
            <span className="splash-label">{(tool && toolLabel[tool]) || 'Loading'}</span>
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
