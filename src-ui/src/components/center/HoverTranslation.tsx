// HoverTranslation.tsx — Dr.eye-style hover translation overlay
//
// Alternative to CoffeeOverlay (A2 Shadow Terminal): instead of repainting the
// entire visible terminal in a second xterm.js instance, this overlay leaves
// A1 untouched and only shows a small tooltip near the hovered row. Zero RAF
// loop, zero per-frame rendering, zero second WebGL context. The trade-off is
// the user has to move the mouse to read translations.
//
// Inspired by the GDI-hooked screen translators of the 90s/2000s (Dr.eye 译典通,
// NJStar 南极星) which got their famous "丝毫不卡" feel by NEVER redrawing the
// target window — they only popped a small tooltip.

import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { TranslationEngine, LineTranslation } from './coffee-translation';

interface HoverTranslationProps {
  xtermRef: React.RefObject<Terminal | null>;
  xtermContainerRef: React.RefObject<HTMLDivElement | null>;
  engine: TranslationEngine;
  theme: 'dark' | 'light';
  visible: boolean;
}

interface TooltipState {
  text: string;
  rowTop: number;     // pixel y of the hovered row's top edge
  rowBottom: number;  // pixel y of the hovered row's bottom edge
}

/**
 * Build a "preview" of the line where matched English spans are replaced
 * inline with their translations. Unmatched spans stay as the original text.
 * Gives the user a one-shot mental model of the whole line in their language.
 */
function buildLinePreview(lineText: string, matches: LineTranslation[]): string {
  if (matches.length === 0) return '';
  const sorted = matches.slice().sort((a, b) => a.colStart - b.colStart);
  let result = '';
  let pos = 0;
  for (const m of sorted) {
    if (m.colStart > pos) result += lineText.substring(pos, m.colStart);
    result += m.translatedText;
    pos = m.colEnd;
  }
  if (pos < lineText.length) result += lineText.substring(pos);
  return result.trim();
}

export function HoverTranslation({
  xtermRef,
  xtermContainerRef,
  engine,
  theme,
  visible,
}: HoverTranslationProps) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  // Track last hovered row so we only re-translate on row change, not on
  // every mousemove pixel. mousemove fires ~60-120Hz; we want O(rows) work
  // per session, not O(pixels).
  const lastRowRef = useRef<number>(-1);

  useEffect(() => {
    if (!visible) {
      setTooltip(null);
      lastRowRef.current = -1;
      return;
    }

    const container = xtermContainerRef.current;
    const term = xtermRef.current;
    if (!container || !term) return;

    // Read xterm's CSS cell metrics. xterm.js exposes them via the internal
    // _core API (same path CoffeeOverlay uses for image icon positioning).
    const getCellMetrics = (): { cellW: number; cellH: number; padX: number; padY: number } | null => {
      const core = (term as any)._core;
      const dims = core?._renderService?.dimensions;
      const cellW = dims?.css?.cell?.width;
      const cellH = dims?.css?.cell?.height;
      if (!cellW || !cellH) return null;
      // The xterm container has CSS padding (see TierTerminal.css). The
      // .xterm element is the actual canvas surface inside that padding.
      const xtermEl = container.querySelector('.xterm') as HTMLElement | null;
      const cs = xtermEl ? window.getComputedStyle(xtermEl) : null;
      const padX = cs ? parseFloat(cs.paddingLeft) || 0 : 0;
      const padY = cs ? parseFloat(cs.paddingTop) || 0 : 0;
      return { cellW, cellH, padX, padY };
    };

    const onMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;

      const m = getCellMetrics();
      if (!m) return;

      const { cellW, cellH, padX, padY } = m;
      const row = Math.floor((localY - padY) / cellH);
      if (row < 0 || row >= term.rows) {
        if (lastRowRef.current !== -1) {
          lastRowRef.current = -1;
          setTooltip(null);
        }
        return;
      }

      // Skip work if still on the same row as the last event.
      if (row === lastRowRef.current) return;
      lastRowRef.current = row;

      const buffer = term.buffer.active;
      const line = buffer.getLine(row + buffer.viewportY);
      if (!line) {
        setTooltip(null);
        return;
      }

      const lineText = line.translateToString(false);
      if (!lineText.trim()) {
        setTooltip(null);
        return;
      }

      const matches = engine.translateLine(lineText);
      if (matches.length === 0) {
        setTooltip(null);
        return;
      }

      const preview = buildLinePreview(lineText, matches);
      if (!preview) {
        setTooltip(null);
        return;
      }

      const rowTop = padY + row * cellH;
      const rowBottom = rowTop + cellH;
      // Suppress unused warning for localX — kept for future col-precision needs.
      void localX;
      setTooltip({ text: preview, rowTop, rowBottom });
    };

    const onLeave = () => {
      lastRowRef.current = -1;
      setTooltip(null);
    };

    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);
    return () => {
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseleave', onLeave);
    };
  }, [visible, xtermRef, xtermContainerRef, engine]);

  if (!visible || !tooltip) return null;

  const isDark = theme === 'dark';
  const bg = isDark ? 'rgba(26, 25, 23, 0.96)' : 'rgba(244, 243, 238, 0.98)';
  const fg = isDark ? '#e8e4de' : '#2d2c2a';
  const border = isDark ? '1px solid rgba(232, 228, 222, 0.15)' : '1px solid rgba(45, 44, 42, 0.15)';
  const shadow = isDark
    ? '0 6px 24px rgba(0, 0, 0, 0.5)'
    : '0 6px 24px rgba(0, 0, 0, 0.15)';

  // Decide above vs. below: if the hovered row is in the bottom third of the
  // container, anchor the tooltip above the row to avoid running off-screen.
  const container = xtermContainerRef.current;
  const containerH = container?.getBoundingClientRect().height ?? 0;
  const placeAbove = tooltip.rowBottom > containerH * 0.66;
  const top = placeAbove ? Math.max(0, tooltip.rowTop - 8) : tooltip.rowBottom + 4;
  const transform = placeAbove ? 'translateY(-100%)' : 'none';

  return (
    <div
      className="hover-translation-tooltip"
      style={{
        position: 'absolute',
        left: 24,
        right: 24,
        top,
        transform,
        pointerEvents: 'none',
        zIndex: 30,
        background: bg,
        color: fg,
        border,
        borderRadius: 8,
        boxShadow: shadow,
        padding: '8px 12px',
        fontSize: 13,
        lineHeight: 1.5,
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: '40%',
        overflow: 'hidden',
      }}
    >
      {tooltip.text}
    </div>
  );
}
