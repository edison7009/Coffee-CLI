// SessionContextMenu - right-click menu for session-history cards.
//
// Borrows the workspace-tree menu's style: reuses the existing `.ctx-menu` /
// `.ctx-menu-item` / `.ctx-menu-divider` classes (defined in Explorer.css,
// already theme-aware incl. glass/carbon overrides + in the glass/carbon
// nuclear `:not()` allowlist). Positioning, portal, and dismiss logic mirror
// Explorer.tsx's `ContextMenu`. Items are session-specific (pin, copy ID /
// resume command / full path, reveal in folder, delete) - NOT the file-system
// actions the Explorer menu hardcodes.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/useT';
import type { SavedSession } from '../../tauri';
import { commands } from '../../tauri';
import { clipboardWrite } from '../../lib/clipboard';
import { togglePin, isPinned } from '../../lib/pinned-sessions';
import { buildResumeCommand } from '../../lib/resume-command';

export interface SessionCtxMenuState {
  session: SavedSession;
  workerId?: string;
  workerParent?: SavedSession;
  x: number;
  y: number;
}

const ICON_PROPS = {
  width: 13,
  height: 13,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function SessionContextMenu({ menu, onClose, onRename, onDelete, onOpenSplit, splitFull, onOpenWorker, onDetachWorker }: { menu: SessionCtxMenuState; onClose: () => void; onRename: (session: SavedSession) => void; onDelete: (session: SavedSession) => void; onOpenSplit?: (session: SavedSession) => void; splitFull?: boolean; onOpenWorker?: () => void; onDetachWorker?: () => void }) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);
  const { session } = menu;

  // Dismiss on outside-click + Escape - same as Explorer's ContextMenu.
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const closeKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeKey);
    };
  }, [onClose]);

  const token = session.session_token;
  const resumeCmd = buildResumeCommand(session.tool, token);
  const filePath = session.file_path;
  const hasToken = !!token;
  const hasResume = !!resumeCmd;
  const hasPath = !!filePath;
  const hasGroup2 = hasToken || hasPath; // resume implies token, so this covers it
  const pinned = isPinned(session.tool ?? '', session.id);

  const copy = (text: string) => { clipboardWrite(text); onClose(); };
  const handlePin = () => { togglePin(session.tool ?? '', session.id); onClose(); };
  const handleRename = () => { onRename(session); onClose(); };
  const handleDelete = () => { onDelete(session); onClose(); };
  const handleShowInFolder = async () => {
    onClose();
    if (!filePath) return;
    try { await commands.showInFolder(filePath); } catch (e) { console.error('[HistoryBoard] show in folder failed:', e); }
  };

  // Smart positioning - mirror Explorer's ContextMenu (overflow flip).
  const MENU_WIDTH = 220;
  const MENU_HEIGHT = 290;
  const isBottomOverflow = menu.y + MENU_HEIGHT > window.innerHeight;
  const isRightOverflow = menu.x + MENU_WIDTH > window.innerWidth;
  const style: React.CSSProperties = {
    position: 'fixed',
    ...(isBottomOverflow ? { bottom: Math.max(0, window.innerHeight - menu.y) } : { top: menu.y }),
    ...(isRightOverflow ? { right: Math.max(0, window.innerWidth - menu.x) } : { left: menu.x }),
  };

  if (menu.workerId) return createPortal(<div className="ctx-menu" ref={menuRef} style={style}>
    <button className="ctx-menu-item" onClick={() => { onClose(); onOpenWorker?.(); }}><svg {...ICON_PROPS}><path d="M9 5h10v14H5V9m8 0 6-4m-6 0h6v6" /></svg>{t('orchestration.open_history')}</button>
    {onDetachWorker && <button className="ctx-menu-item" onClick={() => { onClose(); onDetachWorker(); }}><svg {...ICON_PROPS}><rect x="3" y="8" width="13" height="13" rx="2"/><path d="M8 3h13v13m-8-3 8-10"/></svg>{t('orchestration.detach')}</button>}
    <div className="ctx-menu-divider"/><button className="ctx-menu-item" onClick={handleDelete}><svg {...ICON_PROPS}><polyline points="3 6 5 6 21 6"/><path d="m19 6-.867 13.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 6M10 11v6M14 11v6"/></svg>{t('menu.delete')}</button>
  </div>,document.body);
  return createPortal(
    <div className="ctx-menu" ref={menuRef} style={style}>
      {onOpenSplit && <button className="ctx-menu-item" disabled={splitFull} title={splitFull ? t('split.full') : undefined} onClick={() => { onClose(); onOpenSplit(session); }}>
        <svg {...ICON_PROPS}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></svg>{t('split.open')}
      </button>}
      <button className="ctx-menu-item" onClick={handlePin}>
        <svg {...ICON_PROPS}>
          <path d="M12 17v5"/>
          <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>
        </svg>
        {pinned ? t('menu.unpin') : t('menu.pin')}
      </button>

      <button className="ctx-menu-item" onClick={handleRename}>
        <svg {...ICON_PROPS}>
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
        </svg>
        {t('menu.rename')}
      </button>

      {hasGroup2 && <div className="ctx-menu-divider" />}

      {hasToken && (
        <button className="ctx-menu-item" onClick={() => copy(token!)}>
          <svg {...ICON_PROPS}>
            <line x1="4" x2="20" y1="9" y2="9"/>
            <line x1="4" x2="20" y1="15" y2="15"/>
            <line x1="10" x2="8" y1="3" y2="21"/>
            <line x1="16" x2="14" y1="3" y2="21"/>
          </svg>
          {t('menu.copy_session_id')}
        </button>
      )}
      {hasResume && (
        <button className="ctx-menu-item" onClick={() => copy(resumeCmd!)}>
          <svg {...ICON_PROPS}>
            <polyline points="4 17 10 11 4 5"/>
            <line x1="12" x2="20" y1="19" y2="19"/>
          </svg>
          {t('menu.copy_resume_command')}
        </button>
      )}
      {hasPath && (
        <button className="ctx-menu-item" onClick={() => copy(filePath!)}>
          <svg {...ICON_PROPS}>
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
          </svg>
          {t('menu.copy_full_path')}
        </button>
      )}
      {hasPath && (
        <button className="ctx-menu-item" onClick={handleShowInFolder}>
          <svg {...ICON_PROPS}>
            <path d="m19 20-3-3m0 0a4 4 0 1 0-5.656-5.656A4 4 0 0 0 16 17z"/>
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          {t('menu.show_in_folder')}
        </button>
      )}

      {hasGroup2 && <div className="ctx-menu-divider" />}

      <button className="ctx-menu-item" onClick={handleDelete}>
        <svg {...ICON_PROPS}>
          <polyline points="3 6 5 6 21 6"/>
          <path d="m19 6-.867 13.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
        {t('menu.delete')}
      </button>
    </div>,
    document.body,
  );
}
