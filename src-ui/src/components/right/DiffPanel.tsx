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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
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

/** A rendered row in the collapsed (hunk) view: either a single diff line,
 *  or a "gap" standing in for a run of unchanged lines folded away. The gap
 *  carries its hidden lines so expanding it is a pure render-time toggle —
 *  no recompute, no re-tokenize. */
type DiffRow =
  | { type: 'line'; line: DiffLine }
  | { type: 'gap'; key: string; lines: DiffLine[] };

type DiffResult =
  | { state: 'loading' }
  | { state: 'error'; reason: string }
  | { state: 'too_large'; added: number; deleted: number }
  | { state: 'ok'; rows: DiffRow[]; added: number; deleted: number };

// Render guards. Past these a per-line diff is both unhelpful and a
// main-thread hazard: computeUnifiedDiff allocates one object per line and
// Shiki tokenizes BOTH full texts, so a multi-MB file — a lockfile, a
// minified bundle, or any file whose baseline content was never stored
// (oldText '' → the whole file renders as additions, nothing to fold) —
// would freeze the UI the instant it opens. Above either threshold we show
// a summary card instead.
//
// DIFF_MAX_BYTES limits the combined UTF-8 text after reading, before diffing
// and tokenizing. DIFF_MAX_CHANGED_LINES can reject huge rewrites earlier
// when the git badge already provides their change counts.
const DIFF_MAX_BYTES = 1_000_000;
const DIFF_MAX_CHANGED_LINES = 5000;

// Unchanged-line folding (hunk view). Runs of equal lines far from any
// change collapse to one clickable gap, so a 2-line edit in a 3000-line
// file renders ~10 rows instead of 3000 (DOM nodes are the real cost once
// the size guards above let a diff through). CONTEXT lines are kept on each
// side of every change for orientation; a run is folded only when it would
// hide at least MIN_HIDDEN lines — folding 1-2 lines just swaps rows for a
// marker of equal height and saves nothing.
const DIFF_CONTEXT_LINES = 3;
const DIFF_COLLAPSE_MIN_HIDDEN = 4;

interface DiffPanelProps {
  /** Absolute on-disk path — used for the header basename, Shiki language
   *  detection, and reading the working-tree "new" side. */
  path: string;
  /** Repository root (from git_changes) — the dir all `git show` specs
   *  resolve against. */
  repoRoot: string;
  /** Repo-relative path — the rel used in `HEAD:rel` / `:rel` specs. */
  rel: string;
  /** Which group the row belongs to — picks the old/new git specs:
   *  - 'uncommitted' → old `HEAD:rel`,   new = working file (HEAD↔worktree)
   *  - 'untracked'   → old `""`,          new = working file (no git blob)
   *  - 'committed'   → old `HEAD~1:rel`,  new = `HEAD:rel` (last commit's diff) */
  kind: 'uncommitted' | 'untracked' | 'committed';
  /** Commit hash to diff against for `kind === 'committed'` (default HEAD).
   *  A session commit passes its hash so the diff is <hash>~1↔<hash> instead
   *  of HEAD~1↔HEAD. */
  commitHash?: string;
  onClose: () => void;
  /** Which surface this panel renders on:
   *  - 'overlay' = right-bottom half-height (anchored inside ChangesBoard)
   *  - 'tab'     = center tab, fills the panel area (mounted by CenterPanel) */
  mode: 'overlay' | 'tab';
  /** Expand the overlay to a center tab, or (in tab mode) fold back to the
   *  overlay. The glyph swaps per mode: overlay shows ⤢ (expand), tab shows
   *  the "fold to bottom-right" glyph. */
  onToggleExpanded: () => void;
  /** Height percent (0-100) for the half-paper bottom overlay.
   *  Ignored in expanded mode (which uses fixed-inset modal sizing).
   *  When omitted, the CSS default (55%) applies. */
  heightPercent?: number;
  /** Change magnitude from the git numstat badge. Short-circuits the render
   *  for very large diffs before the expensive jsdiff + Shiki pass, and
   *  labels the summary card when we do. */
  added?: number;
  deleted?: number;
}

export function DiffPanel({ path, repoRoot, rel, kind, commitHash, onClose, mode, onToggleExpanded, heightPercent, added, deleted }: DiffPanelProps) {
  const t = useT();
  const dataTheme = useDataAttr('data-theme');
  const [result, setResult] = useState<DiffResult>({ state: 'loading' });
  // `expanded` (tab mode) is the legacy name kept locally so the keyboard +
  // sizing logic below reads as before; the prop surface is `mode`.
  const expanded = mode === 'tab';

  // Latest badge counts (Rust multiset deltas), mirrored into a ref so the
  // open-time size guard can read them WITHOUT the load effect depending on
  // them. They are live-polled from filesystem refreshes while an agent edits
  // the open file, so as effect deps they
  // blanked the diff to 'loading' and re-ran both IPC reads + double Shiki
  // tokenization on every tick. The guard only needs the value at open time.
  const badgeRef = useRef({ added: 0, deleted: 0 });
  useEffect(() => {
    badgeRef.current = { added: added ?? 0, deleted: deleted ?? 0 };
  }, [added, deleted]);

  // Which folded gaps the user has expanded in place. Keyed by gap.key
  // (stable per file). Reset when the file changes so a new diff starts
  // fully folded.
  const [expandedGaps, setExpandedGaps] = useState<Set<string>>(() => new Set());
  useEffect(() => { setExpandedGaps(new Set()); }, [path]);
  const toggleGap = (key: string) =>
    setExpandedGaps(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Keyboard handling. Esc = step back one level:
  //   overlay mode → close the diff entirely (onClose → CLEAR_DIFF).
  //   tab mode     → close the diff entirely too.
  // Previously tab-mode Esc folded back to the overlay, but the overlay only
  // mounts when the right panel is visible AND on the Changes tab — if the
  // user had hidden the right panel or switched to Tasks (the common reason
  // to use tab mode), the fold stranded the diff with no visible surface and
  // no close button. Closing is always safe; the explicit fold glyph in the
  // tab header still offers fold-back when the overlay host is available.
  // In tab mode we also blur the active element so keystrokes can't leak
  // into a focused terminal behind the surface.
  useEffect(() => {
    if (expanded) {
      (document.activeElement as HTMLElement | null)?.blur();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, onClose]);

  useEffect(() => {
    let cancelled = false;
    let loading = false;
    let refreshPending = false;
    let previousText: { oldText: string; newText: string } | null = null;
    setResult({ state: 'loading' });

    const load = async () => {
      if (cancelled) return;
      if (loading) { refreshPending = true; return; }
      loading = true;
      const { added: badgeAdded, deleted: badgeDeleted } = badgeRef.current;
      try {
        if (badgeAdded + badgeDeleted > DIFF_MAX_CHANGED_LINES) {
          previousText = null;
          setResult({ state: 'too_large', added: badgeAdded, deleted: badgeDeleted });
          return;
        }
        // Fetch the two sides from git per group:
        //   untracked   → old ""            / new = working file (no git blob)
        //   uncommitted → old `HEAD:rel`   / new = working file (HEAD↔worktree)
        //   committed   → old `HEAD~1:rel` / new = `HEAD:rel` (last commit's diff)
        // `gitShowFile` returns null when the path is absent at that revision
        // (a newly-added file has no HEAD blob, an initial commit has no
        // HEAD~1) → empty side → all-additions.
        let oldText: string;
        let newText: string;
        if (kind === 'untracked') {
          oldText = '';
          newText = (await commands.readTextFile(path)) ?? '';
        } else if (kind === 'committed') {
          const ref = commitHash ?? 'HEAD';
          const [o, n] = await Promise.all([
            commands.gitShowFile(repoRoot, `${ref}~1:${rel}`),
            commands.gitShowFile(repoRoot, `${ref}:${rel}`),
          ]);
          oldText = o ?? '';
          newText = n ?? '';
        } else {
          // uncommitted: HEAD blob vs working file on disk.
          const [o, n] = await Promise.all([
            commands.gitShowFile(repoRoot, `HEAD:${rel}`),
            commands.readTextFile(path),
          ]);
          oldText = o ?? '';
          newText = n ?? '';
        }
        if (cancelled || refreshPending) return;
        // Filesystem events include sibling edits and the polling backstop.
        // Unchanged text needs no diff, tokenization, or React update.
        if (previousText?.oldText === oldText && previousText.newText === newText) return;

        // Post-fetch size guard (replaces the old getDiffMeta pre-probe): bail
        // to the summary card before the jsdiff + double-Shiki pass, which
        // would freeze the main thread on a multi-MB blob.
        if (oldText.length + newText.length > DIFF_MAX_BYTES
          || new TextEncoder().encode(oldText).byteLength + new TextEncoder().encode(newText).byteLength > DIFF_MAX_BYTES) {
          previousText = null;
          setResult({ state: 'too_large', added: badgeAdded, deleted: badgeDeleted });
          return;
        }

        const lines = computeUnifiedDiff(oldText, newText);
        // Renderer-side counts (order-sensitive jsdiff), distinct from the
        // Rust badge props of the same name — name them apart to avoid
        // shadowing those props.
        const addedLines = lines.filter(l => l.kind === 'add').length;
        const deletedLines = lines.filter(l => l.kind === 'del').length;

        // Tokenize BEFORE the first 'ok' render. Painting plain text first
        // and then swapping in Shiki tokens caused a visible color flip on
        // every file open — single-shot avoids that.
        const theme = getShikiTheme(dataTheme);
        const [oldTokens, newTokens] = await Promise.all([
          tokenizeFile(oldText, path, theme),
          tokenizeFile(newText, path, theme),
        ]);
        if (cancelled || refreshPending) return;

        const tokenized = (oldTokens || newTokens)
          ? lines.map(line => {
              const src = line.kind === 'del' ? oldTokens : newTokens;
              return { ...line, tokens: src?.[line.lineNum - 1] ?? null };
            })
          : lines;

        // Fold unchanged runs into gaps for rendering; counts stay sourced
        // from the full flat list above.
        const rows = collapseToHunks(tokenized);
        previousText = { oldText, newText };
        setResult({ state: 'ok', rows, added: addedLines, deleted: deletedLines });
      } catch {
        if (cancelled || refreshPending) return;
        previousText = null;
        setResult({ state: 'error', reason: 'ipc' });
      } finally {
        loading = false;
        if (refreshPending && !cancelled) { refreshPending = false; void load(); }
      }
    };
    void load();

    // Refresh in place, retaining the current rows and scroll position. The
    // backstop also works with Explorer collapsed (its OS watcher is stopped).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const norm = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
    const parent = norm(path).slice(0, norm(path).lastIndexOf('/'));
    const refresh = (event: Event) => {
      const dir = norm((event as CustomEvent<{ dirPath: string }>).detail.dirPath);
      if (dir !== parent && dir !== norm(repoRoot)) return;
      clearTimeout(timer);
      timer = setTimeout(() => { void load(); }, 800);
    };
    // An explicit commit hash is immutable and does not need polling.
    const live = kind !== 'committed' || !commitHash;
    const poll = live ? window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 8000) : undefined;
    if (live) window.addEventListener('fs-refresh', refresh);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.clearInterval(poll);
      window.removeEventListener('fs-refresh', refresh);
    };
  }, [path, repoRoot, rel, kind, commitHash, dataTheme]);

  const basename = useMemo(() => path.replace(/\\/g, '/').split('/').pop() || path, [path]);

  const header = (
    <div className="diff-header">
      {mode === 'overlay' ? (
        // Overlay has no chrome-tab carrying the filename, so the header
        // shows the basename here.
        <span className="diff-header-name">{basename}</span>
      ) : (
        // Tab mode: the chrome-tab strip already shows the basename, so the
        // header shows the FULL path instead — "which file" is on the tab,
        // "where it lives" goes here. Truncates with ellipsis when long.
        <span className="diff-header-path">{path}</span>
      )}
      <div className="diff-header-actions">
        {expanded ? (
          // Tab mode: fold back to the bottom-right overlay. The glyph is an
          // outer frame with a filled inner box pinned to the bottom-right —
          // the inner box IS the overlay's corner position, so the icon says
          // "shrink toward there". Close is handled by the tab's own X
          // (rendered by CenterPanel), so no close button here.
          <button
            type="button"
            className="diff-header-btn"
            onClick={onToggleExpanded}
            aria-label="Fold diff back to panel"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <rect x="11" y="11" width="9" height="9" rx="1" fill="currentColor" stroke="none"/>
            </svg>
          </button>
        ) : (
          // Overlay mode: expand to a center tab. The glyph is an outer frame
          // with a filled inner box centered — the visual inverse of the tab-
          // mode fold icon (inner box at bottom-right). Together the pair reads
          // as "center = tab surface, corner = overlay surface". Close button
          // too — the overlay has no outer tab to provide an X.
          <>
            <button
              type="button"
              className="diff-header-btn"
              onClick={onToggleExpanded}
              aria-label="Expand diff to tab"
            >
              {/* Outer frame + centered vertical bar — the bar reads as the
                  center tab column the diff expands into (taller than wide =
                  a tab/pane, not a square). Visual inverse of the tab-mode
                  fold icon (bar at bottom-right = overlay corner). */}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <rect x="9" y="6" width="6" height="12" rx="1" fill="currentColor" stroke="none"/>
              </svg>
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
          </>
        )}
      </div>
    </div>
  );

  // Same DiffPanel element rendered on two surfaces:
  //   overlay (default): in-flow, parent-anchored (bottom half of the changes
  //     panel). heightPercent drives its height.
  //   tab: fills the center tab's panel area (mounted by CenterPanel). No
  //     portal, no backdrop — the center tab IS the surface, and closing is
  //     the tab's own X (not a backdrop click).
  const panelStyle: CSSProperties | undefined =
    mode === 'overlay' && typeof heightPercent === 'number'
      ? { height: `${heightPercent}%` }
      : undefined;
  const panel = (
    <div
      className={`diff-panel${mode === 'tab' ? ' diff-panel--tab' : ''}`}
      style={panelStyle}
    >
      {header}
      <div className="diff-body">
        {result.state === 'loading' && (
          <div className="diff-empty">{t('diff.loading') || 'Loading…'}</div>
        )}
        {result.state === 'error' && (
          <div className="diff-empty">{t('diff.error') || 'Failed to load diff'}</div>
        )}
        {result.state === 'too_large' && (
          <div className="diff-toolarge">
            <div className="diff-toolarge-msg">
              {t('diff.too_large') || 'File too large to show inline diff'}
            </div>
            <div className="diff-toolarge-stats">
              <span className="diff-add">+{result.added}</span>
              <span className="diff-del">-{result.deleted}</span>
            </div>
          </div>
        )}
        {result.state === 'ok' && result.added === 0 && result.deleted === 0 && (
          <div className="diff-empty">{t('diff.no_changes') || 'No changes'}</div>
        )}
        {result.state === 'ok' && (result.added > 0 || result.deleted > 0) && (
          <pre className="diff-pre">
            {result.rows.map(row => {
              if (row.type === 'line') return renderDiffLine(row.line);
              if (expandedGaps.has(row.key)) return row.lines.map(renderDiffLine);
              return (
                <div
                  key={row.key}
                  className="diff-gap"
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleGap(row.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleGap(row.key);
                    }
                  }}
                >
                  {t('diff.unchanged_lines', { count: row.lines.length }) ||
                    `⋯ ${row.lines.length} unchanged lines`}
                </div>
              );
            })}
          </pre>
        )}
      </div>
    </div>
  );

  // Overlay returns the panel in-flow (anchored inside ChangesBoard). Tab
  // mode returns it directly too — CenterPanel mounts it filling the tab's
  // content area. (Previously tab/expanded used a createPortal full-screen
  // modal + backdrop; that blocked the agent terminal behind it.)
  return panel;
}

// Render one diff line. Module-level so it can be reused for both ordinary
// rows and the lines revealed when a gap is expanded. Self-keyed by
// kind+lineNum, which is unique within a single file's diff (new-file line
// numbers for add/eq, old-file for del; the kind prefix separates the two
// numbering spaces), so React reconciles stably as gaps expand/collapse.
function renderDiffLine(line: DiffLine) {
  return (
    <div key={`${line.kind}-${line.lineNum}`} className={`diff-line diff-line-${line.kind}`}>
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
  );
}

// Fold runs of unchanged lines that sit more than DIFF_CONTEXT_LINES from
// any change into a single gap row. Keeps up to CONTEXT lines of orientation
// on each side of every change; the leading run before the first change and
// the trailing run after the last change have only one inner side, so they
// keep context on that side only. A run is folded only when it would hide at
// least DIFF_COLLAPSE_MIN_HIDDEN lines.
function collapseToHunks(lines: DiffLine[]): DiffRow[] {
  const CONTEXT = DIFF_CONTEXT_LINES;
  const rows: DiffRow[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    if (lines[i].kind !== 'eq') {
      rows.push({ type: 'line', line: lines[i] });
      i++;
      continue;
    }
    // Equal run spans [i, j).
    let j = i;
    while (j < n && lines[j].kind === 'eq') j++;
    const head = i > 0 ? CONTEXT : 0; // trailing context for the change above
    const tail = j < n ? CONTEXT : 0; // leading context for the change below
    const hidden = j - i - head - tail;
    if (hidden < DIFF_COLLAPSE_MIN_HIDDEN) {
      for (let k = i; k < j; k++) rows.push({ type: 'line', line: lines[k] });
    } else {
      for (let k = i; k < i + head; k++) rows.push({ type: 'line', line: lines[k] });
      const hiddenLines = lines.slice(i + head, j - tail);
      rows.push({ type: 'gap', key: `gap-${lines[i + head].lineNum}-${hiddenLines.length}`, lines: hiddenLines });
      for (let k = j - tail; k < j; k++) rows.push({ type: 'line', line: lines[k] });
    }
    i = j;
  }
  return rows;
}

// Convert two text blobs into a flat list of unified-diff lines. We don't
// emit @@ hunk headers — for an in-app audit panel users don't need
// summary headers, just the +/- flow with line numbers. jsdiff returns
// chunks (added/removed/eq); we flatten each into individual rows.
// (collapseToHunks then folds the unchanged stretches for rendering.)
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
