// ChangesBoard.tsx — flat list of files modified since the active tab's
// session began. Reads the same FileStats map Explorer's tree badges read,
// so the user can see "what's been touched" without expanding directories.
//
// Layout: full-height file list, ALWAYS rendered. Click a row → DiffPanel
// mounts as a bottom overlay (~55% panel height) covering the lower half
// of the list. Click ⤢ on the diff → SAME element promotes to a
// portal-rendered full-window modal. Click ⤓ to come back to half. Click
// × or Esc to close. Three states (closed / half-overlay / full-screen)
// reuse one DiffPanel — no swap-mode logic, no view-replacement state.
// Click another row in the visible-above-overlay list = switch the diff
// to that file (no need to close first).
// Right-click on row = file actions menu (read-only).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { ScrollPanel } from '../common/ScrollPanel';
import { ContextMenu } from '../left/Explorer';
import type { CtxMenuState } from '../left/Explorer';
import { beginExplorerDrag } from '../../lib/explorer-drag';
import { DiffPanel } from './DiffPanel';
import './ChangesBoard.css';

interface ChangesBoardProps {
  selectedPath: string | null;
  setSelectedPath: Dispatch<SetStateAction<string | null>>;
  diffExpanded: boolean;
  onToggleDiffExpanded: () => void;
}

// User's last-set diff height as a percent of the container, persisted
// across reloads. Half-paper diff anchors at the bottom; this value
// controls how much of the container it occupies. Clamp range matches
// the CSS min/max guards below; localStorage round-trip is best-effort.
const DIFF_HEIGHT_KEY = 'coffee:diff-half-height';
const DIFF_HEIGHT_MIN = 20;
const DIFF_HEIGHT_MAX = 90;
const DIFF_HEIGHT_DEFAULT = 55;

function loadStoredDiffHeight(): number {
  try {
    const raw = localStorage.getItem(DIFF_HEIGHT_KEY);
    if (!raw) return DIFF_HEIGHT_DEFAULT;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return DIFF_HEIGHT_DEFAULT;
    return Math.min(DIFF_HEIGHT_MAX, Math.max(DIFF_HEIGHT_MIN, n));
  } catch {
    return DIFF_HEIGHT_DEFAULT;
  }
}

export function ChangesBoard({ selectedPath, setSelectedPath, diffExpanded, onToggleDiffExpanded }: ChangesBoardProps) {
  const t = useT();
  const { state } = useAppState();
  const globalChangeLog = state.globalChangeLog;
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [diffHeight, setDiffHeight] = useState<number>(loadStoredDiffHeight);

  // Top-edge drag to resize the half-paper diff. Only fires when the
  // diff is open AND not in expanded (full-screen) mode — expanded uses
  // its own fixed-inset sizing. We measure against the container's
  // bounding rect so the percent stays meaningful as the right panel
  // is resized by the user dragging the side rail.
  const startResize = (e: React.PointerEvent) => {
    if (diffExpanded) return;
    const container = containerRef.current;
    if (!container) return;
    // preventDefault + stopPropagation — same pattern Gambit's dock
    // resize uses. Keeps an ancestor element from accidentally
    // intercepting the drag (e.g. a parent panel with its own
    // mouseDown/pointerDown handler).
    e.preventDefault();
    e.stopPropagation();
    const rect = container.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      // Cursor's distance from the BOTTOM of the container = desired
      // diff height. Convert to percent of container height.
      const fromBottomPx = rect.bottom - ev.clientY;
      const pct = (fromBottomPx / rect.height) * 100;
      const clamped = Math.min(DIFF_HEIGHT_MAX, Math.max(DIFF_HEIGHT_MIN, pct));
      setDiffHeight(clamped);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  };

  // Persist the user's chosen height across reloads. Best-effort —
  // localStorage failure (private mode, quota) just means next session
  // starts at default, no functional break.
  useEffect(() => {
    try { localStorage.setItem(DIFF_HEIGHT_KEY, String(diffHeight)); } catch {}
  }, [diffHeight]);

  // Build flat row list from the app-lifecycle global change log. Each
  // entry already carries its own projectRoot + tools list; we derive
  // a relative path against the entry's own root (not the active tab's)
  // so files from a different project still display readably. Sort by
  // mtime descending so the most recent edit floats to top regardless
  // of which tab made it. Tie-break by full absolute path for
  // deterministic ordering when the same operation touches many files.
  const rows = useMemo(() => {
    if (globalChangeLog.size === 0) return [];
    const list: Array<{ path: string; rel: string; basename: string; projectRoot: string; projectName: string; added: number; deleted: number; mtimeMs: number; tools: string[] }> = [];
    for (const [absPath, entry] of globalChangeLog) {
      const root = entry.projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
      const rel = absPath.startsWith(root + '/') ? absPath.slice(root.length + 1) : absPath;
      const basename = rel.split('/').pop() || rel;
      const projectName = root.split('/').filter(Boolean).pop() || root;
      list.push({
        path: absPath,
        rel,
        basename,
        projectRoot: root,
        projectName,
        added: entry.added,
        deleted: entry.deleted,
        mtimeMs: entry.mtimeMs,
        tools: entry.tools,
      });
    }
    list.sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
      return a.path.toLowerCase().localeCompare(b.path.toLowerCase());
    });
    return list;
  }, [globalChangeLog]);

  // Time-window filter: clip rows to a recency cutoff. "all" disables.
  // 5m / 1h / today are absolute thresholds re-evaluated on each render
  // (so the filter stays accurate as time passes — a row from 2 minutes
  // ago auto-disappears from "5m" once it's 6 minutes old). Stored only
  // in component state — not worth persisting across panel toggles
  // since the user is typically in active flow when they care.
  type TimeFilter = 'all' | '5m' | '1h' | 'today';
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const filteredRows = useMemo(() => {
    if (timeFilter === 'all') return rows;
    const now = Date.now();
    const cutoff =
      timeFilter === '5m' ? now - 5 * 60 * 1000 :
      timeFilter === '1h' ? now - 60 * 60 * 1000 :
      new Date().setHours(0, 0, 0, 0);
    return rows.filter(r => r.mtimeMs >= cutoff);
  }, [rows, timeFilter]);

  // Virtualization via progressive load: render only the first N rows,
  // bump N when the bottom sentinel scrolls into view. Cheap, no extra
  // dep, smooth UX. Reset N when the underlying list changes (filter
  // toggle, fresh project opened, etc.).
  const PAGE_SIZE = 50;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [timeFilter, filteredRows.length === 0]);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount(c => Math.min(filteredRows.length, c + PAGE_SIZE));
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [filteredRows.length]);
  const visibleRows = useMemo(() => filteredRows.slice(0, visibleCount), [filteredRows, visibleCount]);

  // If the selected file disappears from the list (reverted, deleted),
  // drop the diff panel rather than showing stale content. We no longer
  // collapse on tab switch — the global log keeps the entry alive.
  // Lookup against full unfiltered rows so the diff panel survives a
  // time-window filter change (selected file might be outside window).
  const selectedRow = selectedPath ? rows.find(r => r.path === selectedPath) : undefined;
  const effectiveSelected = selectedRow ? selectedPath : null;

  if (rows.length === 0) {
    return (
      <div className="task-empty">
        <div className="task-empty-text">
          {t('changes.empty' as any) || 'No changes yet.'}
        </div>
      </div>
    );
  }

  // Resize handle sits at the top edge of the half overlay. Anchored
  // to the container (bottom: diffHeight%) so it tracks the panel's
  // top edge as user drags. Hidden in expanded mode (modal has its
  // own sizing, no top-edge handle for now).
  const handleStyle = diffExpanded
    ? { display: 'none' as const }
    : { bottom: `${diffHeight}%` };

  // Time-filter chip labels — kept inline (not i18n) for now, matching
  // the rest of the panel's UI conventions; promote to t(...) keys once
  // the panel gains a wider label refactor.
  const filterChips: { id: TimeFilter; label: string }[] = [
    { id: 'all',   label: '全部' },
    { id: '5m',    label: '5分钟' },
    { id: '1h',    label: '1小时' },
    { id: 'today', label: '今天' },
  ];

  return (
    <div className="changes-fullview" ref={containerRef}>
      <div className="changes-filter-row">
        {filterChips.map(chip => (
          <button
            key={chip.id}
            type="button"
            className={`changes-filter-chip ${timeFilter === chip.id ? 'active' : ''}`}
            onClick={() => setTimeFilter(chip.id)}
          >
            {chip.label}
          </button>
        ))}
        <span className="changes-filter-count">
          {filteredRows.length}/{rows.length}
        </span>
      </div>
      <ScrollPanel>
        <div className="changes-list">
          {visibleRows.map(row => (
            <div
              key={row.path}
              className={`changes-row ${effectiveSelected === row.path ? 'selected' : ''}`}
              onClick={() => setSelectedPath(prev => prev === row.path ? null : row.path)}
              onMouseDown={(e) => beginExplorerDrag(row.path, e)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtxMenu({
                  x: e.clientX,
                  y: e.clientY,
                  absolutePath: row.path,
                  relativePath: row.rel,
                  isDir: false,
                  compact: true,
                });
              }}
            >
              <span className="changes-name">{row.basename}</span>
              <span className="changes-path">
                <span className="changes-project">{row.projectName}</span>
                {row.tools.length > 0 && (
                  <span className="changes-tools"> · via {row.tools.join(' + ')}</span>
                )}
                {row.rel === row.basename ? '' : ' · ' + row.rel.slice(0, -row.basename.length - 1)}
              </span>
              <span className="changes-stats">
                <span className="diff-add">+{row.added}</span>
                <span className="diff-del">-{row.deleted}</span>
              </span>
            </div>
          ))}
          {visibleCount < filteredRows.length && (
            <div ref={sentinelRef} className="changes-sentinel" aria-hidden="true" />
          )}
        </div>
      </ScrollPanel>
      {effectiveSelected && (
        <>
          <div
            className="diff-resize-handle"
            style={handleStyle}
            onPointerDown={startResize}
            aria-label="Resize diff"
          />
          <DiffPanel
            path={effectiveSelected}
            onClose={() => setSelectedPath(null)}
            expanded={diffExpanded}
            onToggleExpanded={onToggleDiffExpanded}
            heightPercent={diffHeight}
          />
        </>
      )}
      {ctxMenu && <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />}
    </div>
  );
}
