// ChangesBoard.tsx — flat list of files modified since the active tab's
// session began. Reads the same FileStats map Explorer's tree badges read,
// so the user can see "what's been touched" without expanding directories.
//
// Layout (Step 3+): top = list of changed files (40% by default), bottom =
// DiffPanel for the row the user clicked (60%). Click = view diff.
// Right-click = file actions menu (read-only: open / copy paths / show in folder).
// Mirrors VS Code / GitHub Desktop / JetBrains: both interactions coexist.

import { useMemo, useState } from 'react';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { useFileStats } from '../../lib/file-stats';
import { ScrollPanel } from '../common/ScrollPanel';
import { ContextMenu } from '../left/Explorer';
import type { CtxMenuState } from '../left/Explorer';
import { beginExplorerDrag } from '../../lib/explorer-drag';
import { DiffPanel } from './DiffPanel';
import './ChangesBoard.css';

export function ChangesBoard() {
  const t = useT();
  const { state } = useAppState();
  const fileStats = useFileStats();
  const activeSession = state.terminals.find(s => s.id === state.activeTerminalId);
  const folderPath = activeSession?.folderPath || null;
  const sessionId = activeSession?.id || null;
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (!fileStats || fileStats.size === 0 || !folderPath) return [];
    const root = folderPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const list: Array<{ path: string; rel: string; basename: string; added: number; deleted: number }> = [];
    for (const [absPath, stats] of fileStats) {
      const rel = absPath.startsWith(root + '/') ? absPath.slice(root.length + 1) : absPath;
      const basename = rel.split('/').pop() || rel;
      list.push({ path: absPath, rel, basename, added: stats.added, deleted: stats.deleted });
    }
    // Largest changes first — matches the "what did the agent just do" mental
    // model better than alphabetical (which scatters one logical change).
    list.sort((a, b) => (b.added + b.deleted) - (a.added + a.deleted));
    return list;
  }, [fileStats, folderPath]);

  // If the selected file disappears from the list (reverted, deleted, or tab
  // switch), drop the diff panel rather than showing stale content.
  const selectedStillExists = selectedPath && rows.some(r => r.path === selectedPath);
  const effectiveSelected = selectedStillExists ? selectedPath : null;

  if (!folderPath) {
    return (
      <div className="task-empty">
        <div className="task-empty-text">
          {t('changes.no.folder' as any) || 'Open a folder to see file changes.'}
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="task-empty">
        <div className="task-empty-text">
          {t('changes.empty' as any) || 'No changes in this session.'}
        </div>
      </div>
    );
  }

  return (
    <div className="changes-split">
      <div className="changes-split-top">
        <ScrollPanel>
          <div className="changes-list">
            {rows.map(row => (
              <div
                key={row.path}
                className={`changes-row ${effectiveSelected === row.path ? 'selected' : ''}`}
                onClick={() => setSelectedPath(row.path)}
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
      </div>
      {effectiveSelected && sessionId && (
        <div className="changes-split-bottom">
          <DiffPanel sessionId={sessionId} path={effectiveSelected} onClose={() => setSelectedPath(null)} />
        </div>
      )}
      {ctxMenu && <ContextMenu menu={ctxMenu} onClose={() => setCtxMenu(null)} />}
    </div>
  );
}
