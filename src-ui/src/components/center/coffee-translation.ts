// coffee-translation.ts — Rendering-layer translation engine
// Matches full line text from xterm.js buffer against dictionary patterns.
// Used by CoffeeOverlay to render translated text via Canvas 2D.
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
let entries: TranslationEntry[] = [];
let isReady = false;

/**
 * Set the translation entries (called once at init from Tauri backend).
 */
export function setTranslationEntries(newEntries: TranslationEntry[]): void {
  // Sort by pattern length descending — longer (more specific) patterns first.
  // This prevents short patterns like "No" from stealing matches
  // that should go to "No recent activity".
  entries = [...newEntries].sort((a, b) => b.pattern.length - a.pattern.length);
  isReady = entries.length > 0;
}

/**
 * Check if the translation engine has entries loaded.
 */
export function hasTranslations(): boolean {
  return isReady;
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
export function translateLine(lineText: string): LineTranslation[] {
  if (!isReady || !lineText.trim()) return [];

  const results: LineTranslation[] = [];
  const used = new Uint8Array(lineText.length); // prevent overlapping matches

  for (const entry of entries) {
    const idx = lineText.indexOf(entry.pattern);
    if (idx === -1) continue;

    // Check no overlap with previous matches
    let overlap = false;
    for (let i = idx; i < idx + entry.pattern.length; i++) {
      if (used[i]) { overlap = true; break; }
    }
    if (overlap) continue;

    // Mark as used
    for (let i = idx; i < idx + entry.pattern.length; i++) {
      used[i] = 1;
    }

    results.push({
      colStart: idx,
      colEnd: idx + entry.pattern.length,
      translatedText: entry.translation,
      originalText: entry.pattern,
    });
  }

  return results;
}
