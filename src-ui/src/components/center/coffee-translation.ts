// coffee-translation.ts — Rendering-layer translation engine
// Matches full line text from xterm.js buffer against dictionary patterns.
// Used by CoffeeOverlay to feed translated ANSI sequences into A2 (shadow terminal).
//
// Each TierTerminal owns its own TranslationEngine instance so that multi-tab
// scenarios (Claude Code + OpenCode + Codex side-by-side, possibly in different
// languages) don't clobber each other's dictionaries.

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
 * Per-instance translation engine. One engine per TierTerminal / CoffeeOverlay pair.
 * Holds static (dictionary) entries and LLM-generated entries independently,
 * merges them on demand, and exposes the matching API used by coffee-renderer.
 */
export class TranslationEngine {
  private staticEntries: TranslationEntry[] = [];
  private llmEntries: TranslationEntry[] = [];
  private entries: TranslationEntry[] = [];
  private ready = false;
  /**
   * Monotonically increasing version counter. Bumped on every mutation so that
   * downstream caches (e.g. coffee-renderer's per-row body cache) can detect
   * dictionary changes and invalidate themselves.
   */
  generation = 0;

  /** Replace the static dictionary entries (from Tauri backend). */
  setStaticEntries(newEntries: TranslationEntry[]): void {
    this.staticEntries = newEntries.slice();
    this.rebuild();
  }

  /** Replace the LLM-generated entries. */
  setLLMEntries(newEntries: TranslationEntry[]): void {
    this.llmEntries = newEntries.slice();
    this.rebuild();
  }

  /** Drop only the LLM entries; keep the static dictionary. */
  clearLLMEntries(): void {
    this.llmEntries = [];
    this.rebuild();
  }

  hasTranslations(): boolean {
    return this.ready;
  }

  /**
   * Find the full pattern string that starts with the given prefix.
   * Used by the renderer to detect multi-line spillover: when a pattern
   * is truncated by the terminal, we need the full pattern to match
   * its continuation on the next line.
   */
  findFullPattern(prefix: string): string | null {
    if (!prefix || prefix.length < 8) return null;
    for (const entry of this.entries) {
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
  translateLine(lineText: string): LineTranslation[] {
    if (!this.ready || !lineText.trim()) return [];

    const results: LineTranslation[] = [];
    const used = new Uint8Array(lineText.length); // prevent overlapping matches

    for (const entry of this.entries) {
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
          if (matched >= 15 && anchorIdx + matched >= trimmed.length - 3) {
            idx = anchorIdx;
            matchLen = matched;
          }
        }
      }

      if (idx === -1) continue;

      let overlap = false;
      for (let i = idx; i < idx + matchLen; i++) {
        if (used[i]) { overlap = true; break; }
      }
      if (overlap) continue;

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

  /** Merge static + LLM entries, dedupe by pattern, sort by length descending. */
  private rebuild(): void {
    const seen = new Set<string>();
    const merged: TranslationEntry[] = [];
    // LLM entries first (higher priority)
    for (const e of this.llmEntries) {
      if (!seen.has(e.pattern)) {
        seen.add(e.pattern);
        merged.push(e);
      }
    }
    for (const e of this.staticEntries) {
      if (!seen.has(e.pattern)) {
        seen.add(e.pattern);
        merged.push(e);
      }
    }
    // Longer (more specific) patterns win.
    this.entries = merged.sort((a, b) => b.pattern.length - a.pattern.length);
    this.ready = this.entries.length > 0;
    this.generation++;
  }
}

/**
 * Fuzzy whitespace-tolerant matching.
 * Ink/React-terminal frameworks inject extra spaces via CSI cursor positioning.
 * This matcher walks lineText and pattern simultaneously, skipping extra spaces
 * in lineText while requiring all non-space characters to match exactly.
 */
function fuzzyWhitespaceMatch(
  lineText: string,
  pattern: string,
): { start: number; end: number } | null {
  const firstWord = pattern.split(/\s+/)[0];
  if (!firstWord || !lineText.includes(firstWord)) return null;

  let searchFrom = 0;
  while (true) {
    const anchor = lineText.indexOf(firstWord, searchFrom);
    if (anchor === -1) break;
    searchFrom = anchor + 1;

    let li = anchor;
    let pi = 0;
    let extraSpaces = 0;

    while (li < lineText.length && pi < pattern.length) {
      if (lineText[li] === pattern[pi]) {
        li++;
        pi++;
      } else if (lineText[li] === ' ' && pattern[pi] !== ' ') {
        li++;
        extraSpaces++;
        if (extraSpaces > pattern.length * 0.3) break;
      } else {
        break;
      }
    }

    if (pi >= pattern.length) {
      return { start: anchor, end: li };
    }
  }

  return null;
}
