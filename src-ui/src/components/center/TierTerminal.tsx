// TierTerminal.tsx — Dual-layer terminal renderer
// Layer 1: xterm.js (ANSI parsing + keyboard + WebGL GPU rendering)
// Layer 2: Coffee Overlay (Pretext + Canvas 2D, auto-enabled with smart fallback)

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { CoffeeOverlay, type CoffeeOverlayRef } from './CoffeeOverlay';
import { setTranslationEntries } from './coffee-translation';
import { listen } from '@tauri-apps/api/event';
import { commands } from '../../tauri';
import { useAppState, type ToolType } from '../../store/app-state';
import '@xterm/xterm/css/xterm.css';
import './TierTerminal.css';

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

// ─── Component ───────────────────────────────────────────────────────────────

export function TierTerminal({ sessionId, tool }: { sessionId: string; tool: ToolType }) {
  const { state, dispatch } = useAppState();

  const termRef  = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef   = useRef<FitAddon | null>(null);
  const coffeeRef = useRef<CoffeeOverlayRef>(null);

  // ── xterm.js init ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!termRef.current || xtermRef.current) return;

    let mounted = true;
    const unlisteners: (() => void)[] = [];

    const isDark = state.currentTheme === 'dark';
    const term = new Terminal({
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 14,
      lineHeight: 1.3,
      letterSpacing: 0,
      fontWeight: '400',
      customGlyphs: true,
      // Hide xterm.js cursor — CLI tools (Claude Code, Codex, etc.) manage
      // their own cursor positioning via ANSI CSI sequences. Showing xterm's
      // cursor causes it to jump around following the tool's internal redraws.
      cursorStyle: 'bar' as const,
      cursorBlink: false,
      cursorInactiveStyle: 'none',
      scrollback: 5000,
      theme: isDark ? {
        background:  '#1a1917',
        foreground:  '#e8e4de',
        cursor:      '#1a1917', // Match background to hide completely
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
        cursor:      '#f4f3ee', // Match background to hide completely
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
    
    // Forcefully hide the cursor immediately at startup
    term.write('\x1b[?25l');

    // GPU-accelerated rendering via WebGL (falls back to Canvas2D)
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
      });
      term.loadAddon(webgl);
    } catch {
      console.warn('[TierTerminal] WebGL not available, using Canvas2D fallback');
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

        // Paste: Ctrl+V / Cmd+V
        if (cmdOrCtrl && e.code === 'KeyV') {
          navigator.clipboard.readText().then(text => {
            // Send pasted text to the backend
            commands.tierTerminalInput(sessionId, text).catch(() => {});
          });
          return false;
        }
      }
      return true; // Let xterm handle all other keys natively
    });

    xtermRef.current = term;
    fitRef.current   = fit;

    // Auto-focus so keyboard input works immediately
    term.focus();

    // ─── Unified Global Focus Enforcer ───────────────────────────────────────
    // UX requirement: "The terminal area governs operations on both sides... the entire interface's focus IS the terminal."
    // We forcibly pull focus back to XTerm if the user clicks any non-input area or focuses a button.
    const enforceFocus = () => {
      if (!mounted) return;
      setTimeout(() => {
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
      // Register all listeners first and wait for them to be ready
      const outputUn = await listen<TerminalOutputEvent>('tier-terminal-output', (event) => {
        if (!mounted || event.payload.id !== sessionId) return;
        // Strip out the ANSI code that shows the cursor (CSI ? 25 h) so it never reappears
        const data = event.payload.data.replace(/\x1b\[\?25h/g, '');
        xtermRef.current?.write(data);
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
        await commands.tierTerminalStart(sessionId, tool, initialCols, initialRows);

        // Synchronize the workspace (left panel) to mirror the tool's starting directory
        try {
          const data = await commands.scanFolder(null);
          if (mounted) {
            dispatch({ type: 'SET_FOLDER', path: data.root });
            dispatch({ type: 'SET_SCAN', data });
          }
        } catch (e) {
          console.warn('[Terminal] Failed to sync workspace on startup', e);
        }

        // Auto-skip the interactive 'Trust this folder' options screen for Claude.
        // Use rawWrite to avoid triggering the agent-status "working" detection.
        if (tool === 'claude') {
          setTimeout(() => {
            commands.tierTerminalRawWrite(sessionId, "\r").catch(() => {});
          }, 1500);
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
    const menuInterval = setInterval(() => {
      if (!term.buffer.active) return;
      const buffer = term.buffer.active;
      // Scan the entire visible viewport from top to bottom
      // rather than stopping at the blinking cursor's Y position, because tool menus 
      // are often drawn below the cursor, and can span more than 20 lines!
      const endRow = buffer.baseY + term.rows - 1;
      const startRow = buffer.baseY;

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
      if (currentMenuStr !== lastMenuStr) {
        lastMenuStr = currentMenuStr;
        dispatch({ 
          type: 'SET_TERMINAL_MENU', 
          id: sessionId, 
          menu: options.length > 0 ? { options, activeIndex } : null 
        });
      }
    }, 150); // Fast enough to perfectly track arrow keys!



    // Resize observer
    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch {}
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
      commands.tierTerminalKill(sessionId).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Theme sync ───────────────────────────────────────────────────────────

  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const isDark = state.currentTheme === 'dark';
    term.options.theme = isDark ? {
      background: '#1a1917', foreground: '#e8e4de', cursor: 'transparent', cursorAccent: '#1a1917'
    } : {
      background: '#f4f3ee', foreground: '#2d2c2a', cursor: 'transparent', cursorAccent: '#f4f3ee'
    };
  }, [state.currentTheme]);

  // ── Translation language sync ───────────────────────────────────────────
  // VT layer is always disabled ("en") — CoffeeOverlay handles all translation
  // at the rendering layer to avoid double-translation corruption.

  useEffect(() => {
    // Always disable VT-layer translation.
    // CoffeeOverlay reads pristine English text from xterm.js buffer
    // and paints translations via Canvas overlay. If VT translates first,
    // the buffer contains mixed Chinese/English and sentence matching breaks.
    commands.setTranslationLang('en').catch(() => {});
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────

  const isDark = state.currentTheme === 'dark';
  const terminalBg = isDark ? '#1a1917' : '#f4f3ee';

  // ── CoffeeOverlay + Translation ──────────────────────────────────────────
  // Enabled when translation language is not English.
  // CoffeeOverlay renders the terminal via Canvas 2D with sentence-level
  // translation painted over the original text.
  const [coffeeEnabled, setCoffeeEnabled] = useState(state.currentLang !== 'en');

  // Load translation entries from Rust backend
  useEffect(() => {
    const lang = state.currentLang;
    if (lang === 'en') {
      setCoffeeEnabled(false);
      setTranslationEntries([]);
      return;
    }

    // Determine tool name for dictionary lookup
    const toolDictMap: Record<string, string> = { 'claude': 'claude-code', 'freecode': 'free-code' };
    const toolDict = toolDictMap[tool || ''] || (tool || '');
    if (!toolDict) return;

    commands.getTranslationEntries(toolDict, lang).then((entries: [string, string][]) => {
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
  }, [state.currentLang, tool]);

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
        visible={coffeeEnabled}
        onFallback={handleOverlayFallback}
      />
    </div>
  );
}
