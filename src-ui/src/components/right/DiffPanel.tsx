// DiffPanel.tsx — unified diff view for the right-side Changes tab.
// Shows baseline (session-start) vs. current content for the file the user
// clicked in ChangesBoard. Read-only audit view: no edit, no save.
//
// Step 4 wired in: i18n placeholders + Shiki syntax highlighting. The
// highlighter loads asynchronously (and the file's language grammar loads
// the first time we touch that extension) — diff text renders plain on
// first paint and re-renders with token colors once tokenization resolves.
// Theme tracks `data-theme` via MutationObserver so theme switches re-tint
// the tokens without a remount.

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { diffLines } from 'diff';
import { commands } from '../../tauri';
import { useT } from '../../i18n/useT';
import { useDataAttr } from '../../lib/use-data-attr';
import { tokenizeFile, getShikiTheme, type LineTokens } from '../../lib/shiki';
import './DiffPanel.css';

type DiffLine = {
  kind: 'add' | 'del' | 'eq';
  text: string;
  /** Line number in the file this row belongs to:
   *  - 'add' → new-file line number
   *  - 'del' → old-file line number
   *  - 'eq'  → either (we show new-file's). */
  lineNum: number;
  /** Pre-tokenized syntax-highlighted spans. Null until Shiki resolves;
   *  null also when the file's language isn't in LANG_MAP (plain text). */
  tokens: LineTokens | null;
};

type DiffResult =
  | { state: 'loading' }
  | { state: 'error'; reason: string }
  | { state: 'ok'; lines: DiffLine[]; added: number; deleted: number };

interface DiffPanelProps {
  sessionId: string;
  path: string;
  onClose: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Height percent (0-100) for the half-paper bottom overlay.
   *  Ignored in expanded mode (which uses fixed-inset modal sizing).
   *  When omitted, the CSS default (55%) applies. */
  heightPercent?: number;
}

export function DiffPanel({ sessionId, path, onClose, expanded, onToggleExpanded, heightPercent }: DiffPanelProps) {
  const t = useT();
  const dataTheme = useDataAttr('data-theme');
  const [result, setResult] = useState<DiffResult>({ state: 'loading' });

  // Keyboard handling — same DiffPanel element across two visual sizes:
  //   half (default): bottom-anchored overlay covering ~55% of the panel
  //   expanded: full-window portal (modal). Esc collapses expanded → half,
  //   then half → closes the diff entirely. So: Esc has a single, learnable
  //   meaning ("step back one zoom level"), unlike a UA toggle button.
  // In expanded mode we also blur the active element so keystrokes can't
  // leak into a focused Gambit textarea behind the dim layer.
  useEffect(() => {
    if (expanded) {
      (document.activeElement as HTMLElement | null)?.blur();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (expanded) onToggleExpanded();
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, onToggleExpanded, onClose]);

  useEffect(() => {
    let cancelled = false;
    setResult({ state: 'loading' });

    (async () => {
      try {
        const [baseline, current] = await Promise.all([
          commands.getBaselineContent(sessionId, path),
          commands.readTextFile(path),
        ]);
        if (cancelled) return;
        if (current === null) {
          setResult({ state: 'error', reason: 'unreadable' });
          return;
        }
        const oldText = baseline ?? '';
        const newText = current;
        const lines = computeUnifiedDiff(oldText, newText);
        const added = lines.filter(l => l.kind === 'add').length;
        const deleted = lines.filter(l => l.kind === 'del').length;

        // Tokenize BEFORE the first 'ok' render. Painting plain text first
        // and then swapping in Shiki tokens caused a visible color flip on
        // every file open — single-shot avoids that.
        const theme = getShikiTheme(dataTheme);
        const [oldTokens, newTokens] = await Promise.all([
          tokenizeFile(oldText, path, theme),
          tokenizeFile(newText, path, theme),
        ]);
        if (cancelled) return;

        const tokenized = (oldTokens || newTokens)
          ? lines.map(line => {
              const src = line.kind === 'del' ? oldTokens : newTokens;
              return { ...line, tokens: src?.[line.lineNum - 1] ?? null };
            })
          : lines;

        setResult({ state: 'ok', lines: tokenized, added, deleted });
      } catch {
        if (cancelled) return;
        setResult({ state: 'error', reason: 'ipc' });
      }
    })();

    return () => { cancelled = true; };
  }, [sessionId, path, dataTheme]);

  const basename = useMemo(() => path.replace(/\\/g, '/').split('/').pop() || path, [path]);

  const header = (
    <div className="diff-header">
      <span className="diff-header-name">{basename}</span>
      <div className="diff-header-actions">
        <button
          type="button"
          className="diff-header-btn"
          onClick={onToggleExpanded}
          aria-label={expanded ? 'Collapse diff' : 'Expand diff'}
        >
          {expanded ? '⤓' : '⤢'}
        </button>
        <button
          type="button"
          className="diff-header-btn"
          onClick={onClose}
          aria-label="Close diff"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
  );

  // Same DiffPanel element rendered at two different sizes:
  //   default: in-flow / parent-anchored overlay (bottom half of changes panel)
  //   expanded: portal to body, fixed-inset modal (full window)
  // Backdrop only appears in expanded mode (modal needs a dim+blocker).
  const panelStyle: CSSProperties | undefined =
    !expanded && typeof heightPercent === 'number'
      ? { height: `${heightPercent}%` }
      : undefined;
  const panel = (
    <div
      className={`diff-panel${expanded ? ' diff-panel--expanded' : ''}`}
      style={panelStyle}
    >
      {header}
      <div className="diff-body">
        {result.state === 'loading' && (
          <div className="diff-empty">{t('diff.loading' as any) || 'Loading…'}</div>
        )}
        {result.state === 'error' && (
          <div className="diff-empty">{t('diff.error' as any) || 'Failed to load diff'}</div>
        )}
        {result.state === 'ok' && result.lines.length === 0 && (
          <div className="diff-empty">{t('diff.no_changes' as any) || 'Identical to baseline'}</div>
        )}
        {result.state === 'ok' && result.lines.length > 0 && (
          <pre className="diff-pre">
            {result.lines.map((line, i) => (
              <div key={i} className={`diff-line diff-line-${line.kind}`}>
                <span className="diff-line-num">{line.lineNum}</span>
                <span className="diff-marker">
                  {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                </span>
                <span className="diff-text">
                  {line.tokens
                    ? line.tokens.map((tok, j) => (
                        <span key={j} style={{ color: tok.color }}>{tok.content}</span>
                      ))
                    : line.text}
                </span>
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );

  if (!expanded) return panel;
  return createPortal(
    <>
      <div className="diff-backdrop" onMouseDown={onToggleExpanded} />
      {panel}
    </>,
    document.body,
  );
}

// Convert two text blobs into a flat list of unified-diff lines. We don't
// emit @@ hunk headers — for an in-app audit panel users don't need
// summary headers, just the +/- flow with line numbers. jsdiff returns
// chunks (added/removed/eq); we flatten each into individual rows.
function computeUnifiedDiff(oldText: string, newText: string): DiffLine[] {
  const out: DiffLine[] = [];
  const parts = diffLines(oldText, newText);
  // Track each side's running line number. jsdiff doesn't expose these
  // (chunks are content-only), so we walk and increment per chunk type:
  // added → only new advances; removed → only old advances; eq → both.
  let oldLine = 1;
  let newLine = 1;
  for (const p of parts) {
    const lines = p.value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (p.added) {
      for (const text of lines) out.push({ kind: 'add', text, lineNum: newLine++, tokens: null });
    } else if (p.removed) {
      for (const text of lines) out.push({ kind: 'del', text, lineNum: oldLine++, tokens: null });
    } else {
      for (const text of lines) {
        out.push({ kind: 'eq', text, lineNum: newLine, tokens: null });
        oldLine++;
        newLine++;
      }
    }
  }
  return out;
}
