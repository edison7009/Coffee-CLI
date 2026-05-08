// ChangesBoard.tsx — flat list of files modified since the active tab's
// session began. Reads the same FileStats map Explorer's tree badges read,
// so the user can see "what's been touched" without expanding directories.

import { useMemo } from 'react';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { useFileStats } from '../../lib/file-stats';
import { commands } from '../../tauri';
import { ScrollPanel } from '../common/ScrollPanel';
import './ChangesBoard.css';

export function ChangesBoard() {
  const t = useT();
  const { state } = useAppState();
  const fileStats = useFileStats();
  const activeSession = state.terminals.find(s => s.id === state.activeTerminalId);
  const folderPath = activeSession?.folderPath || null;

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

  const handleOpen = (path: string) => {
    commands.openUrl(path).catch(e => console.error('[ChangesBoard] open failed:', e));
  };

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
    <ScrollPanel>
      <div className="changes-list">
        {rows.map(row => (
          <button
            key={row.path}
            type="button"
            className="changes-row"
            onClick={() => handleOpen(row.path)}
          >
            <span className="changes-name">{row.basename}</span>
            <span className="changes-path">{row.rel === row.basename ? '' : row.rel.slice(0, -row.basename.length - 1)}</span>
            <span className="changes-stats">
              <span className="diff-add">+{row.added}</span>
              <span className="diff-del">-{row.deleted}</span>
            </span>
          </button>
        ))}
      </div>
    </ScrollPanel>
  );
}
