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
import { useAppState, resolveDiffContext } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { useFileStats } from '../../lib/file-stats';
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
  const fileStats = useFileStats();
  const activeSession = state.terminals.find(s => s.id === state.activeTerminalId);
  const diffCtx = resolveDiffContext(activeSession);
  const folderPath = diffCtx?.folderPath ?? null;
  const sessionId = diffCtx?.sessionId ?? null;
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

  const rows = useMemo(() => {
    if (!fileStats || fileStats.size === 0 || !folderPath) return [];
    const root = folderPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const list: Array<{ path: string; rel: string; basename: string; added: number; deleted: number; mtimeMs: number }> = [];
    for (const [absPath, stats] of fileStats) {
      const rel = absPath.startsWith(root + '/') ? absPath.slice(root.length + 1) : absPath;
      const basename = rel.split('/').pop() || rel;
      list.push({ path: absPath, rel, basename, added: stats.added, deleted: stats.deleted, mtimeMs: stats.mtimeMs });
    }
    // Sort by mtime descending — most recently touched at top. Matches
    // the AI workflow's actual question ("what did the agent just do?")
    // far better than either "largest changes first" (auto-generated
    // noise like package-lock.json dominates) or alphabetical (every
    // file weighted equally, agent's last edit could be anywhere).
    // Tie-break by relative path so files written in the same operation
    // (same mtime ms bucket) cluster predictably.
    list.sort((a, b) => {
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
      return a.rel.toLowerCase().localeCompare(b.rel.toLowerCase());
    });
    return list;
  }, [fileStats, folderPath]);

  // If the selected file disappears from the list (reverted, deleted, or tab
  // switch), drop the diff panel rather than showing stale content.
  const selectedStillExists = selectedPath && rows.some(r => r.path === selectedPath);
  const effectiveSelected = selectedStillExists ? selectedPath : null;

  if (!folderPath || rows.length === 0) {
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

  return (
    <div className="changes-fullview" ref={containerRef}>
      <ScrollPanel>
        <div className="changes-list">
          {rows.map(row => (
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
              <span className="changes-path">{row.rel === row.basename ? '' : row.rel.slice(0, -row.basename.length - 1)}</span>
              <span className="changes-stats">
                <span className="diff-add">+{row.added}</span>
                <span className="diff-del">-{row.deleted}</span>
              </span>
            </div>
          ))}
        </div>
      </ScrollPanel>
      {effectiveSelected && sessionId && (
        <>
          <div
            className="diff-resize-handle"
            style={handleStyle}
            onPointerDown={startResize}
            aria-label="Resize diff"
          />
          <DiffPanel
            sessionId={sessionId}
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
