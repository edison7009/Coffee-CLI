// coffee-translation.ts — Rendering-layer translation engine
// Matches full line text from xterm.js buffer against dictionary patterns.
// Used by CoffeeOverlay to feed translated ANSI sequences into A2 (shadow terminal).
//
// This enables SENTENCE-LEVEL translation that the VT stream layer cannot do,
// because Ink renders words with absolute cursor positioning (CSI).
// At the xterm.js buffer level, all characters are in their final positions
// and we can read complete lines.

export interface TranslationEntry {
  pattern: string;       // Original English text (exact match)
  translation: string;   // Translated text
}

export interface LineTranslation {
  /** Column where the matched text starts */
  colStart: number;
  /** Column where the matched text ends (exclusive) */
  colEnd: number;
  /** The translated text to render */
  translatedText: string;
  /** The original matched text */
  originalText: string;
}

/**
 * Translation dictionary loaded from the Rust backend.
 * Keyed by tool name for quick lookup.
 */
let staticEntries: TranslationEntry[] = [];
let llmEntries: TranslationEntry[] = [];
let entries: TranslationEntry[] = [];
let isReady = false;

/** Rebuild merged entries from both sources */
function rebuildEntries(): void {
  // Merge: LLM entries + static entries, deduplicated by pattern
  const seen = new Set<string>();
  const merged: TranslationEntry[] = [];
  // LLM entries first (higher priority)
  for (const e of llmEntries) {
    if (!seen.has(e.pattern)) {
      seen.add(e.pattern);
      merged.push(e);
    }
  }
  // Then static entries
  for (const e of staticEntries) {
    if (!seen.has(e.pattern)) {
      seen.add(e.pattern);
      merged.push(e);
    }
  }
  // Sort by pattern length descending — longer (more specific) patterns first.
  entries = merged.sort((a, b) => b.pattern.length - a.pattern.length);
  isReady = entries.length > 0;
}

/**
 * Set the static translation entries (called from Tauri backend dictionary).
 */
export function setTranslationEntries(newEntries: TranslationEntry[]): void {
  staticEntries = [...newEntries];
  rebuildEntries();
}

/**
 * Set LLM-generated translation entries (persists independently from static dict).
 */
export function setLLMTranslationEntries(newEntries: TranslationEntry[]): void {
  llmEntries = [...newEntries];
  rebuildEntries();
}

/**
 * Clear only LLM translation entries (static dict stays).
 */
export function clearLLMTranslationEntries(): void {
  llmEntries = [];
  rebuildEntries();
}

/**
 * Check if the translation engine has entries loaded.
 */
export function hasTranslations(): boolean {
  return isReady;
}

/**
 * Find the full pattern string that starts with the given prefix.
 * Used by the renderer to detect multi-line spillover: when a pattern
 * is truncated by the terminal, we need the full pattern to match
 * its continuation on the next line.
 */
export function findFullPattern(prefix: string): string | null {
  if (!prefix || prefix.length < 8) return null;
  for (const entry of entries) {
    if (entry.pattern.startsWith(prefix) && entry.pattern.length > prefix.length) {
      return entry.pattern;
    }
  }
  return null;
}

/**
 * Translate a single buffer line text.
 * Returns all translation matches found within the line.
 *
 * Matching strategy:
 * - Check if any pattern appears as a substring of the line
 * - Longer patterns are checked first (more specific = higher priority)
 * - Each character position can only be matched once
 */

/**
 * Fuzzy whitespace-tolerant matching.
 * Ink/React-terminal frameworks inject extra spaces via CSI cursor positioning.
 * This matcher walks lineText and pattern simultaneously, skipping extra spaces
 * in lineText while requiring all non-space characters to match exactly.
 *
 * Returns { start, end } in lineText coordinates, or null if no match.
 */
function fuzzyWhitespaceMatch(
  lineText: string,
  pattern: string,
): { start: number; end: number } | null {
  // Quick rejection: pattern's first non-space word must exist in line
  const firstWord = pattern.split(/\s+/)[0];
  if (!firstWord || !lineText.includes(firstWord)) return null;

  // Try each occurrence of the first word as a start position
  let searchFrom = 0;
  while (true) {
    const anchor = lineText.indexOf(firstWord, searchFrom);
    if (anchor === -1) break;
    searchFrom = anchor + 1;

    // Walk both strings from the anchor
    let li = anchor; // lineText index
    let pi = 0;      // pattern index
    let extraSpaces = 0;

    while (li < lineText.length && pi < pattern.length) {
      if (lineText[li] === pattern[pi]) {
        li++;
        pi++;
      } else if (lineText[li] === ' ' && pattern[pi] !== ' ') {
        // Extra space in lineText — skip it (Ink column gap)
        li++;
        extraSpaces++;
        if (extraSpaces > pattern.length * 0.3) break; // too many extras = bad match
      } else {
        break; // character mismatch
      }
    }

    // Success if we consumed the entire pattern
    if (pi >= pattern.length) {
      return { start: anchor, end: li };
    }
  }

  return null;
}

export function translateLine(lineText: string): LineTranslation[] {
  if (!isReady || !lineText.trim()) return [];

  const results: LineTranslation[] = [];
  const used = new Uint8Array(lineText.length); // prevent overlapping matches

  for (const entry of entries) {
    let idx = lineText.indexOf(entry.pattern);
    let matchLen = entry.pattern.length;

    // Fuzzy whitespace fallback: Ink/React-terminal frameworks use CSI cursor
    // positioning to lay out menu columns, which can inject extra spaces into
    // the xterm.js buffer (e.g. "uncommitt ed" instead of "uncommitted").
    // If exact match fails, try matching while tolerating whitespace differences.
    if (idx === -1 && entry.pattern.length >= 10) {
      const result = fuzzyWhitespaceMatch(lineText, entry.pattern);
      if (result) {
        idx = result.start;
        matchLen = result.end - result.start;
      }
    }

    // Prefix fallback: if the pattern's beginning matches text near the line end,
    // assume the text was truncated by the terminal. In A2 shadow mode this is
    // safe — we render everything ourselves, no fragment collision possible.
    // Requires: pattern >= 15 chars, matched prefix >= 15 consecutive chars,
    //           and the match extends to within 3 chars of line end.
    if (idx === -1 && entry.pattern.length >= 15) {
      const trimmed = lineText.trimEnd();
      const anchor = entry.pattern.substring(0, 8);
      const anchorIdx = lineText.indexOf(anchor);
      if (anchorIdx !== -1) {
        let matched = 0;
        const searchLen = Math.min(entry.pattern.length, trimmed.length - anchorIdx);
        for (let i = 0; i < searchLen; i++) {
          if (lineText[anchorIdx + i] === entry.pattern[i]) matched++;
          else break;
        }
        // At least 15 consecutive chars matched AND extends to near line end
        if (matched >= 15 && anchorIdx + matched >= trimmed.length - 3) {
          idx = anchorIdx;
          matchLen = matched; // Only cover actually matched characters
        }
      }
    }

    if (idx === -1) continue;

    // Check no overlap with previous matches
    let overlap = false;
    for (let i = idx; i < idx + matchLen; i++) {
      if (used[i]) { overlap = true; break; }
    }
    if (overlap) continue;

    // Mark as used
    for (let i = idx; i < idx + matchLen; i++) {
      used[i] = 1;
    }

    results.push({
      colStart: idx,
      colEnd: idx + matchLen,
      translatedText: entry.translation,
      originalText: lineText.substring(idx, idx + matchLen),
    });
  }

  return results;
}
