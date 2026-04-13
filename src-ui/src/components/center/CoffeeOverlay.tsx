// CoffeeOverlay.tsx — A2 Shadow Terminal Translation Overlay
// Architecture: A2 is a second xterm.js instance (no PTY) that mirrors A1's
// content with translations applied. Both use identical WebGL rendering.
// A1 stays connected to Claude Code (PTY). A2 is "bottle-fed" translated data.

import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import {
  renderToShadowTerminal,
  createRendererState,
  getSelectedText,
  findInlineImages,
  type SelectionRange,
  type InlineImage,
  type RendererState,
} from './coffee-renderer';
import type { TranslationEngine } from './coffee-translation';

interface CoffeeOverlayProps {
  xtermRef: React.RefObject<Terminal | null>;
  /** Container element of xterm.js A1 for sizing reference */
  xtermContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Per-instance translation engine owned by the parent TierTerminal. */
  engine: TranslationEngine;
  theme: 'dark' | 'light';
  visible: boolean;
  onFallback?: () => void;
  onImageClick?: (url: string) => void;
}

export interface CoffeeOverlayRef {
  hasSelection: () => boolean;
  copySelection: () => boolean;
  /** Expose A2 shadow terminal for external writes (e.g. LLM translation) */
  getShadowTerminal: () => Terminal | null;
  /** Pause the render loop (prevents A2 from being overwritten by A1 mirror) */
  pauseRendering: () => void;
  /** Resume the render loop (restores normal A1→A2 mirroring) */
  resumeRendering: () => void;
}

export const CoffeeOverlay = forwardRef<CoffeeOverlayRef, CoffeeOverlayProps>(({ xtermRef, xtermContainerRef: _xtermContainerRef, engine, theme, visible, onFallback, onImageClick }, ref) => {
  const shadowContainerRef = useRef<HTMLDivElement>(null);
  const shadowTermRef = useRef<Terminal | null>(null);
  const shadowFitRef = useRef<FitAddon | null>(null);
  const selectionRef = useRef<SelectionRange | null>(null);
  const iconContainerRef = useRef<HTMLDivElement>(null);
  const failedRef = useRef(false);
  const dirtyRef = useRef(true);
  const rafRef = useRef(0);
  const renderPausedRef = useRef(false);
  // Per-row body cache state for the renderer. Lives across frames so cached
  // row bodies survive between RAF ticks. Reset whenever the engine generation
  // or terminal geometry changes (the renderer detects this internally).
  const rendererStateRef = useRef<RendererState>(createRendererState());

  // ── Selection handling ──────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    hasSelection: () => {
      const sel = selectionRef.current;
      return sel !== null && (sel.startRow !== sel.endRow || sel.startCol !== sel.endCol);
    },
    copySelection: () => {
      const sel = selectionRef.current;
      const term = xtermRef.current;
      if (!sel || !term) return false;
      const text = getSelectedText(term, sel);
      if (text) {
        navigator.clipboard.writeText(text).catch(() => {});
        return true;
      }
      return false;
    },
    getShadowTerminal: () => shadowTermRef.current,
    pauseRendering: () => { renderPausedRef.current = true; },
    resumeRendering: () => { renderPausedRef.current = false; dirtyRef.current = true; },
  }));

  // ── Theme config for A2 ─────────────────────────────────────────────────
  const getThemeConfig = useCallback(() => {
    const isDark = theme === 'dark';
    return isDark ? {
      background: '#1a1917',
      foreground: '#e8e4de',
      cursor: '#1a1917', // Hidden cursor (A2 is display-only)
      cursorAccent: '#1a1917',
      black: '#1a1917',
      red: '#e07070',
      green: '#7ec77e',
      yellow: '#d4a846',
      blue: '#78a8d4',
      magenta: '#b07cc6',
      cyan: '#5fc4c0',
      white: '#e8e4de',
      brightBlack: '#6b6762',
    } : {
      background: '#f4f3ee',
      foreground: '#2d2c2a',
      cursor: '#f4f3ee',
      cursorAccent: '#f4f3ee',
      black: '#2d2c2a',
      red: '#cc3333',
      green: '#2d7a2d',
      yellow: '#8a6000',
      blue: '#2952a3',
      magenta: '#7a3d8a',
      cyan: '#1a6b6b',
      white: '#f4f3ee',
      brightBlack: '#9e9c98',
    };
  }, [theme]);

  // ── Create/Destroy A2 shadow terminal ───────────────────────────────────
  useEffect(() => {
    if (!visible || !shadowContainerRef.current) {
      // Dispose A2 when hidden
      if (shadowTermRef.current) {
        shadowTermRef.current.dispose();
        shadowTermRef.current = null;
        shadowFitRef.current = null;
      }
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout>;

    function tryCreate() {
      if (cancelled) return;
      const source = xtermRef.current;
      if (!source || !shadowContainerRef.current) {
        // A1 not ready yet — poll until it is
        pollTimer = setTimeout(tryCreate, 100);
        return;
      }

      // Read A1's font settings so A2 matches perfectly
      const fontFamily = source.options.fontFamily
        || "'Cascadia Mono', 'Cascadia Code', Consolas, 'Ubuntu Mono', 'DejaVu Sans Mono', 'Liberation Mono', monospace";
      const fontSize = source.options.fontSize || 14;
      const lineHeight = source.options.lineHeight || 1.3;

      // Create A2: same font, same theme, no scrollback (we mirror viewport only)
      const shadow = new Terminal({
        fontFamily,
        fontSize,
        lineHeight,
        letterSpacing: 0,
        fontWeight: '400',
        customGlyphs: true,
        cursorStyle: 'bar' as const,
        cursorBlink: false,
        scrollback: 0, // A2 only shows current viewport
        rows: source.rows,
        cols: source.cols,
        theme: getThemeConfig(),
        disableStdin: true, // A2 is read-only display
        allowProposedApi: true,
      });

      const fit = new FitAddon();
      shadow.loadAddon(fit);
      shadow.open(shadowContainerRef.current);

      // Load WebGL addon on A2 (same rendering engine as A1)
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => { webgl.dispose(); });
        shadow.loadAddon(webgl);
      } catch (err) {
        console.warn('[CoffeeOverlay] A2 WebGL failed, using DOM renderer', err);
      }

      fit.fit();

      shadowTermRef.current = shadow;
      shadowFitRef.current = fit;
      dirtyRef.current = true; // Trigger first render

      console.log('[CoffeeOverlay] A2 shadow terminal created.', {
        rows: shadow.rows,
        cols: shadow.cols,
        fontFamily,
        fontSize,
      });
    }

    tryCreate();

    return () => {
      cancelled = true;
      clearTimeout(pollTimer);
      if (shadowTermRef.current) {
        shadowTermRef.current.dispose();
        shadowTermRef.current = null;
        shadowFitRef.current = null;
      }
    };
  }, [visible, xtermRef, getThemeConfig]);

  // ── Core render loop: read A1 → translate → write A2 ────────────────────
  // CRITICAL: xterm.js write() is ASYNC. If we call write() while the previous
  // frame is still being parsed, frames queue up. The WebGL renderer may paint
  // an intermediate state where half the buffer is Frame_old (Chinese) and half
  // is Frame_new (English) → produces "ghost text" artifacts.
  // Solution: writeBusy lock — skip render while A2 is still digesting.
  const writeBusyRef = useRef(false);

  const render = useCallback(() => {
    const source = xtermRef.current;
    const target = shadowTermRef.current;
    if (!source || !target || !visible) return;

    // If LLM translation is being displayed, don't overwrite A2
    if (renderPausedRef.current) return;

    // If A2 is still processing the previous frame, skip this render.
    // dirtyRef stays true so the RAF loop will retry next frame.
    if (writeBusyRef.current) {
      dirtyRef.current = true;
      return;
    }

    try {
      const frame = renderToShadowTerminal(source, target, engine, rendererStateRef.current);

      // Lock: prevent new renders until A2 finishes parsing this frame
      writeBusyRef.current = true;
      target.write(frame, () => {
        writeBusyRef.current = false;
      });

      // Inline Image Icon sync
      if (iconContainerRef.current) {
        const core = (target as any)._core;
        const dims = core?._renderService?.dimensions;
        if (dims?.css?.cell?.width && dims?.css?.cell?.height) {
          const metrics = {
            cellWidth: dims.css.cell.width,
            cellHeight: dims.css.cell.height,
            offsetX: 0,
            offsetY: 0,
          };
          const images = findInlineImages(source);
          syncImageIcons(iconContainerRef.current, images, metrics, source.buffer.active.viewportY, onImageClick);
        }
      }
    } catch {
      if (!failedRef.current) {
        failedRef.current = true;
        onFallback?.();
      }
    }
  }, [visible, xtermRef, engine, onFallback, onImageClick]);

  // ── Subscribe to A1 updates ─────────────────────────────────────────────
  useEffect(() => {
    const term = xtermRef.current;
    if (!term || !visible) return;

    dirtyRef.current = true;

    // ── Self-terminating RAF loop ─────────────────────────────────────────
    // Key fix: the old loop rescheduled unconditionally every frame (60fps),
    // preventing the CPU from entering idle states even when the terminal was
    // completely still. On laptops without a GPU this caused constant heating.
    //
    // New design: loop stops itself when there is nothing to render.
    // markDirty() restarts it when new content arrives.
    const loop = () => {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        render();
        rafRef.current = requestAnimationFrame(loop); // more work may follow
      } else {
        rafRef.current = 0; // idle — stop until markDirty wakes us up
      }
    };

    const startLoop = () => {
      if (rafRef.current === 0) {
        rafRef.current = requestAnimationFrame(loop);
      }
    };

    // Ink/React-terminal frameworks redraw menus via multiple write() calls
    // in rapid succession (CSI erase + CSI move + text for each column).
    // If we render between writes, we read an incomplete buffer where some
    // characters are missing (e.g. "V ew" instead of "View").
    // Solution: debounce — wait until writes stop for 50ms before rendering.
    // markDirty also restarts the loop so no frame is missed after it stopped.
    let writeTimer: ReturnType<typeof setTimeout>;
    const markDirty = () => {
      clearTimeout(writeTimer);
      writeTimer = setTimeout(() => {
        dirtyRef.current = true;
        startLoop();
      }, 50);
    };

    const onWrite = term.onWriteParsed(markDirty);
    const onScroll = term.onScroll(markDirty);

    // Kick off first render
    startLoop();

    return () => {
      clearTimeout(writeTimer);
      onWrite.dispose();
      onScroll.dispose();
      if (rafRef.current !== 0) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [visible, render]);

  // ── Sync resize: when A1 resizes, resize A2 to match ────────────────────
  useEffect(() => {
    const source = xtermRef.current;
    if (!source || !visible) return;

    const onResize = source.onResize(({ cols, rows }) => {
      const shadow = shadowTermRef.current;
      const fit = shadowFitRef.current;
      if (shadow && fit) {
        shadow.resize(cols, rows);
        fit.fit();
        dirtyRef.current = true;
      }
    });

    return () => { onResize.dispose(); };
  }, [visible, xtermRef]);

  // ── Mouse handling ─────────────────────────────────────────────────────
  const handleClick = useCallback(() => {
    xtermRef.current?.focus();
  }, [xtermRef]);

  if (!visible) return null;

  return (
    <>
      <div
        ref={shadowContainerRef}
        className="coffee-overlay-shadow"
        onClick={handleClick}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none', // Let all input pass through to A1
          background: theme === 'dark' ? '#1a1917' : '#f4f3ee',
        }}
      />
      <div
        ref={iconContainerRef}
        className="coffee-overlay-icons"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      />
    </>
  );
});

// ── Image Icon DOM Syncing ────────────────────────────────────────────────

interface CellMetrics {
  cellWidth: number;
  cellHeight: number;
  offsetX: number;
  offsetY: number;
}

function syncImageIcons(
  container: HTMLElement,
  images: InlineImage[],
  metrics: CellMetrics,
  viewportY: number,
  onImageClick?: (url: string) => void,
) {
  const children = container.children;

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    let el = children[i] as HTMLElement | undefined;

    if (!el) {
      el = document.createElement('button');
      el.className = 'coffee-img-icon';
      el.innerHTML = '🖼';
      el.style.position = 'absolute';
      el.style.pointerEvents = 'auto';
      el.style.cursor = 'pointer';
      el.style.width = '24px';
      el.style.fontSize = '12px';
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.style.background = 'rgba(255, 255, 255, 0.15)';
      el.style.border = '1px solid rgba(255, 255, 255, 0.2)';
      el.style.borderRadius = '4px';
      el.style.backdropFilter = 'blur(4px)';
      el.style.transition = 'background 0.2s, transform 0.1s';

      el.onmouseenter = () => {
        el!.style.background = 'rgba(255, 255, 255, 0.3)';
        el!.style.transform = 'scale(1.1)';
      };
      el.onmouseleave = () => {
        el!.style.background = 'rgba(255, 255, 255, 0.15)';
        el!.style.transform = 'scale(1)';
      };
      el.style.display = 'none';
      container.appendChild(el);
    }

    const x = metrics.offsetX + img.colEnd * metrics.cellWidth + 6;
    const y = metrics.offsetY + (img.row - viewportY) * metrics.cellHeight;
    const height = 18;
    const top = y + (metrics.cellHeight - height) / 2;

    el.style.display = 'flex';
    el.style.left = `${x}px`;
    el.style.top = `${top}px`;
    el.style.height = `${height}px`;

    el.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      onImageClick?.(img.url);
    };
  }

  for (let i = images.length; i < children.length; i++) {
    (children[i] as HTMLElement).style.display = 'none';
  }
}
