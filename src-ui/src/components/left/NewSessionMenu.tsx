import { useEffect, useState, useSyncExternalStore } from 'react';
import { useT } from '../../i18n/useT';
import { commands } from '../../tauri';
import { getToolIcon } from '../center/CenterPanel';
import { getToolDisplayName } from '../../lib/tool-info';
import { WORK_TOOLS } from '../../lib/layout-mode';
import { getProjectFolders, subscribeProjectFolders } from '../../lib/project-folders';
import { homeShortPath } from '../../lib/home-short-path';

/** Start a conversation without leaving the page: the start page's tools (Clean's own, as pinned there), each with
 *  its recent folders one level further and "open folder…" last. Picking one asks the start page to launch it
 *  (CenterPanel, 'coffee-launch'), so the same folder checks and memory apply. */
function launchFromRail(tool: string, folder?: string) {
  window.dispatchEvent(new CustomEvent('coffee-launch', { detail: { tool, folder } }));
}

function readJson<T>(key: string, fallback: T): T {
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null'); return (value ?? fallback) as T; } catch { return fallback; }
}
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export function NewSessionMenu({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const recents = useSyncExternalStore(subscribeProjectFolders, getProjectFolders, getProjectFolders);
  useEffect(() => {
    let alive = true;
    void commands.checkToolsInstalled().then(result => { if (alive) setInstalled(result); }).catch(() => {});
    import('@tauri-apps/api/path').then(path => path.homeDir()).then(dir => { if (alive) setHome(dir); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  // The start page's pinned tools, in its order; Clean starts only those with a desktop conversation.
  const pinned = readJson<unknown[]>('coffee_pinned_items', []).filter((id): id is string => typeof id === 'string' && id.startsWith('agent:')).map(id => id.slice(6));
  const tools = (pinned.length ? pinned : [...WORK_TOOLS]).filter(tool => WORK_TOOLS.has(tool));
  const lastFolders = readJson<Record<string, string>>('coffee:last-folder-by-tool', {});
  const launch = (tool: string, folder?: string) => { onDone(); launchFromRail(tool, folder); };
  return <div className="rail-new" role="menu" aria-label={t('explorer.new_session')}>
    <div className="rail-new-head">{t('explorer.new_session')}</div>
    {tools.map(tool => {
      const disabled = installed[tool] === false, last = lastFolders[tool];
      // The tool's last folder first, then the other recent ones.
      const folders = [...new Set([...(last ? [last] : []), ...recents])].slice(0, 8);
      return <div key={tool} className={`rail-new-tool${open === tool ? ' is-open' : ''}`} onMouseEnter={() => setOpen(disabled ? null : tool)}>
        <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open === tool} disabled={disabled} className="rail-new-row"
          onClick={() => launch(tool, last)} onFocus={() => setOpen(tool)}>
          <span className="rail-new-icon" aria-hidden="true">{getToolIcon(tool as never)}</span>
          <span className="rail-new-text"><strong>{getToolDisplayName(tool)}</strong><small>{last ? folderName(last) : t('launchpad.pick_folder')}</small></span>
          <svg className="rail-new-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button>
        {open === tool && <div className="rail-new-folders" role="menu" aria-label={getToolDisplayName(tool)}>
          {folders.map(folder => <button key={folder} type="button" role="menuitem" className="rail-new-folder" onClick={() => launch(tool, folder)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
            <span className="rail-new-text"><strong>{folderName(folder)}</strong><small>{homeShortPath(folder, home)}</small></span>
          </button>)}
          {folders.length > 0 && <span className="rail-new-sep" aria-hidden="true" />}
          <button type="button" role="menuitem" className="rail-new-folder rail-new-open" onClick={() => launch(tool)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 10v6M9 13h6" /><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
            <span className="rail-new-text"><strong>{t('launchpad.open_folder')}…</strong></span>
          </button>
        </div>}
      </div>;
    })}
  </div>;
}
