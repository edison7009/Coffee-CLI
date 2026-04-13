// TierTerminal.tsx — xterm.js terminal renderer with PTY backend
// Pure terminal: no translation, no overlay. Translation lives in language packs
// installed separately via the one-click installer.

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { subscribeTerminalEvents } from '../../lib/pty-event-bus';
import { commands } from '../../tauri';
import { useAppState, type ToolType } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import '@xterm/xterm/css/xterm.css';
import './TierTerminal.css';

// Import standalone scripts at build time to avoid runtime path/permission issues
import ps1Script from '../../../../scripts/agent-tools-installer.ps1?raw';
import shScript from '../../../../scripts/agent-tools-installer.sh?raw';

// Sessions being detached to a new window — skip kill on unmount
export const detachedSessions = new Set<string>();

// ─── Component ───────────────────────────────────────────────────────────────

export function TierTerminal({ sessionId, tool }: { sessionId: string; tool: ToolType }) {
  const { state, dispatch } = useAppState();

  const termRef  = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef   = useRef<FitAddon | null>(null);

  // ── Startup splash state ─────────────────────────────────────────────────
  const [showSplash, setShowSplash] = useState(true);
  const [splashFading, setSplashFading] = useState(false);
  const splashStartRef = useRef(Date.now());
  const altScreenRef = useRef(false); // True when TUI enters alternate screen buffer

  const t = useT();

  const toolLabel: Record<string, string> = {
    claude: 'Claude Code',
    codex: 'Codex CLI', installer: 'Coffee Installer', hermes: 'Hermes', opencode: 'OpenCode',
    remote: t('tool.remote'), terminal: t('tool.terminal'),
  };

  // ── xterm.js init ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!termRef.current || xtermRef.current) return;

    let mounted = true;
    const unlisteners: (() => void)[] = [];

    const isDark = state.currentTheme === 'dark';
    const isLinux = navigator.userAgent.toLowerCase().includes('linux');
    const term = new Terminal({
      fontFamily: "'Cascadia Mono', 'Cascadia Code', 'SF Mono', Menlo, Monaco, Consolas, 'Ubuntu Mono', 'Noto Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', monospace",
      fontSize: 14,
      lineHeight: 1.3,
      letterSpacing: isLinux ? -0.5 : 0,
      fontWeight: '400',
      customGlyphs: true,
      cursorStyle: 'bar' as const,
      // Claude Code manages its own cursor via ANSI sequences; hide xterm's native
      // cursor so it doesn't appear at Claude's internal cursor position.
      // Other tools (codex) use xterm's cursor at the normal prompt.
      cursorBlink: tool !== 'claude',
      scrollback: 5000,
      theme: isDark ? {
        background:  '#0c0c0c',
        foreground:  '#e8e4de',
        cursor:      tool === 'claude' ? '#0c0c0c' : '#e8e4de',
        cursorAccent: '#0c0c0c',
        selectionBackground: 'rgba(196,149,106,0.3)',
        black:       '#0c0c0c',
        red:         '#e07070',
        green:       '#7ec77e',
        yellow:      '#d4a846',
        blue:        '#78a8d4',
        magenta:     '#b07cc6',
        cyan:        '#5fc4c0',
        white:       '#e8e4de',
        brightBlack: '#6b6762',
      } : {
        background:  '#f4f3ee',
        foreground:  '#2d2c2a',
        cursor:      tool === 'claude' ? '#f4f3ee' : '#2d2c2a',
        cursorAccent: '#f4f3ee',
        selectionBackground: 'rgba(196,149,106,0.25)',
        black:       '#2d2c2a',
        red:         '#cc3333',
        green:       '#2d7a2d',
        yellow:      '#8a6000',
        blue:        '#2952a3',
        magenta:     '#7a3d8a',
        cyan:        '#1a6b6b',
        white:       '#f4f3ee',
        brightBlack: '#9e9c98',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);

    // GPU-accelerated rendering: only enable WebGL if a dedicated GPU is detected OR if on Linux.
    // On Windows/Mac integrated GPUs, WebGL can cause heat, but on Linux DOM renderer has severe font spacing bugs.
    let useWebgl = false;
    try {
      if (isLinux) {
        useWebgl = true;
      } else {
        const testCanvas = document.createElement('canvas');
        const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
        if (gl) {
          const debugExt = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
          if (debugExt) {
            const renderer = (gl as WebGLRenderingContext).getParameter(debugExt.UNMASKED_RENDERER_WEBGL) as string;
            // Dedicated GPU keywords: NVIDIA, AMD, Radeon, GeForce, Arc, etc.
            useWebgl = /nvidia|geforce|radeon|amd|rx\s?\d|arc\s?a/i.test(renderer);
            console.log(`[TierTerminal] GPU: ${renderer} → ${useWebgl ? 'WebGL' : 'DOM'}`);
          }
        }
      }
    } catch {
      console.warn('[TierTerminal] WebGL probe failed');
    }

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
    });

    // Handle native Copy/Paste shortcuts
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown') {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

        // Copy: Ctrl+C / Cmd+C
        if (cmdOrCtrl && e.code === 'KeyC') {
          if (term.hasSelection()) {
            navigator.clipboard.writeText(term.getSelection());
            return false; // Stop xterm from handling it (prevents SIGINT)
          }
        }


      }
      return true; // Let xterm handle all other keys natively
    });

    xtermRef.current = term;
    fitRef.current   = fit;

    // Auto-focus so keyboard input works immediately
    term.focus();

    // ─── Unified Global Focus Enforcer ───────────────────────────────────────
    // CRITICAL: Only steal focus if THIS session is the currently active terminal.
    // Without this check, all background TierTerminal instances fight over focus,
    // causing the "tab switching makes terminal go blank" bug.
    const enforceFocus = () => {
      if (!mounted) return;
      // Check if this session is the active one via data attribute on the container
      const wrapper = termRef.current?.closest('[data-session-id]');
      const isVisible = wrapper ? (wrapper as HTMLElement).style.display !== 'none' : false;
      if (!isVisible) return; // Don't steal focus if this terminal is hidden
      setTimeout(() => {
        // Re-evaluate visibility here because React might have hidden this session
        // between the mouseup event and this timeout executing (e.g. dragging or switching tabs)
        const stillVisible = wrapper ? (wrapper as HTMLElement).style.display !== 'none' : false;
        if (!stillVisible) return;

        const active = document.activeElement;
        // If the officially focused element is a REAL text input/textarea (like the chat box), let them type.
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && !active.classList.contains('xterm-helper-textarea')) {
          return;
        }
        // Otherwise, steal focus back for the terminal!
        term.focus();
      }, 10); // Small delay to let browser settle the focus shift first
    };

    // Whenever focus shifts anywhere in the app, evaluate if we need to steal it back
    window.addEventListener('focusin', enforceFocus);
    // Also listen to mouseup in case focus lands on document.body (which doesn't natively trigger focusin)
    window.addEventListener('mouseup', enforceFocus);

    // ── Register event listeners BEFORE starting PTY ──────────────────────
    // This prevents the race condition where PTY output arrives before
    // the frontend has registered its listeners, causing a blank terminal.

    const startPty = async () => {
      const session = state.terminals.find(s => s.id === sessionId);
      const toolData = session?.toolData;
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

          // Detect alternate screen buffer entry — the universal TUI "ready" signal
          if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
            altScreenRef.current = true;
          }
        },
        onStatus: (running, exitCode) => {
          if (!mounted || running) return;
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

      try {
        await commands.tierTerminalStart(sessionId, tool, initialCols, initialRows, state.currentTheme, state.currentLang, toolData, session?.folderPath ?? undefined);

        // Trust prompt is now shown to the user (with translation overlay).
        // Previously auto-skipped, but user wants to see the translated trust screen.

        // For installer, auto-type the cross-platform native install commands
        if (tool === 'installer') {
          setTimeout(() => {
            try {
              const os = window.navigator.userAgent.toLowerCase().includes('windows') ? 'win' : 'other';
              let installCmd = '';

              if (os === 'win') {
                // PowerShell -EncodedCommand requires UTF-16LE base64 encoding
                let binary = '';
                for (let i = 0; i < ps1Script.length; i++) {
                    const charCode = ps1Script.charCodeAt(i);
                    binary += String.fromCharCode(charCode & 0xFF, (charCode >> 8) & 0xFF);
                }
                const b64 = btoa(binary);
                installCmd = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${b64}\r`;
              } else {
                const b64 = btoa(unescape(encodeURIComponent(shScript)));
                installCmd = `echo "${b64}" | base64 -d | bash\r`;
              }
              
              commands.tierTerminalRawWrite(sessionId, installCmd).catch(() => {});
            } catch (err) {
              console.error("Failed to launch standalone installer script", err);
              commands.tierTerminalRawWrite(sessionId, `Write-Host "Failed to launch installer script: ${err}" -ForegroundColor Red\r`).catch(() => {});
            }
          }, 1000);
        }
      } catch (err) {
        term.writeln(`\x1b[31mFailed to start terminal: ${err}\x1b[0m`);
      }
    };

    startPty();



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
      window.removeEventListener('focusin', enforceFocus);
      window.removeEventListener('mouseup', enforceFocus);
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
    const isDark = state.currentTheme === 'dark';
    // Claude Code manages its own cursor — keep xterm cursor invisible
    const hideCursor = tool === 'claude';
    term.options.theme = isDark ? {
      background: '#0c0c0c', foreground: '#e8e4de',
      cursor: hideCursor ? '#0c0c0c' : '#e8e4de', cursorAccent: '#0c0c0c'
    } : {
      background: '#f4f3ee', foreground: '#2d2c2a',
      cursor: hideCursor ? '#f4f3ee' : '#2d2c2a', cursorAccent: '#f4f3ee'
    };
  }, [state.currentTheme]);

  // ── Active tab focus restoration ─────────────────────────────────────────
  // Cache last-sent size so we skip redundant PTY resize calls when tab
  // switches back to the same dimensions (no window resize in between).
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);

  // When this session becomes the active tab, refit + focus after layout.
  // Uses double-rAF instead of a 150ms setTimeout so perceived switch latency
  // drops from 150ms to ~32ms (two frames). Fit is fast; the only reason to
  // wait was to let React+browser flush display:none -> flex layout.
  useEffect(() => {
    const isActive = state.activeTerminalId === sessionId;
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
  }, [state.activeTerminalId, sessionId]);

  // ── Startup splash dismissal ────────────────────────────────────────────
  // Detect real TUI via alternate screen buffer entry (\x1b[?1049h).
  // This precisely distinguishes "database migration text" from "actual TUI rendered".
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
  }, [showSplash]);

  // ── Render ───────────────────────────────────────────────────────────────

  const isDark = state.currentTheme === 'dark';
  const terminalBg = isDark ? '#0c0c0c' : '#f4f3ee';

  return (
    <div className="tier-terminal" style={{ background: terminalBg, position: 'relative' }}>
      {/* xterm.js: handles all rendering, input, and scrolling. */}
      <div className="tier-xterm-wrap">
        <div ref={termRef} className="tier-xterm" />
      </div>

      {/* Startup splash — covers ugly init output with branded loading screen */}
      {showSplash && (
        <div
          className={`tier-loading-splash ${splashFading ? 'fade-out' : ''}`}
          style={{ background: terminalBg }}
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
