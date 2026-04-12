// coffee-renderer.ts — Coffee CLI A2 Shadow Terminal Renderer
// Architecture: A1 (xterm.js + PTY, hidden) → buffer read → translate → A2 (xterm.js, no PTY, visible)
// A2 uses the EXACT same WebGL rendering as A1 — zero rendering differences.
// No Canvas 2D, no manual box-drawing, no block-element geometry, no DPR hacks.
// xterm.js handles everything: box drawing, block elements, fonts, DPR — automatically.

import type { Terminal } from '@xterm/xterm';
import { translateLine, hasTranslations, findFullPattern } from './coffee-translation';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SelectionRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

// ─── ANSI Escape Helpers ────────────────────────────────────────────────────

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

/** Move cursor to (row, col) — 1-indexed */
function cursorTo(row: number, col: number): string {
  return `${ESC}${row};${col}H`;
}

/** Set foreground color from cell attributes */
function fgAnsi(cell: any): string {
  if (cell.isFgDefault()) return `${ESC}39m`;
  if (cell.isFgPalette()) {
    const c = cell.getFgColor();
    if (c < 8) return `${ESC}3${c}m`;
    if (c < 16) return `${ESC}9${c - 8}m`;
    return `${ESC}38;5;${c}m`;
  }
  if (cell.isFgRGB()) {
    const rgb = cell.getFgColor();
    return `${ESC}38;2;${(rgb >> 16) & 0xff};${(rgb >> 8) & 0xff};${rgb & 0xff}m`;
  }
  return '';
}

/** Set background color from cell attributes */
function bgAnsi(cell: any): string {
  if (cell.isBgDefault()) return `${ESC}49m`;
  if (cell.isBgPalette()) {
    const c = cell.getBgColor();
    if (c < 8) return `${ESC}4${c}m`;
    if (c < 16) return `${ESC}10${c - 8}m`;
    return `${ESC}48;5;${c}m`;
  }
  if (cell.isBgRGB()) {
    const rgb = cell.getBgColor();
    return `${ESC}48;2;${(rgb >> 16) & 0xff};${(rgb >> 8) & 0xff};${rgb & 0xff}m`;
  }
  return '';
}

/** Set text attributes (bold, italic, underline, dim) */
function attrsAnsi(cell: any): string {
  let s = '';
  if (cell.isBold() === 1) s += `${ESC}1m`;
  if (cell.isDim() === 1) s += `${ESC}2m`;
  if (cell.isItalic() === 1) s += `${ESC}3m`;
  if (cell.isUnderline() === 1) s += `${ESC}4m`;
  if (cell.isInverse() === 1) s += `${ESC}7m`;
  return s;
}

/**
 * Build a compact SGR key for a cell.
 * Used for lastSGR comparison — if key matches, skip redundant output.
 * When key differs we still emit RESET + full SGR (simpler than incremental diff
 * and correct for all attribute combinations including inverse/dim).
 */
function cellSGR(cell: any): string {
  return RESET + attrsAnsi(cell) + fgAnsi(cell) + bgAnsi(cell);
}

// ─── CJK Width Detection ───────────────────────────────────────────────────

function isCJKChar(ch: string): boolean {
  const code = ch.codePointAt(0) || 0;
  return (
    (code >= 0x2E80 && code <= 0x2FFF)  || // CJK Radicals
    (code >= 0x3000 && code <= 0x303F)  || // CJK Symbols & Punctuation
    (code >= 0x3040 && code <= 0x309F)  || // Hiragana
    (code >= 0x30A0 && code <= 0x30FF)  || // Katakana
    (code >= 0x3100 && code <= 0x312F)  || // Bopomofo
    (code >= 0x3130 && code <= 0x318F)  || // Hangul Compatibility Jamo
    (code >= 0x31A0 && code <= 0x31BF)  || // Bopomofo Extended
    (code >= 0x3400 && code <= 0x4DBF)  || // CJK Extension A
    (code >= 0x4E00 && code <= 0x9FFF)  || // CJK Unified Ideographs
    (code >= 0xAC00 && code <= 0xD7AF)  || // Hangul Syllables
    (code >= 0xF900 && code <= 0xFAFF)  || // CJK Compatibility Ideographs
    (code >= 0xFE30 && code <= 0xFE4F)  || // CJK Compatibility Forms
    (code >= 0xFF01 && code <= 0xFF60)  || // Fullwidth Latin & punctuation
    (code >= 0xFFE0 && code <= 0xFFE6)  || // Fullwidth symbols
    (code >= 0x20000 && code <= 0x2A6DF) || // CJK Extension B
    (code >= 0x2A700 && code <= 0x2CEAF)   // CJK Extensions C-F
  );
}

// ─── Shadow Terminal Renderer ───────────────────────────────────────────────

let _logged = false;

/**
 * Render the translation overlay by reading A1's buffer and writing
 * ANSI sequences to A2 (the shadow terminal).
 * 
 * A2 is a standalone xterm.js instance with NO PTY connection.
 * It uses the exact same WebGL rendering pipeline as A1, so box-drawing,
 * block elements, fonts, and DPR are all handled identically.
 */
export function renderToShadowTerminal(
  source: Terminal,
  target: Terminal,
): string {
  const buffer = source.buffer.active;
  const hasDict = hasTranslations();

  if (!_logged) {
    console.log('[CoffeeRenderer] A2 Shadow Terminal mode.', {
      rows: source.rows,
      cols: source.cols,
      hasDict,
    });
    _logged = true;
  }

  // Build the entire frame as one string, then write once (performance)
  let frame = '';

  // Hide cursor during redraw to avoid flicker
  frame += `${ESC}?25l`;

  // When a translation overflows the current line, xterm.js auto-wraps it to
  // the next line(s). We track how many columns were consumed by the overflow
  // so we can skip them when rendering subsequent rows.
  // NOTE: If a translation is extremely long and wraps across 2+ rows, the
  // overflow is consumed one row at a time (excess carries forward).
  let skipColsNextRow = 0;

  for (let row = 0; row < source.rows; row++) {
    const absRow = row + buffer.viewportY;
    const line = buffer.getLine(absRow);
    if (!line) continue;

    const lineText = line.translateToString(false);



    // Move cursor to start of this row (1-indexed).
    frame += cursorTo(row + 1, 1);

    // If previous row's translation overflowed into this row, skip those columns.
    // IMPORTANT: Do NOT ESC[2K here — it would erase the overflow content that
    // xterm.js auto-wrapped from the previous row's translation.
    let col = 0;
    if (skipColsNextRow > 0) {
      const skipOnThisRow = Math.min(skipColsNextRow, source.cols);
      col = skipOnThisRow;
      // Position cursor past the overflow area
      if (col < source.cols) {
        frame += cursorTo(row + 1, col + 1);
      }
      // Clear only from the skip position to end of line (preserve overflow text)
      frame += `${ESC}K`; // EL 0 = Erase from cursor to end of line
      // If overflow spans multiple rows, carry the remainder forward
      skipColsNextRow = skipColsNextRow - skipOnThisRow;
    } else {
      // No overflow — safe to erase entire line to prevent CJK ghosts.
      // CJK ghost fix: if previous frame wrote a 2-col wide char (e.g. "程")
      // and new frame writes 1-col ASCII over it, half of the old CJK glyph
      // remains visible. ESC[2K prevents this.
      frame += `${ESC}2K`; // EL 2 = Erase entire line
    }

    // Get translation matches for this line
    const matches = hasDict ? translateLine(lineText) : [];
    const matchMap = new Map<number, { translatedText: string; colEnd: number; originalText: string }>();
    for (const m of matches) {
      matchMap.set(m.colStart, { translatedText: m.translatedText, colEnd: m.colEnd, originalText: m.originalText });
    }



    // Track current SGR state to avoid redundant escape sequences
    let lastSGR = '';

    while (col < source.cols) {
      const cell = line.getCell(col);
      if (!cell) { col++; continue; }

      const match = matchMap.get(col);

      if (match) {
        // ── Translation match: output translated text with original cell styling ──
        const sgr = cellSGR(cell);
        if (sgr !== lastSGR) { frame += sgr; lastSGR = sgr; }

        const transText = match.translatedText;
        const matchCols = match.colEnd - col;
        const availColsOnThisRow = source.cols - col;

        // Calculate total column width of translated text
        let totalTransCols = 0;
        for (let ci = 0; ci < transText.length; ci++) {
          totalTransCols += isCJKChar(transText[ci]) ? 2 : 1;
        }

        // Detect prefix match early — needed for both overflow handling and cross-line skip.
        // A prefix match means the original English text was truncated at the line edge
        // (the terminal clipped the sentence mid-word). In that case the translation should
        // also clip at the right edge, not overflow to the next row.
        const fullPattern = findFullPattern(match.originalText);
        const isPrefixMatch = fullPattern !== null;

        if (totalTransCols <= matchCols) {
          // Translation fits within the original text space — write and pad
          frame += transText;
          // Pad with spaces if translation is shorter
          let padCols = matchCols - totalTransCols;
          while (padCols > 0) { frame += ' '; padCols--; }
        } else if (isPrefixMatch) {
          // Prefix match with a long translation: clip at the right edge.
          // The original English was truncated here (not a natural wrap), so the
          // translation should be truncated at the same visual boundary.
          let remainCols = availColsOnThisRow;
          for (let ci = 0; ci < transText.length; ci++) {
            const w = isCJKChar(transText[ci]) ? 2 : 1;
            if (remainCols < w) break;
            frame += transText[ci];
            remainCols -= w;
          }
          // No overflow skip from the translation — it was clipped cleanly.
        } else {
          // Full match, longer translation — let xterm.js auto-wrap!
          // Just write the full translated text. xterm.js will wrap to next line.
          frame += transText;

          // Calculate overflow for the TRANSLATION text wrapping to next line
          const overflowCols = totalTransCols - availColsOnThisRow;
          if (overflowCols > 0) {
            skipColsNextRow = overflowCols;
          }
        }

        // ── Cross-line skip: if the ORIGINAL ENGLISH text was auto-wrapped ──
        // by the terminal across multiple rows, we need to skip the English
        // continuation on the next row regardless of translation length.
        // Example: English wraps 2 rows, Chinese fits in 1 row → Row N+1's
        // English continuation must be skipped.
        if (fullPattern && fullPattern.length > match.originalText.length) {
          const nextLine = buffer.getLine(absRow + 1);
          if (nextLine) {
            const nextText = nextLine.translateToString(false);
            const remainPat = fullPattern.substring(match.originalText.length);
            const trimNext = nextText.trimStart();
            const leadSpaces = nextText.length - trimNext.length;
            const remPatTrim = remainPat.trimStart();

            // Check how many chars of the continuation match
            let mLen = 0;
            for (let i = 0; i < Math.min(remPatTrim.length, trimNext.length); i++) {
              if (remPatTrim[i] === trimNext[i]) mLen++;
              else break;
            }
            if (mLen >= 8 || mLen >= remPatTrim.length) {
              // Skip the English continuation on the next row.
              // Use Math.max to preserve any larger skip from translation overflow.
              skipColsNextRow = Math.max(skipColsNextRow, leadSpaces + mLen);
            }
          }
        }

        col = match.colEnd;
        continue;
      }

      // ── Original character: copy as-is with its styling ──
      const sgr = cellSGR(cell);
      if (sgr !== lastSGR) { frame += sgr; lastSGR = sgr; }

      const char = cell.getChars();
      const charWidth = cell.getWidth() || 1;

      if (char && char !== '\x00') {
        frame += char;
      } else {
        frame += ' ';
      }

      // For wide chars (CJK), the next cell is a "continuation" cell — skip it
      if (charWidth > 1) {
        col += charWidth;
      } else {
        col++;
      }
    }


  }

  // Reset SGR and show cursor
  frame += RESET;
  frame += `${ESC}?25h`;

  // Return the frame string — caller is responsible for writing it
  // to A2 at the right time (preventing write queue buildup).
  return frame;
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

// ─── Image Detection ────────────────────────────────────────────────────────

export interface InlineImage {
  id: string;
  row: number;
  colStart: number;
  colEnd: number;
  url: string;
}

const IMAGE_REGEX = /(?:[A-Za-z]:\\[\w\-. \\\\]+\.(?:png|jpg|jpeg|webp|gif|svg))|(?:\/[\w\-./]+\.(?:png|jpg|jpeg|webp|gif|svg))|https?:\/\/[^\s"'()]+?\.(?:png|jpg|jpeg|webp|gif|svg)/gi;

export function findInlineImages(term: Terminal): InlineImage[] {
  const images: InlineImage[] = [];
  const buffer = term.buffer.active;
  const startRow = buffer.viewportY;
  const endRow = startRow + term.rows - 1;

  for (let row = startRow; row <= endRow; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const text = line.translateToString(true);

    let match;
    IMAGE_REGEX.lastIndex = 0;
    while ((match = IMAGE_REGEX.exec(text)) !== null) {
      images.push({
        id: `img-${row}-${match.index}`,
        row,
        colStart: match.index,
        colEnd: match.index + match[0].length,
        url: match[0],
      });
    }
  }

  return images;
}
