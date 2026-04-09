// CoffeeOverlay.tsx — Transparent translation overlay
// Sits ON TOP of xterm.js. xterm.js handles all normal rendering (WebGL).
// This overlay ONLY paints translated text patches over matched regions.
// Everything else is transparent — the original terminal shows through.

import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import type { Terminal } from '@xterm/xterm';
import {
  renderTranslationOverlay,
  getSelectedText,
  createConfig,
  computeCellMetrics,
  type RendererConfig,
  type SelectionRange,
  type CellMetrics,
} from './coffee-renderer';

interface CoffeeOverlayProps {
  xtermRef: React.RefObject<Terminal | null>;
  /** Container element of xterm.js for computing cell metrics */
  xtermContainerRef: React.RefObject<HTMLDivElement | null>;
  theme: 'dark' | 'light';
  visible: boolean;
  onFallback?: () => void;
}

export interface CoffeeOverlayRef {
  hasSelection: () => boolean;
  copySelection: () => boolean;
}

export const CoffeeOverlay = forwardRef<CoffeeOverlayRef, CoffeeOverlayProps>(({ xtermRef, xtermContainerRef, theme, visible, onFallback }, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const configRef = useRef<RendererConfig>(createConfig(theme === 'dark'));
  const rafRef = useRef<number>(0);
  const selectionRef = useRef<SelectionRange | null>(null);
  const metricsRef = useRef<CellMetrics>({ cellWidth: 8, cellHeight: 18, offsetX: 0, offsetY: 0 });
  const failedRef = useRef(false);

  useImperativeHandle(ref, () => ({
    hasSelection: () => {
      const sel = selectionRef.current;
      return !!(sel && !(sel.startRow === sel.endRow && sel.startCol === sel.endCol));
    },
    copySelection: () => {
      const term = xtermRef.current;
      const sel = selectionRef.current;
      if (term && sel) {
        const text = getSelectedText(term, sel);
        if (text.trim().length > 0) {
          navigator.clipboard.writeText(text).catch(() => {});
          return true;
        }
      }
      return false;
    }
  }));

  // Update config when theme changes
  useEffect(() => {
    configRef.current = createConfig(theme === 'dark');
  }, [theme]);

  // Update cell metrics when terminal resizes
  const updateMetrics = useCallback(() => {
    const term = xtermRef.current;
    const container = xtermContainerRef.current;
    if (term && container) {
      metricsRef.current = computeCellMetrics(term, container);
    }
  }, [xtermRef, xtermContainerRef]);

  // ── Core render — transparent overlay with translation patches ──────────

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const term = xtermRef.current;
    if (!canvas || !term || !visible) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      if (!failedRef.current) {
        failedRef.current = true;
        onFallback?.();
      }
      return;
    }

    try {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      // Resize canvas backing store for HiDPI
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        updateMetrics();
      }

      const config = configRef.current;
      config.devicePixelRatio = dpr;

      renderTranslationOverlay(term, ctx, w, h, config, metricsRef.current);
    } catch {
      if (!failedRef.current) {
        failedRef.current = true;
        onFallback?.();
      }
    }
  }, [visible, xtermRef, updateMetrics, onFallback]);

  // ── Throttled render loop ─────────────────────────────────────────────
  // The overlay only needs to repaint when terminal content changes.
  // Using a 200ms interval (5fps) instead of requestAnimationFrame (60fps)
  // to avoid burning CPU/GPU — translation text is static between updates.

  useEffect(() => {
    if (!visible) return;

    // Initial metrics calculation
    updateMetrics();

    // Render once immediately
    render();

    // Then re-render periodically at a low frequency
    const interval = setInterval(() => {
      render();
    }, 200);

    return () => {
      clearInterval(interval);
    };
  }, [visible, render, updateMetrics]);

  // ── Mouse handling — forward clicks to xterm.js ───────────────────────

  const handleClick = useCallback(() => {
    xtermRef.current?.focus();
  }, [xtermRef]);

  if (!visible) return null;

  return (
    <canvas
      ref={canvasRef}
      className="coffee-overlay-canvas"
      onClick={handleClick}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none', // Let all input pass through to xterm.js
      }}
    />
  );
});
