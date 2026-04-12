// TierTerminal.tsx — Dual-layer terminal renderer
// Layer 1: xterm.js (ANSI parsing + keyboard + WebGL GPU rendering)
// Layer 2: Coffee Overlay (Canvas 2D, auto-enabled with smart fallback)

import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { CoffeeOverlay, type CoffeeOverlayRef } from './CoffeeOverlay';
import { setTranslationEntries, setLLMTranslationEntries } from './coffee-translation';
import {
  loadLLMConfig, saveLLMConfig, extractTextSegments, translateSegments,
  TRANSLATE_LANGUAGES,
} from './llm-translate';
import { TranslateSettings } from './TranslateSettings';
import { listen } from '@tauri-apps/api/event';
import { commands } from '../../tauri';
import { useAppState, type ToolType } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import '@xterm/xterm/css/xterm.css';
import './TierTerminal.css';

// Import standalone scripts at build time to avoid runtime path/permission issues
import ps1Script from '../../../../scripts/agent-tools-installer.ps1?raw';
import shScript from '../../../../scripts/agent-tools-installer.sh?raw';

// ─── Event Payloads ──────────────────────────────────────────────────────────
interface TerminalOutputEvent {
  id: string;
  data: string;
}

interface TerminalStatusEvent {
  id: string;
  running: boolean;
  exit_code: number | null;
}

interface CwdEvent {
  id: string;
  cwd: string;
}

// Sessions being detached to a new window — skip kill on unmount
export const detachedSessions = new Set<string>();

// ─── Component ───────────────────────────────────────────────────────────────

export function TierTerminal({ sessionId, tool }: { sessionId: string; tool: ToolType }) {
  const { state, dispatch } = useAppState();

  const termRef  = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef   = useRef<FitAddon | null>(null);
  const coffeeRef = useRef<CoffeeOverlayRef>(null);


  // ── Startup splash state ─────────────────────────────────────────────────
  const [showSplash, setShowSplash] = useState(true);
  const [splashFading, setSplashFading] = useState(false);
  const splashStartRef = useRef(Date.now());
  const altScreenRef = useRef(false); // True when TUI enters alternate screen buffer
  const tuiReadyRef = useRef(false); // True when TUI shows an interactive menu or prompt

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
    const term = new Terminal({
      fontFamily: "'Cascadia Mono', 'Cascadia Code', 'SF Mono', Menlo, Monaco, Consolas, 'Ubuntu Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', monospace",
      fontSize: 14,
      lineHeight: 1.3,
      letterSpacing: 0,
      fontWeight: '400',
      customGlyphs: true,
      cursorStyle: 'bar' as const,
      // Claude Code manages its own cursor via ANSI sequences; hide xterm's native
      // cursor so it doesn't appear at Claude's internal cursor position.
      // Other tools (codex) use xterm's cursor at the normal prompt.
      cursorBlink: tool !== 'claude',
      scrollback: 5000,
      theme: isDark ? {
        background:  '#1a1917',
        foreground:  '#e8e4de',
        cursor:      tool === 'claude' ? '#1a1917' : '#e8e4de',
        cursorAccent: '#1a1917',
        selectionBackground: 'rgba(196,149,106,0.3)',
        black:       '#1a1917',
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
    // On Windows/Mac integrated GPUs, WebGL can cause heat, but on Linux DOM renderer has sever font spacing bugs.
    let useWebgl = false;
    try {
      const isLinux = navigator.userAgent.toLowerCase().includes('linux');
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

        // Copy: Ctrl+C / Cmd+C (check CoffeeOverlay first, then fallback to xterm)
        if (cmdOrCtrl && e.code === 'KeyC') {
          if (coffeeRef.current?.hasSelection()) {
            coffeeRef.current.copySelection();
            return false;
          }
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

      // Register all listeners first and wait for them to be ready
      const outputUn = await listen<TerminalOutputEvent>('tier-terminal-output', (event) => {
        if (!mounted || event.payload.id !== sessionId) return;
        xtermRef.current?.write(event.payload.data);
        
        // Handle SSH Auto-login via Password injection
        if (tool === 'remote' && remoteConfig.protocol === 'ssh' && remoteConfig.password && !hasInjectedPassword) {
          if (event.payload.data.toLowerCase().includes('password:')) {
            hasInjectedPassword = true;
            // Delay slightly to ensure PTY is ready to accept input after flushing prompt
            setTimeout(() => {
              commands.tierTerminalRawWrite(sessionId, remoteConfig.password + '\r').catch(() => {});
            }, 200);
          }
        }

        // Detect alternate screen buffer entry — the universal TUI "ready" signal
        if (event.payload.data.includes('\x1b[?1049h') || event.payload.data.includes('\x1b[?47h')) {
          altScreenRef.current = true;
        }
      });
      if (mounted) unlisteners.push(outputUn); else { outputUn(); return; }

      const statusUn = await listen<TerminalStatusEvent>('tier-terminal-status', (event) => {
        if (!mounted || event.payload.id !== sessionId) return;
        if (!event.payload.running) {
          const code = event.payload.exit_code;
          const msg = code === 0
            ? '\r\n\x1b[32m[Process exited normally]\x1b[0m\r\n'
            : `\r\n\x1b[31m[Process exited with code ${code}]\x1b[0m\r\n`;
          xtermRef.current?.write(msg);
        }
      });
      if (mounted) unlisteners.push(statusUn); else { statusUn(); return; }

      const cwdUn = await listen<CwdEvent>('tier-terminal-cwd', async (event) => {
        if (!mounted || event.payload.id !== sessionId) return;
        const newPath = event.payload.cwd;
        dispatch({ type: 'SET_FOLDER', path: newPath });
        try {
          const data = await commands.scanFolder(newPath);
          if (mounted) dispatch({ type: 'SET_SCAN', data });
        } catch (e) {
          console.warn('[Terminal] CWD scan failed:', e);
        }
      });
      if (mounted) unlisteners.push(cwdUn); else { cwdUn(); return; }

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

    // ─── Dynamic Prompt Extractor Loop ───────────────────────────────────────
    // Continuously scan the bottom viewport for interactive CLI menu formats
    // (e.g. Inquirer.js output like "❯ 1. Yes \n  2. No")
    let lastMenuStr = '';
    let lastHasInput = false;
    const menuInterval = setInterval(() => {
      if (!term.buffer.active) return;
      
      // Skip scanning if this terminal isn't currently visible
      const wrapper = termRef.current?.closest('[data-session-id]');
      const isVisible = wrapper ? (wrapper as HTMLElement).style.display !== 'none' : false;
      if (!isVisible) return;

      const buffer = term.buffer.active;
      // Scan the entire visible viewport from top to bottom
      // rather than stopping at the blinking cursor's Y position, because tool menus
      // are often drawn below the cursor, and can span more than 20 lines!
      const startRow = buffer.viewportY;
      const endRow = startRow + term.rows - 1;

      const allMenuBlocks: any[][] = [];
      let currentBlock: any[] = [];

      for (let i = startRow; i <= endRow; i++) {
        const line = buffer.getLine(i);
        if (!line) continue;
        const textRaw = line.translateToString(true);
        const text = textRaw.trimEnd();

        // Empty lines don't break a menu cluster
        if (text.length === 0) continue;

        // Detect three common interactive lists formats:
        // 1. Numbered lists: "❯ 1. Yes" or "  2. No"
        // 2. Slash command lists: "  /statusline    Set up Claude..."
        // 3. Radio styles: "  - Option" or "❯ O Talk to codebase"
        const numMatch = text.match(/^([\s>❯*]*?)(\d+)[.)]\s+(.*)$/);
        const slashMatch = text.match(/^([\s>❯*]*?)(\/[\w-]+)\s+(.*)$/);
        const radioMatch = text.match(/^([\s>❯*]*?)([O◯◉\-•])\s+(.*)$/i);

        let fg = 0, bg = 0, inverse = 0;
        const firstVisibleIdx = text.search(/\S/);
        if (firstVisibleIdx !== -1) {
           const cell = line.getCell(firstVisibleIdx);
           if (cell) {
               fg = cell.getFgColor();
               bg = cell.getBgColor();
               inverse = cell.isInverse();
           }
        }

        if (numMatch || slashMatch || radioMatch) {
          let parsed: any = null;
          if (numMatch) {
            parsed = { badge: numMatch[2], text: numMatch[3], actionText: numMatch[2] + '\r', _prefix: numMatch[1], _fg: fg, _bg: bg, _inv: inverse };
          } else if (slashMatch) {
            parsed = { badge: slashMatch[2], text: slashMatch[3], actionText: slashMatch[2] + '\r', _prefix: slashMatch[1], _fg: fg, _bg: bg, _inv: inverse };
          } else if (radioMatch) {
            parsed = { badge: radioMatch[2], text: radioMatch[3], actionText: null, _prefix: radioMatch[1], _fg: fg, _bg: bg, _inv: inverse };
          }
          if (parsed) currentBlock.push(parsed);
        } else {
          // This line is NOT a menu item.
          // Decide if it breaks the current contiguous block of options.
          if (currentBlock.length > 0) {
            // Tolerance: If it's heavily indented, it's likely a wrapped multiline description from the previous option.
            if (textRaw.match(/^\s{2,}/)) {
              continue;
            }
            // Otherwise, it's a left-aligned log message, history divider, or prompt.
            // This definitively ends the current cluster.
            allMenuBlocks.push(currentBlock);
            currentBlock = [];
          }
        }
      }

      // Push any remaining uncommitted block
      if (currentBlock.length > 0) {
        allMenuBlocks.push(currentBlock);
      }

      // The TRUE interactive menu is fundamentally the LAST complete cluster rendered to the screen.
      // E.g., this cleanly ignores historical bullet lists (like `- Shortcuts`) pushed upwards into history.
      const rawOptions = allMenuBlocks.length > 0 ? allMenuBlocks[allMenuBlocks.length - 1] : [];
      
      let activeIndex = 0;
      // Synthesize final options list with proper sequential indexes
      const options = rawOptions.map((opt, idx) => ({ ...opt, index: idx }));

      // Determine activeIndex by Outlier Detection
      activeIndex = 0;
      if (options.length > 0) {
        // Find if any option has explicit marker
        const explicitIdx = options.findIndex((opt: any) => opt._prefix.includes('>') || opt._prefix.includes('❯'));
        if (explicitIdx !== -1) {
          activeIndex = explicitIdx;
        } else {
          // Find the most common styling (FG + BG + INV) -> this is the "inactive default"
          const styleCounts: Record<string, number> = {};
          options.forEach((opt: any) => {
            const key = `${opt._fg}-${opt._bg}-${opt._inv}`;
            styleCounts[key] = (styleCounts[key] || 0) + 1;
          });

          // Sort styles by frequency descending
          const sortedStyles = Object.entries(styleCounts).sort((a, b) => b[1] - a[1]);
          
          if (sortedStyles.length > 1) {
            // There's more than one style. The active item is the OUTLIER (the one with the lowest frequency, usually 1)
            // Or explicitly, the one that is NOT the most frequent style.
            const dominantStyle = sortedStyles[0][0];
            const outlierIdx = options.findIndex((opt: any) => {
              const key = `${opt._fg}-${opt._bg}-${opt._inv}`;
              return key !== dominantStyle;
            });
            if (outlierIdx !== -1) {
              activeIndex = outlierIdx;
            }
          } else {
            // sortedStyles.length === 1. Every matched line has the EXACT same color style.
            // Since there is no explicit > marker, and no color differences, this is highly likely 
            // a static text table (like the '?' help menu) that happened to match our regex.
            // We should discard it so the UI doesn't incorrectly display it.
            options.length = 0;
          }
        }
      }

      // If we found options and they differ from the last state, update global store!
      const currentMenuStr = JSON.stringify({ options, activeIndex });
      if (options.length > 0) tuiReadyRef.current = true;
      if (currentMenuStr !== lastMenuStr) {
        lastMenuStr = currentMenuStr;
        dispatch({ 
          type: 'SET_TERMINAL_MENU', 
          id: sessionId, 
          menu: options.length > 0 ? { options, activeIndex } : null 
        });
      }

      // ─── Prompt Input Text Detection ────────────────────────────────────
      const cursorRow = buffer.viewportY + buffer.cursorY;
      const cursorLine = buffer.getLine(cursorRow);
      let detectedInput = false;

      if (cursorLine) {
        // Only look at the text strictly before the user's cursor
        const textBeforeCursor = cursorLine.translateToString(false, 0, buffer.cursorX);
        const trimmedText = textBeforeCursor.trimEnd();

        if (trimmedText.length > 0) {
          const lastChar = trimmedText.charAt(trimmedText.length - 1);
          // Standard CLI prompt markers or TUI box borders
          const isPromptMarker = /[>❯$%#│┃║?:]/.test(lastChar);
          detectedInput = !isPromptMarker;
          
          // If we see a classic prompt marker, the TUI is definitely ready and waiting for interaction!
          if (isPromptMarker) tuiReadyRef.current = true;
        }
      }

      if (detectedInput) tuiReadyRef.current = true;
      if (detectedInput !== lastHasInput) {
        lastHasInput = detectedInput;
        dispatch({ type: 'SET_HAS_INPUT_TEXT', id: sessionId, hasInputText: detectedInput });
      }
    }, 300); // Responsive enough for arrow-key tracking while saving CPU



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
      clearInterval(menuInterval);
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
      background: '#1a1917', foreground: '#e8e4de',
      cursor: hideCursor ? '#1a1917' : '#e8e4de', cursorAccent: '#1a1917'
    } : {
      background: '#f4f3ee', foreground: '#2d2c2a',
      cursor: hideCursor ? '#f4f3ee' : '#2d2c2a', cursorAccent: '#f4f3ee'
    };
  }, [state.currentTheme]);

  // ── Active tab focus restoration ─────────────────────────────────────────
  // When this session becomes the active tab, force focus + refit.
  // Fixes: switching tabs makes terminal go blank because the xterm canvas
  // lost focus while hidden and the ResizeObserver may have misfired.
  useEffect(() => {
    const isActive = state.activeTerminalId === sessionId;
    if (!isActive) return;
    // Longer delay to ensure parent div is fully display:flex with proper dimensions
    const t = setTimeout(() => {
      fitRef.current?.fit();
      xtermRef.current?.focus();
      // Also notify PTY of the correct size after refit
      const term = xtermRef.current;
      if (term && term.cols > 0 && term.rows > 0) {
        commands.tierTerminalResize(sessionId, term.cols, term.rows).catch(() => {});
      }
    }, 150);
    return () => clearTimeout(t);
  }, [state.activeTerminalId, sessionId]);

  // ── Translation Path: ALL tools use CoffeeOverlay (B-Paper Mapping) ──────
  // VT stream-layer translation is permanently disabled — it cannot work because:
  // 1. ANSI fragmentation: Claude Code wraps every word in color spans, shattering text
  // 2. Performance: 1000+ dictionary lookups per PTY chunk causes severe lag
  // 3. Color corruption: translated text shifts ANSI color boundaries
  // See docs/coffee-overlay-translation.md for full architecture documentation.

  // Always disable VT stream translation — CoffeeOverlay handles everything
  useEffect(() => {
    const isActive = state.activeTerminalId === sessionId;
    if (!isActive) return;
    // Force VT layer to 'en' (passthrough, no translation) for ALL tools
    commands.setTranslationLang('en').catch(() => {});
  }, [state.activeTerminalId, sessionId, state.currentLang]);

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
      // Primary signal: TUI has entered alternate screen OR presented interactable menu/prompt
      if (altScreenRef.current || tuiReadyRef.current) {
        dismiss();
        clearInterval(poll);
        return;
      }
      // Fallback timeout: terminal shell is fast (3s), AI CLI tools are slower (15s)
      const maxWait = tool === 'terminal' ? 3000 : 15000;
      if (elapsed > maxWait) {
        dismiss();
        clearInterval(poll);
      }
    }, 150);
    return () => clearInterval(poll);
  }, [showSplash]);

  // ── Render ───────────────────────────────────────────────────────────────

  const isDark = state.currentTheme === 'dark';
  const terminalBg = isDark ? '#1a1917' : '#f4f3ee';

  // ── CoffeeOverlay + Translation ──────────────────────────────────────────
  // Source-code replacement (à la mine-auto-cli) is now the primary translation
  // method. Canvas Overlay (B-Paper) is DISABLED to avoid double-translation
  // artifacts. The overlay infrastructure is kept for future use (e.g. tools
  // that cannot be patched via source replacement).
  const [coffeeEnabled, setCoffeeEnabled] = useState(state.currentLang !== 'en');

  // Load translation entries from Rust backend
  // Supports both:
  // 1. Static tool assignment (Launchpad click → tool prop set at creation)
  // 2. Dynamic detection (user types `claude` in plain shell/SSH → backend emits event)
  const [detectedTool, setDetectedTool] = useState<string | null>(null);

  // Listen for dynamic tool detection from PTY output stream
  useEffect(() => {
    let unlistener: (() => void) | null = null;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<{ id: string; tool: string }>('tool-detected', (event) => {
        if (event.payload.id === sessionId) {
          console.log(`[TierTerminal] Dynamic tool detected: ${event.payload.tool}`);
          setDetectedTool(event.payload.tool);
        }
      }).then(u => { unlistener = u; });
    });
    return () => { unlistener?.(); };
  }, [sessionId]);

  useEffect(() => {
    const lang = state.currentLang;
    if (lang === 'en') {
      setCoffeeEnabled(false);
      setTranslationEntries([]);
      return;
    }

    // Determine tool name for dictionary lookup
    // Priority: dynamic detection > static tool prop
    const toolDictMap: Record<string, string> = { 'claude': 'claude-code' };
    const effectiveTool = detectedTool || toolDictMap[tool || ''] || (tool || '');
    if (!effectiveTool || effectiveTool === 'terminal' || effectiveTool === 'remote') return;

    commands.getTranslationEntries(effectiveTool, lang).then((entries: [string, string][]) => {
      const formatted = entries.map(([pattern, translation]) => ({
        pattern,
        translation,
      }));
      setTranslationEntries(formatted);
      if (formatted.length > 0) {
        setCoffeeEnabled(true);
      }
    }).catch(() => {
      setCoffeeEnabled(false);
    });
  }, [state.currentLang, tool, detectedTool]);

  // ── Image Preview (Lightbox) ─────────────────────────────────────────────
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  // ── LLM Translate ────────────────────────────────────────────────────────
  const [showTransMenu, setShowTransMenu] = useState(false);
  const [showTransSettings, setShowTransSettings] = useState(false);
  const [transStatus, setTransStatus] = useState<'idle' | 'translating' | 'error'>('idle');
  const transAbortRef = useRef<AbortController | null>(null);
  const [lastLang, setLastLang] = useState<string>(() => {
    try { return localStorage.getItem('coffee_translate_lang') || ''; } catch { return ''; }
  });

  const handleTranslate = useCallback(async (langCode: string) => {
    setShowTransMenu(false);
    // Remember language choice
    setLastLang(langCode);
    try { localStorage.setItem('coffee_translate_lang', langCode); } catch {}
    const config = loadLLMConfig();
    if (!config || !config.baseUrl || !config.apiKey) {
      // No config — open settings panel
      setShowTransSettings(true);
      return;
    }
    const terminal = xtermRef.current;
    if (!terminal) return;

    // Ensure A2 shadow terminal is enabled (it may be disabled for non-Claude tools)
    setCoffeeEnabled(true);

    // Abort any in-flight request
    transAbortRef.current?.abort();
    const abortCtrl = new AbortController();
    transAbortRef.current = abortCtrl;

    setTransStatus('translating');
    try {
      // 1. Extract text segments with hash keys
      const segments = extractTextSegments(terminal);
      if (segments.length === 0) {
        setTransStatus('idle');
        return;
      }

      // 2. Send to LLM → get back TranslationEntry[] (pattern → translation)
      const entries = await translateSegments(segments, langCode, config, abortCtrl.signal);

      // 3. Feed into the existing dictionary render pipeline
      //    This makes the normal render loop pick up the translations automatically!
      if (entries.length > 0) {
        setLLMTranslationEntries(entries);
        // Force a re-render of A2 by marking dirty
        coffeeRef.current?.resumeRendering();
      }

      setTransStatus('idle');
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      console.error('[LLM Translate] Error:', err);
      setTransStatus('error');
      setTimeout(() => setTransStatus('idle'), 2000);
    }
  }, []);


  const handleImageClick = useCallback(async (url: string) => {
    let rawPath = url;
    // Extract path from markdown ![alt](path) if it matches
    const mdMatch = url.match(/!\[.*?\]\((.*?)\)/);
    if (mdMatch) {
      rawPath = mdMatch[1];
    }
    
    // If it's a generic http/https URL, use it directly
    if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) {
      setPreviewImage(rawPath);
      return;
    }

    try {
      // It's a local path, safely convert to tauri custom protocol
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const safeSrc = convertFileSrc(rawPath);
      setPreviewImage(safeSrc);
    } catch {
      setPreviewImage(rawPath);
    }
  }, []);

  // Fallback handler: if CoffeeOverlay reports failure, degrade gracefully
  const handleOverlayFallback = () => {
    console.warn('[TierTerminal] Coffee Overlay degraded → falling back to xterm.js native');
    setCoffeeEnabled(false);
  };

  return (
    <div className="tier-terminal" style={{ background: terminalBg, position: 'relative' }}>
      {/* xterm.js: ALWAYS visible. Handles all rendering, input, and scrolling. */}
      <div className="tier-xterm-wrap">
        <div ref={termRef} className="tier-xterm" />
      </div>

      {/* CoffeeOverlay: transparent Canvas on top of xterm.js.
          Only paints translation patches — everything else shows through. */}
      <CoffeeOverlay
        ref={coffeeRef}
        xtermRef={xtermRef}
        xtermContainerRef={termRef}
        theme={isDark ? 'dark' : 'light'}
        visible={coffeeEnabled && state.showOverlay}
        onFallback={handleOverlayFallback}
        onImageClick={handleImageClick}
      />

      {/* ── LLM Translate FAB ─────────────────────────────────────────── */}
      <div className="translate-fab-wrapper">
        <div
          className={`translate-fab ${transStatus}`}
          onContextMenu={(e) => {
            e.preventDefault();
            setShowTransMenu(prev => !prev);
          }}
        >
          <span
            className="translate-fab-label"
            onClick={() => setShowTransMenu(prev => !prev)}
          >{lastLang ? TRANSLATE_LANGUAGES.find(l => l.code === lastLang)?.label || 'Translate' : 'Translate'}</span>
          <div
            className="translate-fab-icon"
            onClick={() => {
              if (transStatus === 'translating') {
                transAbortRef.current?.abort();
                setTransStatus('idle');
              } else if (lastLang) {
                handleTranslate(lastLang);
              } else {
                setShowTransMenu(prev => !prev);
              }
            }}
          >
            {transStatus === 'translating'
              ? <div className="translate-spinner" />
              : lastLang
                ? <span className="translate-fab-flag">{TRANSLATE_LANGUAGES.find(l => l.code === lastLang)?.flag || '🌐'}</span>
                : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 8l6 0"/><path d="M4 14l6 0"/><path d="M2 5h12"/><path d="M7 2v3"/><path d="M11 3c0 4.4-3.6 8-8 8"/><path d="M5 3c0 2.8 2 5.4 5.3 8"/><path d="M14 13l4 8"/><path d="M18 21l2-5"/><path d="M15 18h6"/></svg>
            }
          </div>
        </div>

        {/* Dropdown — outside of translate-fab to avoid overflow:hidden clipping */}
        {showTransMenu && (
          <>
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 55 }}
              onClick={() => setShowTransMenu(false)}
            />
            <div className="translate-dropdown" onClick={e => e.stopPropagation()}>
              {TRANSLATE_LANGUAGES.map(lang => (
                <button
                  key={lang.code}
                  className="translate-lang-item"
                  onClick={() => handleTranslate(lang.code)}
                >
                  <span className="translate-lang-flag">{lang.flag}</span>
                  <span>{lang.label}</span>
                </button>
              ))}
              <div className="translate-divider" />
              <button
                className="translate-settings-btn"
                onClick={() => { setShowTransMenu(false); setShowTransSettings(true); }}
              >
                <span>Settings</span>
              </button>
            </div>
          </>
        )}

        {/* Translate Settings Panel */}
        {showTransSettings && (
          <TranslateSettings
            initialConfig={loadLLMConfig() ?? { baseUrl: '', apiKey: '', model: '' }}
            onSave={cfg => { saveLLMConfig(cfg); setShowTransSettings(false); }}
            onClose={() => setShowTransSettings(false)}
          />
        )}
      </div>

      {/* Image Preview Lightbox */}
      {previewImage && (
        <div 
          className="tier-lightbox" 
          onClick={() => setPreviewImage(null)}
          style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            cursor: 'zoom-out'
          }}
        >
          <img 
            src={previewImage} 
            alt="Preview" 
            style={{
              maxWidth: '90%',
              maxHeight: '90%',
              objectFit: 'contain',
              borderRadius: '8px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.5)'
            }}
          />
        </div>
      )}

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
