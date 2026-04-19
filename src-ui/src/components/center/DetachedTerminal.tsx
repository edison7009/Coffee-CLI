// DetachedTerminal.tsx — Attach-only terminal for detached windows
// Connects to an existing PTY session (no tierTerminalStart call).
// First replays buffered history, then subscribes to live events.

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { listen } from '@tauri-apps/api/event';
import { commands } from '../../tauri';
import { notifyUserInputSubmitted } from '../../lib/agent-status-bus';
import { useAppState, type ToolType } from '../../store/app-state';
import '@xterm/xterm/css/xterm.css';
import './TierTerminal.css';

interface TerminalOutputEvent {
  id: string;
  data: string;
}

export function DetachedTerminal({ sessionId, tool }: { sessionId: string; tool: ToolType }) {
  const { state } = useAppState();
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const isDark = state.currentTheme === 'dark';

  useEffect(() => {
    if (!termRef.current) return;
    let mounted = true;
    const unlisteners: (() => void)[] = [];

    const term = new Terminal({
      fontFamily: "'Cascadia Code', 'SF Mono', 'Consolas', 'DejaVu Sans Mono', monospace",
      fontSize: 14,
      lineHeight: 1.35,
      letterSpacing: 0.5,
      cursorStyle: 'bar',
      cursorBlink: false,
      allowProposedApi: true,
      scrollback: 5000,
      theme: isDark ? {
        background:  '#0c0c0c',
        foreground:  '#e8e4de',
        cursor:      '#c4956a',
        cursorAccent: '#0c0c0c',
        selectionBackground: 'rgba(196,149,106,0.3)',
      } : {
        background:  '#f4f3ee',
        foreground:  '#2d2c2a',
        cursor:      '#c4956a',
        cursorAccent: '#f4f3ee',
        selectionBackground: 'rgba(196,149,106,0.25)',
      },
    });

    xtermRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);

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
            useWebgl = /nvidia|geforce|radeon|amd|rx\s?\d|arc\s?a/i.test(renderer);
          }
        }
      }
    } catch {}

    if (useWebgl) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => { webgl.dispose(); });
        term.loadAddon(webgl);
      } catch (err) {}
    }

    // Keyboard input → PTY
    term.onData((data) => {
      commands.tierTerminalInput(sessionId, data).catch(() => {});
      // Optimistic status update — mirrors TierTerminal. Scoped to Claude:
      // only Claude has a hook-driven agentStatus that this can usefully
      // nudge; the other tools render a steady pulse regardless.
      if ((data.includes('\r') || data.includes('\n')) && tool === 'claude') {
        notifyUserInputSubmitted(sessionId, tool);
      }
    });

    const doFit = () => {
      try {
        fit.fit();
        commands.tierTerminalResize(sessionId, term.cols || 80, term.rows || 24).catch(() => {});
      } catch {}
    };

    const ro = new ResizeObserver(() => requestAnimationFrame(doFit));
    if (termRef.current) ro.observe(termRef.current);

    (async () => {
      // 1. Replay buffered history
      try {
        const chunks = await commands.getTerminalBuffer(sessionId);
        if (mounted && chunks.length > 0) {
          for (const b64 of chunks) {
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            term.write(bytes);
          }
        }
      } catch (e) {
        console.warn('[DetachedTerminal] Buffer replay failed:', e);
      }

      // 2. Subscribe to live output (event name must match Rust: "tier-terminal-output")
      const outUn = await listen<TerminalOutputEvent>('tier-terminal-output', (event) => {
        if (event.payload.id !== sessionId || !mounted) return;
        const bytes = Uint8Array.from(atob(event.payload.data), c => c.charCodeAt(0));
        term.write(bytes);
      });
      if (mounted) unlisteners.push(outUn); else { outUn(); return; }

      // 3. Fit after history replay
      setTimeout(doFit, 80);
    })();

    return () => {
      mounted = false;
      ro.disconnect();
      term.dispose();
      xtermRef.current = null;
      unlisteners.forEach(u => u());
      // DO NOT kill PTY — it belongs to the shared session pool
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: isDark ? '#0c0c0c' : '#f4f3ee' }}>
      <div style={{
        padding: '6px 16px',
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--text-2)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
      }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#34d399', flexShrink: 0 }} />
        {tool || 'Terminal'}
      </div>
      <div ref={termRef} className="tier-terminal" style={{ flex: 1 }} />
    </div>
  );
}
