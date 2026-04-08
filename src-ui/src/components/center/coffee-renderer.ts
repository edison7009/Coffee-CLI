// coffee-renderer.ts — Coffee CLI Overlay Renderer
// Reads xterm.js buffer → extracts cell metrics → renders translation patches only.
// xterm.js handles ALL normal rendering (WebGL). This overlay ONLY paints
// translated text over specific regions, keeping everything else transparent.

import type { Terminal } from '@xterm/xterm';
import { translateLine, hasTranslations } from './coffee-translation';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RendererConfig {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  devicePixelRatio: number;
  theme: {
    background: string;
    foreground: string;
    cursor: string;
    palette: string[];
  };
}

export interface SelectionRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

// ─── Default ANSI Palette ────────────────────────────────────────────────────

const DARK_PALETTE = [
  '#1a1917', '#e07070', '#7ec77e', '#d4a846',
  '#78a8d4', '#b07cc6', '#5fc4c0', '#e8e4de',
  '#6b6762', '#ff8888', '#98e698', '#f0c060',
  '#90c0f0', '#d090e0', '#80e0dc', '#ffffff',
];

const LIGHT_PALETTE = [
  '#2d2c2a', '#cc3333', '#2d7a2d', '#8a6000',
  '#2952a3', '#7a3d8a', '#1a6b6b', '#f4f3ee',
  '#9e9c98', '#ee5555', '#3d9a3d', '#a08020',
  '#4070c0', '#9060a0', '#2a8a8a', '#ffffff',
];

export function createConfig(isDark: boolean): RendererConfig {
  return {
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
    fontSize: 14,
    lineHeight: 1.3,
    devicePixelRatio: window.devicePixelRatio || 1,
    theme: {
      background: isDark ? '#1a1917' : '#f4f3ee',
      foreground: isDark ? '#e8e4de' : '#2d2c2a',
      cursor: '#c4956a',
      palette: isDark ? DARK_PALETTE : LIGHT_PALETTE,
    },
  };
}

// ─── Cell Metrics ───────────────────────────────────────────────────────────

export interface CellMetrics {
  cellWidth: number;
  cellHeight: number;
  /** x offset where the character grid starts (xterm.js internal padding) */
  offsetX: number;
  /** y offset where the character grid starts */
  offsetY: number;
}

/**
 * Compute cell metrics from the terminal's actual rendering.
 * Finds the .xterm-screen element for exact pixel alignment with xterm.js.
 */
export function computeCellMetrics(term: Terminal, container: HTMLElement): CellMetrics {
  // Find the actual xterm-screen element where characters are rendered
  const screenEl = container.querySelector('.xterm-screen') as HTMLElement | null;

  // Try xterm.js internal dimensions (most accurate cell size)
  const core = (term as any)._core;
  const dims = core?._renderService?.dimensions;

  let cellWidth: number;
  let cellHeight: number;

  if (dims?.css?.cell?.width && dims?.css?.cell?.height) {
    cellWidth = dims.css.cell.width;
    cellHeight = dims.css.cell.height;
  } else if (screenEl) {
    // Fallback: compute from screen element size
    const screenRect = screenEl.getBoundingClientRect();
    cellWidth = screenRect.width / term.cols;
    cellHeight = screenRect.height / term.rows;
  } else {
    // Last resort fallback
    const rect = container.getBoundingClientRect();
    cellWidth = rect.width / term.cols;
    cellHeight = rect.height / term.rows;
  }

  // Compute offset: position of xterm-screen relative to the overlay's parent
  // The overlay Canvas is positioned inside .tier-terminal (position: relative),
  // so we need the offset from .tier-terminal to .xterm-screen.
  let offsetX = 0;
  let offsetY = 0;

  if (screenEl) {
    const screenRect = screenEl.getBoundingClientRect();
    const parentEl = container.closest('.tier-terminal') as HTMLElement | null;
    if (parentEl) {
      const parentRect = parentEl.getBoundingClientRect();
      offsetX = screenRect.left - parentRect.left;
      offsetY = screenRect.top - parentRect.top;
    }
  }

  return { cellWidth, cellHeight, offsetX, offsetY };
}

// ─── Color Resolver ─────────────────────────────────────────────────────────

function resolveColor(
  colorMode: number,
  color: number,
  isDefault: boolean,
  palette: string[],
  fallback: string
): string {
  if (isDefault) return fallback;

  if (colorMode === 1) {
    if (color < 16 && color < palette.length) return palette[color];
    if (color >= 16 && color <= 231) {
      const idx = color - 16;
      const r = Math.floor(idx / 36) * 51;
      const g = Math.floor((idx % 36) / 6) * 51;
      const b = (idx % 6) * 51;
      return `rgb(${r},${g},${b})`;
    }
    if (color >= 232 && color <= 255) {
      const gray = (color - 232) * 10 + 8;
      return `rgb(${gray},${gray},${gray})`;
    }
    return fallback;
  }

  if (colorMode === 2) {
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    return `rgb(${r},${g},${b})`;
  }

  return fallback;
}

// ─── Translation Overlay Rendering ──────────────────────────────────────────

let _metricsLogged = false;

function getCellStyle(line: any, col: number, config: RendererConfig, palette: string[]) {
  let fg = config.theme.foreground;
  let bg = config.theme.background;
  let isBold = false;
  let isItalic = false;

  if (col < line.length) {
    const cell = line.getCell(col);
    if (cell) {
      if (cell.isFgDefault()) fg = config.theme.foreground;
      else if (cell.isFgPalette()) fg = resolveColor(1, cell.getFgColor(), false, palette, fg);
      else if (cell.isFgRGB()) {
          const rgb = cell.getFgColor();
          fg = `rgb(${(rgb >> 16) & 0xff},${(rgb >> 8) & 0xff},${rgb & 0xff})`;
      }
      
      if (cell.isBgDefault()) bg = config.theme.background;
      else if (cell.isBgPalette()) bg = resolveColor(1, cell.getBgColor(), false, palette, bg);
      else if (cell.isBgRGB()) {
          const rgb = cell.getBgColor();
          bg = `rgb(${(rgb >> 16) & 0xff},${(rgb >> 8) & 0xff},${rgb & 0xff})`;
      }

      isBold = cell.isBold() === 1;
      isItalic = cell.isItalic() === 1;
    }
  }
  return { fg, bg, isBold, isItalic };
}

/**
 * Render translation patches via cluster-based smart reflow.
 * Clusters are groups of characters separated by 4+ spaces.
 * Right-aligned clusters are kept right-aligned after translation.
 */
export function renderTranslationOverlay(
  term: Terminal,
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  config: RendererConfig,
  metrics: CellMetrics,
): void {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  if (!hasTranslations()) return;

  const buffer = term.buffer.active;
  const { cellWidth, cellHeight, offsetX, offsetY } = metrics;

  if (!_metricsLogged) {
    console.log('[CoffeeOverlay] Cell metrics:', {
      cellWidth: cellWidth.toFixed(2),
      cellHeight: cellHeight.toFixed(2),
      offsetX: offsetX.toFixed(2),
      offsetY: offsetY.toFixed(2),
      rows: term.rows,
      cols: term.cols,
      viewportY: buffer.viewportY,
    });
    _metricsLogged = true;
  }

  for (let row = 0; row < term.rows; row++) {
    const line = buffer.getLine(row + buffer.viewportY);
    if (!line) continue;

    const lineText = line.translateToString(false);
    const matches = translateLine(lineText);
    if (matches.length === 0) continue;

    // ── 1. Identify Visual Clusters ─────────────────────────────────────
    const clusters: { start: number, end: number }[] = [];
    let inCluster = false;
    let clusterStart = 0;
    let spaceCount = 0;

    for (let c = 0; c < lineText.length; c++) {
      const ch = lineText[c];
      if (ch === ' ' || ch === '\t') {
        spaceCount++;
        if (spaceCount >= 4 && inCluster) {
          clusters.push({ start: clusterStart, end: c - spaceCount + 1 });
          inCluster = false;
        }
      } else if (ch === '│' || ch === '─' || ch === '╭' || ch === '╮' || ch === '╰' || ch === '╯' || ch === '┬' || ch === '┴' || ch === '├' || ch === '┤') {
        if (inCluster) {
          clusters.push({ start: clusterStart, end: c - spaceCount });
          inCluster = false;
        }
        spaceCount = 0;
      } else {
        if (!inCluster) {
          inCluster = true;
          clusterStart = c;
        }
        spaceCount = 0;
      }
    }
    if (inCluster) {
      clusters.push({ start: clusterStart, end: lineText.length - spaceCount });
    }

    // ── 2. Process Each Cluster ─────────────────────────────────────────
    for (const cluster of clusters) {
      const clusterMatches = matches.filter(m => m.colStart >= cluster.start && m.colStart < cluster.end);
      if (clusterMatches.length === 0) continue;

      let i = cluster.start;
      const chunks: { text: string, fg: string, bg: string, isBold: boolean, isItalic: boolean, width?: number }[] = [];

      while (i < cluster.end) {
        const match = clusterMatches.find(m => m.colStart === i);
        if (match) {
          const cStyle = getCellStyle(line, i, config, config.theme.palette);
          chunks.push({ text: match.translatedText, ...cStyle });
          i += match.originalText.length;
        } else {
          let nextI = cluster.end;
          for (const m of clusterMatches) {
            if (m.colStart > i && m.colStart < nextI) nextI = m.colStart;
          }
          let currentStyle = getCellStyle(line, i, config, config.theme.palette);
          let runStr = lineText[i];
          for (let j = i + 1; j < nextI; j++) {
            const s = getCellStyle(line, j, config, config.theme.palette);
            if (s.fg !== currentStyle.fg || s.bg !== currentStyle.bg || s.isBold !== currentStyle.isBold) {
              chunks.push({ text: runStr, ...currentStyle });
              currentStyle = s;
              runStr = lineText[j];
            } else {
              runStr += lineText[j];
            }
          }
          chunks.push({ text: runStr, ...currentStyle });
          i = nextI;
        }
      }

      // ── 3. Measure ────────────────────────────────────────────────────
      let totalW = 0;
      for (const chunk of chunks) {
        const w = chunk.isBold ? '700' : '400';
        const fs = chunk.isItalic ? 'italic' : 'normal';
        ctx.font = `${fs} ${w} ${config.fontSize}px ${config.fontFamily}`;
        chunk.width = ctx.measureText(chunk.text).width;
        totalW += chunk.width;
      }

      // ── 4. Layout ─────────────────────────────────────────────────────
      const y = offsetY + row * cellHeight;
      const origX = offsetX + cluster.start * cellWidth;
      const origPixelW = (cluster.end - cluster.start) * cellWidth;
      const origRight = origX + origPixelW;

      let startX = origX;
      if (cluster.end >= term.cols - 4) {
        startX = origRight - totalW;
      } else {
        const termRight = offsetX + term.cols * cellWidth;
        if (origX + totalW > termRight) {
          startX = Math.max(offsetX, termRight - totalW);
        }
      }
      if (startX < offsetX) startX = offsetX;

      const clearX = Math.min(origX, startX);
      const clearW = Math.max(origRight, startX + totalW) - clearX;
      ctx.fillStyle = config.theme.background;
      ctx.fillRect(clearX, y, clearW, cellHeight);

      // ── 5. Paint ──────────────────────────────────────────────────────
      let currentX = startX;
      const textY = y + (cellHeight - config.fontSize) / 2;
      for (const chunk of chunks) {
        if (chunk.bg !== config.theme.background) {
          ctx.fillStyle = chunk.bg;
          ctx.fillRect(currentX, y, chunk.width!, cellHeight);
        }
        ctx.fillStyle = chunk.fg;
        const w = chunk.isBold ? '700' : '400';
        const fs = chunk.isItalic ? 'italic' : 'normal';
        ctx.font = `${fs} ${w} ${config.fontSize}px ${config.fontFamily}`;
        ctx.textBaseline = 'top';
        ctx.fillText(chunk.text, currentX, textY);
        currentX += chunk.width!;
      }
    }
  }
}

// ─── Selection ──────────────────────────────────────────────────────────────

export function getSelectedText(term: Terminal, sel: SelectionRange): string {
  const buffer = term.buffer.active;
  let text = '';
  const startRow = Math.min(sel.startRow, sel.endRow);
  const endRow = Math.max(sel.startRow, sel.endRow);

  for (let row = startRow; row <= endRow; row++) {
    const line = buffer.getLine(row + buffer.viewportY);
    if (!line) continue;

    const lineText = line.translateToString(true);
    if (startRow === endRow) {
      const sc = Math.min(sel.startCol, sel.endCol);
      const ec = Math.max(sel.startCol, sel.endCol);
      text += lineText.substring(sc, ec);
    } else if (row === startRow) {
      text += lineText.substring(sel.startCol) + '\n';
    } else if (row === endRow) {
      text += lineText.substring(0, sel.endCol);
    } else {
      text += lineText + '\n';
    }
  }

  return text;
}
