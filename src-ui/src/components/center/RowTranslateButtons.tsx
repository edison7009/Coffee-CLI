// RowTranslateButtons.tsx — Per-row LLM translate trigger overlay
//
// Renders a small DOM button to the LEFT of every visible row in the terminal.
// Click ▶ on an untranslated row → calls user's LLM → engine.addLLMEntries →
// per-row body cache invalidates → that row (and any matching row) renders
// translated on A2 next frame. Click ✗ on a translated row → removes the
// pattern from the engine → row reverts.
//
// Architecture note: this component does NOT render translations itself. It
// only triggers them. All actual rendering goes through the existing A2 +
// engine + per-row cache pipeline. That gives us:
//   - Zero duplication of rendering logic
//   - "Learning" effect for free: translating row 5 also translates row 12
//     if they contain the same text (engine entry matches anywhere)
//   - Untranslate is symmetric: removing the entry reverts every match
//
// The user is essentially teaching/unteaching the per-tab engine, one click
// at a time. After a short while the visible screen is a custom mix shaped
// by exactly what the user wanted to understand.

import { useEffect, useRef, useState, useCallback } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { TranslationEngine } from './coffee-translation';
import { loadLLMConfig, translateSegments } from './llm-translate';

interface RowTranslateButtonsProps {
  xtermRef: React.RefObject<Terminal | null>;
  xtermContainerRef: React.RefObject<HTMLDivElement | null>;
  engine: TranslationEngine;
  /** Render only when a translation language is active and tab is in foreground. */
  visible: boolean;
  /** Target language code for LLM translation (e.g. 'zh-CN'). */
  targetLang: string;
  theme: 'dark' | 'light';
}

interface RowState {
  row: number;          // 0-based viewport row
  top: number;          // pixel offset from container top
  height: number;       // row pixel height (= cellH)
  lineText: string;     // trimmed line content
  pattern: string;      // the dictionary pattern that currently translates this row, or ''
}

/**
 * Read xterm's CSS cell metrics + the .xterm element's padding so we can
 * convert (row index → pixel y). Returns null if xterm isn't ready.
 */
function readMetrics(term: Terminal, container: HTMLDivElement): { cellH: number; padY: number } | null {
  const core = (term as any)._core;
  const dims = core?._renderService?.dimensions;
  const cellH = dims?.css?.cell?.height;
  if (!cellH) return null;
  const xtermEl = container.querySelector('.xterm') as HTMLElement | null;
  const cs = xtermEl ? window.getComputedStyle(xtermEl) : null;
  const padY = cs ? parseFloat(cs.paddingTop) || 0 : 0;
  return { cellH, padY };
}

export function RowTranslateButtons({
  xtermRef,
  xtermContainerRef,
  engine,
  visible,
  targetLang,
  theme,
}: RowTranslateButtonsProps) {
  const [rows, setRows] = useState<RowState[]>([]);
  // Set of row indices currently waiting on the LLM. Used to show spinners.
  const [loading, setLoading] = useState<Set<number>>(new Set());
  // Per-row abort controllers so a fast second click can cancel an in-flight
  // request. Map keys are row indices.
  const abortMapRef = useRef<Map<number, AbortController>>(new Map());

  // ── Recompute row state from current xterm buffer ─────────────────────────
  const recompute = useCallback(() => {
    const term = xtermRef.current;
    const container = xtermContainerRef.current;
    if (!term || !container) {
      setRows([]);
      return;
    }
    const m = readMetrics(term, container);
    if (!m) {
      setRows([]);
      return;
    }

    const buffer = term.buffer.active;
    const next: RowState[] = [];
    for (let r = 0; r < term.rows; r++) {
      const line = buffer.getLine(r + buffer.viewportY);
      if (!line) continue;
      const lineText = line.translateToString(false).trimEnd();
      const trimmed = lineText.trim();
      // Skip empty rows and pure-symbol rows — no point translating box-drawing.
      if (trimmed.length < 4) continue;
      if (!/[a-zA-Z]/.test(trimmed)) continue;

      // Determine if any current dictionary entry already matches this line.
      // If so, the button shows the "✗ undo" state for the pattern that hit.
      // We only care about LLM-added entries here — dict matches from the
      // static dictionary aren't user-undoable.
      const matches = engine.translateLine(lineText);
      let pattern = '';
      if (matches.length > 0) {
        // Heuristic: if the largest match covers most of the trimmed line,
        // treat that as "this row is translated" and let the button undo it.
        // Otherwise leave pattern='' so the button is in ▶ mode (the user
        // can request a fuller LLM translation that supersedes the partial).
        const biggest = matches.reduce((a, b) =>
          (b.colEnd - b.colStart) > (a.colEnd - a.colStart) ? b : a
        );
        const coverage = (biggest.colEnd - biggest.colStart) / trimmed.length;
        if (coverage >= 0.6) pattern = biggest.originalText;
      }

      next.push({
        row: r,
        top: m.padY + r * m.cellH,
        height: m.cellH,
        lineText: trimmed,
        pattern,
      });
    }
    setRows(next);
  }, [xtermRef, xtermContainerRef, engine]);

  // ── Subscribe to xterm changes and recompute (debounced) ──────────────────
  useEffect(() => {
    if (!visible) {
      setRows([]);
      return;
    }
    const term = xtermRef.current;
    if (!term) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      // Slightly slower than A2 (50ms) because button re-render isn't perf-
      // critical and we want to absorb bursts of writes.
      timer = setTimeout(recompute, 120);
    };

    // Initial render once xterm is ready.
    schedule();

    const onWrite = term.onWriteParsed(schedule);
    const onScroll = term.onScroll(schedule);
    const onResize = term.onResize(schedule);

    return () => {
      if (timer) clearTimeout(timer);
      onWrite.dispose();
      onScroll.dispose();
      onResize.dispose();
    };
  }, [visible, xtermRef, recompute]);

  // ── Click handler ─────────────────────────────────────────────────────────
  const onClickRow = useCallback(async (rowState: RowState) => {
    // Untranslate path: row has an active LLM/dict pattern → drop it.
    if (rowState.pattern) {
      engine.removeLLMEntry(rowState.pattern);
      // Cancel any in-flight request for this row (rare but possible).
      const inflight = abortMapRef.current.get(rowState.row);
      if (inflight) {
        inflight.abort();
        abortMapRef.current.delete(rowState.row);
      }
      setLoading(prev => {
        if (!prev.has(rowState.row)) return prev;
        const next = new Set(prev);
        next.delete(rowState.row);
        return next;
      });
      // Trigger a recompute on the next tick so button state catches up
      // before the next debounced markDirty fires.
      setTimeout(recompute, 0);
      return;
    }

    // Translate path: needs LLM config.
    const config = loadLLMConfig();
    if (!config || !config.baseUrl || !config.apiKey) {
      // Soft signal: alert is jarring but we have no toast system here yet.
      // TODO: route through a proper notification once one exists.
      console.warn('[RowTranslateButtons] LLM not configured — open the FAB settings to add an API key.');
      return;
    }

    // Cancel any previous request for the same row before starting a new one.
    const existing = abortMapRef.current.get(rowState.row);
    if (existing) existing.abort();
    const abortCtrl = new AbortController();
    abortMapRef.current.set(rowState.row, abortCtrl);

    setLoading(prev => {
      const next = new Set(prev);
      next.add(rowState.row);
      return next;
    });

    try {
      // Build a single-element segment list. Reusing translateSegments gives
      // us the exact same code-aware system prompt the bulk FAB uses.
      const segment = { hash: '0', text: rowState.lineText };
      const entries = await translateSegments([segment], targetLang, config, abortCtrl.signal);
      if (entries.length > 0) {
        engine.addLLMEntries(entries);
        // Trigger a recompute so the button immediately switches to ✗ state
        // — without waiting for the next debounced xterm event.
        setTimeout(recompute, 0);
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.error('[RowTranslateButtons] LLM error:', err);
      }
    } finally {
      abortMapRef.current.delete(rowState.row);
      setLoading(prev => {
        if (!prev.has(rowState.row)) return prev;
        const next = new Set(prev);
        next.delete(rowState.row);
        return next;
      });
    }
  }, [engine, targetLang, recompute]);

  if (!visible || rows.length === 0) return null;

  const isDark = theme === 'dark';
  const fg = isDark ? 'rgba(232, 228, 222, 0.55)' : 'rgba(45, 44, 42, 0.55)';
  const fgHover = isDark ? '#e8e4de' : '#2d2c2a';
  const bg = isDark ? 'rgba(26, 25, 23, 0.7)' : 'rgba(244, 243, 238, 0.85)';

  return (
    <div
      className="row-translate-buttons"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 30,
      }}
    >
      {rows.map(r => {
        const isLoading = loading.has(r.row);
        const isUndo = !!r.pattern;
        return (
          <button
            key={r.row}
            type="button"
            onClick={() => onClickRow(r)}
            title={isUndo ? 'Revert translation' : 'Translate this line with LLM'}
            style={{
              position: 'absolute',
              left: 4,
              top: r.top + (r.height - 16) / 2,
              width: 16,
              height: 16,
              padding: 0,
              border: 'none',
              borderRadius: 4,
              background: bg,
              color: fg,
              cursor: 'pointer',
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: 0.35,
              transition: 'opacity 0.12s, color 0.12s, transform 0.12s',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.opacity = '1';
              (e.currentTarget as HTMLButtonElement).style.color = fgHover;
              (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.15)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.opacity = '0.35';
              (e.currentTarget as HTMLButtonElement).style.color = fg;
              (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)';
            }}
          >
            {isLoading ? (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83">
                  <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
                </path>
              </svg>
            ) : isUndo ? (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}
