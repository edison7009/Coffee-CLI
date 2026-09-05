// Explorer.tsx — Left panel: file tree synced from terminal CWD

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useAppState } from '../../store/app-state';
import type { IconTheme, ToolType } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { isMaskTintTheme } from '../../lib/personalization';
import { ScrollPanel } from '../common/ScrollPanel';
import { clipboardWrite } from '../../lib/clipboard';
import { beginExplorerDrag } from '../../lib/explorer-drag';
import { useFileStats, useDirtyDirs } from '../../lib/git-status';
import { refreshHistory } from '../../lib/history-cache';
import { commands, onSelfUpdateProgress } from '../../tauri';
import type { DirEntryInfo } from '../../tauri';
import { HistoryBoard } from '../right/HistoryBoard';
import './Explorer.css';

// Snapshot lifecycle and the `+N -M` map live in lib/file-stats.tsx so the
// right-side ChangesBoard can read the same data when the left panel is
// collapsed. Explorer is now a pure consumer.
const normPath = (p: string) => p.replace(/\\/g, '/');

// ─── Context Menu ────────────────────────────────────────────────────────────

export interface CtxMenuState {
  x: number;
  y: number;
  absolutePath: string;
  relativePath: string;
  isDir?: boolean;
  onRename?: () => void;
  // ChangesBoard reuses this menu read-only — the audit view shouldn't
  // mutate the agent's just-edited files. Hides cut/copy/paste/rename/delete
  // + the relative-path entry.
  compact?: boolean;
}

// Module-level clipboard: survives menu close/open cycles
let fsClipboard: { action: 'copy' | 'cut'; path: string } | null = null;

// OpenClaw (persona forge), Hermes Agent, and Remote Terminal are
// directory-agnostic — they don't bind to a local project folder, so the
// workspace dir-picker and file tree are hidden for these tabs (clicking
// the picker would otherwise restart the PTY in a new cwd, which makes
// no sense — Remote runs over SSH/WebSocket on a different host).
const CWD_AGNOSTIC_TOOLS: ReadonlySet<ToolType> = new Set<ToolType>(['openclaw', 'hermes', 'remote']);

// Dispatch a custom event to refresh any BrowserDirNode that owns that directory
function dispatchFsRefresh(dirPath: string) {
  window.dispatchEvent(new CustomEvent('fs-refresh', { detail: { dirPath } }));
}

export function ContextMenu({ menu, onClose }: { menu: CtxMenuState; onClose: () => void }) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);

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

  const copyPath = (text: string) => {
    clipboardWrite(text);
    onClose();
  };

  const handleCut = () => {
    fsClipboard = { action: 'cut', path: menu.absolutePath };
    onClose();
  };

  const handleCopy = () => {
    fsClipboard = { action: 'copy', path: menu.absolutePath };
    onClose();
  };

  const handlePaste = async () => {
    if (!fsClipboard) return;
    const targetDir = menu.isDir ? menu.absolutePath : menu.absolutePath.replace(/[\\/][^\\/]+$/, '');
    const sourcePath = fsClipboard.path;
    const action = fsClipboard.action;
    try {
      await commands.fsPaste(action, sourcePath, targetDir);
      
      // Refresh the destination directory where we just pasted
      dispatchFsRefresh(targetDir);
      
      // If we cut a file, the original source location also needs a refresh to show the file is gone!
      if (action === 'cut') {
        const sourceDir = sourcePath.replace(/[\\/][^\\/]+$/, '');
        dispatchFsRefresh(sourceDir);
        fsClipboard = null;
      }
    } catch (e) {
      console.error('[Explorer] paste failed:', e);
    }
    onClose();
  };

  const handleDelete = async () => {
    onClose();
    try {
      await commands.fsDelete(menu.absolutePath);
      const parentDir = menu.absolutePath.replace(/[\\/][^\\/]+$/, '');
      dispatchFsRefresh(parentDir);
    } catch (e) {
      console.error('[Explorer] delete failed:', e);
    }
  };

  const handleRename = () => {
    onClose();
    menu.onRename?.();
  };

  const handleShowInFolder = async () => {
    onClose();
    try {
      await commands.showInFolder(menu.absolutePath);
    } catch (e) {
      console.error('[Explorer] show in folder failed:', e);
    }
  };

  // Hand the path off to the OS default opener — Notepad / browser / image
  // viewer / file manager, whichever the user already configured. We don't
  // ship in-app previewers (memory: "no in-app file viewers"), so this is
  // the user's only one-click path from Explorer to the file's content.
  const handleOpen = async () => {
    onClose();
    try {
      await commands.openUrl(menu.absolutePath);
    } catch (e) {
      console.error('[Explorer] open failed:', e);
    }
  };

  const canPaste = !!fsClipboard;

  // Smart menu positioning to prevent off-screen clipping
  const MENU_WIDTH = 220;
  const MENU_HEIGHT = 320; // Safe upper bound for full ctx menu

  const isBottomOverflow = menu.y + MENU_HEIGHT > window.innerHeight;
  const isRightOverflow = menu.x + MENU_WIDTH > window.innerWidth;

  const style: React.CSSProperties = {
    position: 'fixed',
    ...(isBottomOverflow 
         ? { bottom: Math.max(0, window.innerHeight - menu.y) } 
         : { top: menu.y }),
    ...(isRightOverflow 
         ? { right: Math.max(0, window.innerWidth - menu.x) } 
         : { left: menu.x })
  };

  return createPortal(
    <div className="ctx-menu" ref={menuRef} style={style}>
      {/* Primary action: open in OS default — most-used, sits at the top */}
      <button className="ctx-menu-item" onClick={handleOpen}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 3h6v6"/>
          <path d="M10 14 21 3"/>
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        </svg>
        {t('menu.open')}
      </button>
      <div className="ctx-menu-divider" />
      {/* Path copy group */}
      <button className="ctx-menu-item" onClick={() => copyPath(menu.absolutePath)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        {t('menu.copy_abs')}
      </button>
      <button className="ctx-menu-item" onClick={() => copyPath(menu.relativePath)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        {t('menu.copy_rel')}
      </button>
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item ctx-menu-hint" onClick={() => copyPath('@' + menu.relativePath)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4"/>
          <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/>
        </svg>
        {t('menu.copy_ref')}
      </button>

      {/* File operation group — hidden in compact mode (read-only audit view) */}
      {!menu.compact && <>
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item" onClick={handleCut}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="20" r="2"/><circle cx="18" cy="20" r="2"/>
          <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
        </svg>
        {t('menu.cut')}
      </button>
      <button className="ctx-menu-item" onClick={handleCopy}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
        </svg>
        {t('menu.copy')}
      </button>
      {canPaste && (
        <button className="ctx-menu-item" onClick={handlePaste}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
            <rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>
          </svg>
          {t('menu.paste')}
        </button>
      )}
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item" onClick={handleRename}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
        </svg>
        {t('menu.rename')}
      </button>
      <button className="ctx-menu-item" onClick={handleDelete}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="m19 6-.867 13.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
        {t('menu.delete')}
      </button>
      </>}
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item" onClick={handleShowInFolder}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m19 20-3-3m0 0a4 4 0 1 0-5.656-5.656A4 4 0 0 0 16 17z"/>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        {t('menu.show_in_folder')}
      </button>
    </div>,
    document.body
  );
}

function formatBytes(b: number) {
  return b < 1024 ? b + ' B' : (b / 1024).toFixed(1) + ' KB';
}

// ─── Icon Themes ──────────────────────────────────────────────────────────────
// Every theme ships a complete 19-SVG set under /icons/themes/<id>/.
// No root-level fallback: adding a theme = dropping a new folder + listing it
// in ICON_ART_THEMES. Non-theme UI assets (CLI tool logos, terminal icons,
// etc.) live under /icons/tools/ and are unrelated to this subsystem.

function getIconPath(theme: IconTheme, name: string): string {
  return `/icons/themes/${theme}/${name}`;
}

function getFileIconSrc(ext: string, theme: IconTheme): string {
  return `/icons/themes/${theme}/${getFileIcon(ext)}`;
}

/** Renders a theme icon. For mask-tint themes, uses a <span> with mask-image
 *  so `background-color: var(--accent)` paints the silhouette. For color
 *  themes, falls back to a plain <img>. */
function ThemedIcon({ src, alt, onFallback }: {
  src: string;
  alt: string;
  onFallback?: string;
}) {
  const { state: { iconTheme } } = useAppState();
  if (isMaskTintTheme(iconTheme)) {
    return (
      <span
        className="icon-svg icon-svg-mask"
        role="img"
        aria-label={alt}
        style={{ WebkitMaskImage: `url("${src}")`, maskImage: `url("${src}")` }}
      />
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className="icon-svg"
      onError={onFallback ? (e) => (e.currentTarget.src = onFallback) : undefined}
    />
  );
}


function getFileIcon(ext: string): string {
  const m: Record<string, string> = {
    rs: 'rs.svg', js: 'js.svg', jsx: 'jsx.svg', ts: 'ts.svg', tsx: 'tsx.svg',
    py: 'py.svg', go: 'go.svg', java: 'java.svg', c: 'c.svg', cpp: 'cpp.svg',
    h: 'cpp.svg', html: 'html.svg', css: 'css.svg', json: 'json.svg',
    md: 'md.svg', toml: 'toml.svg', sh: 'sh.svg', pyw: 'py.svg',
  };
  return m[ext.toLowerCase()] || 'file.svg';
}


// ─── Lazy Directory Browser Node ─────────────────────────────────────────────

/** A single expandable directory node for the "My Computer" tab.
 *  Loads children lazily from the backend on first expand. */
function BrowserDirNode({ name, dirPath, icon, onCtxMenu }: { name: string; dirPath: string; icon?: string; onCtxMenu: (menu: CtxMenuState) => void }) {
  const { state: { iconTheme } } = useAppState();
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntryInfo[] | null>(null);
  const [loading, setLoading] = useState(false);

  // True when any descendant file has uncommitted changes. Used to tint the
  // folder name as a "trail" leading to the change — folded folders still
  // signal that something inside is modified, so users don't have to expand
  // the whole tree to find the +/- badge. Icon stays untouched (icon themes
  // own their own coloring; tinting the icon would fight Material/Seti).
  // O(1) check against the precomputed dirty-dirs set (was an O(open-folders ×
  // changes) scan of the whole change list on every poll — a main-thread cost).
  const dirtyDirs = useDirtyDirs();
  const hasDirtyDescendant = useMemo(
    () => dirtyDirs.has(normPath(dirPath).replace(/\/+$/, '')),
    [dirtyDirs, dirPath],
  );

  const toggle = async () => {
    if (!open && children === null) {
      setLoading(true);
      try {
        const entries = await commands.listDirectory(dirPath);
        setChildren(entries);
      } catch (e) {
        console.warn('[Explorer] list_directory failed:', e);
        setChildren([]);
      }
      setLoading(false);
    }
    setOpen(!open);
  };

  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Listen for fs-refresh events targeting our own directory
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ dirPath: string }>;
      const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
      if (norm(ev.detail.dirPath) === norm(dirPath)) {
        if (open) {
          commands.listDirectory(dirPath).then(setChildren).catch(() => setChildren([]));
        } else {
          setChildren(null);
        }
      }
    };
    window.addEventListener('fs-refresh', handler);
    return () => window.removeEventListener('fs-refresh', handler);
  }, [dirPath, open]);

  useEffect(() => { if (renaming) renameInputRef.current?.select(); }, [renaming]);

  const commitRename = async () => {
    if (renameVal.trim() && renameVal !== name) {
      const absPath = dirPath.replace(/\\/g, '/');
      try {
        await commands.fsRename(absPath, renameVal.trim());
        // Notify parent directory to refresh
        const parentDir = absPath.replace(/\/[^/]+$/, '');
        dispatchFsRefresh(parentDir);
      } catch (e) { console.error('[Explorer] rename failed:', e); }
    }
    setRenaming(false);
  };

  const handleDirCtxMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onCtxMenu({
      x: e.clientX,
      y: e.clientY,
      absolutePath: dirPath.replace(/\\/g, '/'),
      relativePath: dirPath.replace(/\\/g, '/'),
      isDir: true,
      onRename: () => setRenaming(true),
    });
  };

  // Pointer-based drag (HTML5 drag is captured by Tauri's WebView2 drop
  // handler on Windows — see explorer-drag.ts). Threshold-gated so a plain
  // click toggles open/close without a phantom drop.
  const onDirMouseDown = (e: React.MouseEvent) => {
    if (renaming) return;
    beginExplorerDrag(dirPath, e);
  };

  return (
    <div className="tree-dir">
      <div
        className={`tree-dir-header ${renaming ? 'renaming' : ''}${hasDirtyDescendant ? ' has-dirty' : ''}`}
        onClick={() => !renaming && toggle()}
        onContextMenu={handleDirCtxMenu}
        onMouseDown={onDirMouseDown}
      >
        <span className={`tree-arrow ${open ? '' : 'closed'}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </span>
        <span className="tree-icon">
          <ThemedIcon src={icon || getIconPath(iconTheme, open ? 'folder-open.svg' : 'folder-closed.svg')} alt="dir" />
        </span>
        <span className="tree-name" style={{ display: renaming ? 'none' : undefined }}>{name}</span>
        <input
          ref={renameInputRef}
          className="tree-rename-input"
          style={{ display: renaming ? undefined : 'none' }}
          value={renameVal}
          onChange={e => setRenameVal(e.target.value)}
          onBlur={commitRename}
          onKeyDown={e => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
          onClick={e => e.stopPropagation()}
        />
      </div>
      {open && (
        <div className="tree-children">
          {loading ? (
            <div style={{ padding: '6px 8px', color: 'var(--text-3)', fontSize: 12 }}>Loading...</div>
          ) : children && children.length === 0 ? (
            <div style={{ padding: '6px 8px', color: 'var(--text-3)', fontSize: 12, opacity: 0.5 }}>(empty)</div>
          ) : children?.slice().sort((a, b) => {
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
            return a.name.localeCompare(b.name);
          }).map(entry => (
            entry.is_dir ? (
              <BrowserDirNode key={entry.path} name={entry.name} dirPath={entry.path} onCtxMenu={onCtxMenu} />
            ) : (
              <BrowserFileNode key={entry.path} entry={entry} parentDirPath={dirPath} onCtxMenu={onCtxMenu} />
            )
          ))}
        </div>
      )}
    </div>
  );
}

/** A leaf file node inside the My Computer tree with inline rename support. */
function BrowserFileNode({ entry, parentDirPath, onCtxMenu }: {
  entry: DirEntryInfo;
  parentDirPath: string;
  onCtxMenu: (menu: CtxMenuState) => void;
}) {
  const { state: { iconTheme } } = useAppState();
  const fileStats = useFileStats();
  const stats = fileStats?.get(normPath(entry.path));
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(entry.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (renaming) renameInputRef.current?.select(); }, [renaming]);

  const commitRename = async () => {
    if (renameVal.trim() && renameVal !== entry.name) {
      try {
        await commands.fsRename(entry.path, renameVal.trim());
        const parentNorm = parentDirPath.replace(/\\/g, '/');
        dispatchFsRefresh(parentNorm);
      } catch (e) { console.error('[Explorer] rename failed:', e); }
    }
    setRenaming(false);
  };

  const handleCtxMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onCtxMenu({
      x: e.clientX,
      y: e.clientY,
      absolutePath: entry.path.replace(/\\/g, '/'),
      relativePath: entry.path.replace(/\\/g, '/'),
      isDir: false,
      onRename: () => setRenaming(true),
    });
  };

  const onFileMouseDown = (e: React.MouseEvent) => {
    if (renaming) return;
    beginExplorerDrag(entry.path, e);
  };

  return (
    <div
      className={`tree-file ${renaming ? 'renaming' : ''}`}
      onContextMenu={handleCtxMenu}
      onMouseDown={onFileMouseDown}
    >
      <span className="tree-icon">
        <ThemedIcon
          src={getFileIconSrc(entry.name.split('.').pop() || '', iconTheme)}
          alt="file"
          onFallback={getIconPath(iconTheme, 'file.svg')}
        />
      </span>
      <span className="tree-fname" style={{ display: renaming ? 'none' : undefined }}>{entry.name}</span>
      <input
        ref={renameInputRef}
        className="tree-rename-input"
        style={{ display: renaming ? undefined : 'none' }}
        value={renameVal}
        onChange={e => setRenameVal(e.target.value)}
        onBlur={commitRename}
        onKeyDown={e => {
          if (e.key === 'Enter') commitRename();
          if (e.key === 'Escape') setRenaming(false);
        }}
        onClick={e => e.stopPropagation()}
      />
      {stats ? (
        <span className="tree-badge tree-badge-diff">
          <span className="diff-add">+{stats.added}</span>
          <span className="diff-del">-{stats.deleted}</span>
        </span>
      ) : (
        <span className="tree-badge">{formatBytes(entry.size)}</span>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function Explorer() {
  const { state, dispatch } = useAppState();
  const t = useT();

  const activeSession = state.terminals.find(t => t.id === state.activeTerminalId);
  const folderPath = activeSession?.folderPath || null;

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const handleCtxMenu = useCallback((menu: CtxMenuState) => setCtxMenu(menu), []);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  // Workspace tree: read one directory level at a time from the OS — same
  // semantics as Windows Explorer / Finder / GNOME Files. No filtering,
  // no recursion, no MAX_FILES cap. Subdirs lazy-load via BrowserDirNode.
  const [rootEntries, setRootEntries] = useState<DirEntryInfo[] | null>(null);
  useEffect(() => {
    if (!folderPath) { setRootEntries(null); return; }
    let cancelled = false;
    let request = 0;
    const load = () => {
      const current = ++request;
      commands.listDirectory(folderPath)
        .then(entries => { if (!cancelled && current === request) setRootEntries(entries); })
        .catch(() => { if (!cancelled && current === request) setRootEntries([]); });
    };
    load();
    // Initial reads and refreshes share one sequence so an older response
    // cannot replace a newer directory listing after a tab switch or save.
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const target = norm(folderPath);
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ dirPath: string }>;
      const dir = norm(ev.detail.dirPath);
      if (dir === target) {
        load();
      }
    };
    window.addEventListener('fs-refresh', handler);
    return () => { cancelled = true; window.removeEventListener('fs-refresh', handler); };
  }, [folderPath]);

  // Update check
  const [hasUpdate, setHasUpdate] = useState(false);
  // The brand (logo + title + the self-update button) renders here but DISPLAYS
  // in the titlebar's left slot via portal — so it keeps all its Explorer-local
  // self-update state untouched, and hides together with the left panel (this
  // component unmounts when the panel is hidden, which is exactly what we want:
  // no need to relocate the brand to the centre). Slot resolves after mount.
  const [brandSlot, setBrandSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setBrandSlot(document.getElementById('titlebar-brand-slot')); }, []);
  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        const [local, remote] = await Promise.all([
          getVersion(),
          fetch('https://coffeecli.com/version.json').then(r => r.json()),
        ]);
        const isNewer = (r: string, l: string) => {
          const rv = r.split('.').map(Number);
          const lv = l.split('.').map(Number);
          for (let i = 0; i < 3; i++) {
            if ((rv[i] ?? 0) > (lv[i] ?? 0)) return true;
            if ((rv[i] ?? 0) < (lv[i] ?? 0)) return false;
          }
          return false;
        };
        if (remote?.version && isNewer(remote.version, local)) setHasUpdate(true);
      } catch { /* offline or fetch failed — silent */ }
    };
    checkUpdate();
  }, []);

  // In-app self-update. Click the logo's update icon → a circular ring fills
  // as the installer downloads, then the wizard launches and the app exits.
  // Windows only; elsewhere (or on download failure) fall back to the page.
  const [installing, setInstalling] = useState(false);
  const [installPct, setInstallPct] = useState(0);
  const [installPhase, setInstallPhase] = useState<
    'speed_test' | 'downloading' | 'launching' | 'error' | null
  >(null);
  const handleSelfUpdate = useCallback(async () => {
    if (installing) return;
    if (!navigator.userAgent.toLowerCase().includes('win')) {
      commands.openUrl('https://coffeecli.com');
      return;
    }
    setInstalling(true);
    setInstallPhase('speed_test');
    setInstallPct(0);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await onSelfUpdateProgress((p) => {
        setInstallPhase(p.status);
        setInstallPct(p.percent);
      });
      await commands.downloadAndInstallUpdate();
      // Success: installer launched and the app is about to exit — leave the
      // ring as-is until the window goes away.
    } catch {
      commands.openUrl('https://coffeecli.com');
      setInstalling(false);
      setInstallPhase(null);
      setInstallPct(0);
    } finally {
      unlisten?.();
    }
  }, [installing]);

  // Persist last-selected left tab, same pattern as TaskBoard's right tab.
  const [activeTab, setActiveTab] = useState<'workspace' | 'history'>(() => {
    try {
      const saved = localStorage.getItem('cc-left-tab');
      if (saved === 'workspace' || saved === 'history') return saved;
    } catch { /* Best-effort operation; failure is non-fatal. */ }
    return 'workspace';
  });
  useEffect(() => {
    try { localStorage.setItem('cc-left-tab', activeTab); } catch { /* Best-effort operation; failure is non-fatal. */ }
  }, [activeTab]);

  const handleOpenFolder = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ directory: true });
      if (selected && typeof selected === 'string') {
        const activeTerminalId = state.activeTerminalId;
        const tool = activeSession?.tool;

        if (activeTerminalId && tool) {
          // 1. Update this tab's folderPath so the restarted terminal knows its CWD
          dispatch({ type: 'SET_FOLDER', path: selected });

          // 2. Force unmount-remount of the TierTerminal to restart the Agent in the new dir
          dispatch({ type: 'RESTART_TERMINAL', id: activeTerminalId, newId: crypto.randomUUID() });
        }
      }
    } catch (err) {
      console.error('[Explorer] Failed to open folder:', err);
    }
  };

  // OS-level fs watcher — picks up changes from the terminal CLI, editors,
  // git, or any process writing under folderPath. The backend emits the
  // same `fs-refresh` event shape that right-click menu actions dispatch
  // synthetically, so the listener above handles both paths uniformly.
  //
  // CRITICAL ordering: register the Tauri `listen('fs-refresh')` BEFORE
  // calling `startFsWatcher`. The previous order (start → import → listen)
  // dropped any event fired in the few-ms gap between the OS watcher
  // arming and the JS subscription registering — exactly the window in
  // which an editor's save burst or `npm install` first writes hit.
  useEffect(() => {
    if (!folderPath) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        if (cancelled) return;
        const handle = await listen<{ dirPath: string }>('fs-refresh', (event) => {
          // Re-dispatch onto `window` so Explorer's existing listeners
          // (workspace re-scan + BrowserDirNode child refresh) both fire.
          window.dispatchEvent(new CustomEvent('fs-refresh', {
            detail: { dirPath: event.payload.dirPath },
          }));
        });
        if (cancelled) { handle(); return; }
        unlisten = handle;

        // Listener is live — now arm the OS watcher.
        await commands.startFsWatcher(folderPath);
      } catch (err) {
        console.warn('[Explorer] fs watcher setup failed:', err);
      }
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      commands.stopFsWatcher().catch(() => {});
    };
  }, [folderPath]);


  return (
    <div className="panel panel-left explorer-panel" data-icon-theme={state.iconTheme}>
      {/* Brand + theme/lang controls */}
      {brandSlot && createPortal(
        <div className="brand">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" className="brand-icon">
            <defs>
              <mask id="brandIconMask">
                {/* Steam (3 wavy lines). The `<animate>` is gated to non-Linux
                    because WebKit2GTK has no GPU path for SMIL `path d` morphing
                    inside a `<mask>`: every frame re-evaluates the bezier
                    geometry, re-rasters the mask, and re-composites the masked
                    full-viewport path on line ~1108. With the mask applied
                    over the entire 24×24 brand icon and the indefinite loop
                    running idle, the kompositor → IPC ack chain pegs Linux
                    WebKitWebProcess + coffee-cli at ~1.2 cores combined even
                    when nothing else is on screen (verified live: SSH 5s
                    increments dropped from 37%/89% to ~0% the moment WebKit
                    was killed; same coffee-cli on Windows WebView2 / macOS
                    WKWebView is silent because both have hardware-accelerated
                    SMIL). Static `d` on Linux means the steam stops drifting
                    upward but the cup glyph itself is fully intact. */}
                <path fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4">
                  {!__IS_LINUX__ && (
                    <animate attributeName="d" dur="3s" repeatCount="indefinite" values="M8 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4;M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4"/>
                  )}
                </path>
                <path d="M4 7h16v0h-16v12h16v-32h-16Z">
                  <animate fill="freeze" attributeName="d" begin="1s" dur="0.6s" to="M4 2h16v5h-16v12h16v-24h-16Z"/>
                </path>
              </mask>
            </defs>
            <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
              <path fill="currentColor" fillOpacity="0" strokeDasharray="48" d="M17 9v9c0 1.66 -1.34 3 -3 3h-6c-1.66 0 -3 -1.34 -3 -3v-9Z">
                <animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="48;0"/>
                <animate fill="freeze" attributeName="fill-opacity" begin="1.6s" dur="0.4s" to="1"/>
              </path>
              <path fill="none" strokeDasharray="16" strokeDashoffset="16" d="M17 9h3c0.55 0 1 0.45 1 1v3c0 0.55 -0.45 1 -1 1h-3">
                <animate fill="freeze" attributeName="stroke-dashoffset" begin="0.6s" dur="0.3s" to="0"/>
              </path>
            </g>
            <path fill="currentColor" d="M0 0h24v24H0z" mask="url(#brandIconMask)"/>
          </svg>
          <span>{t('app.title')}</span>
          {hasUpdate && (
            <button
              className={`icon-btn xs update-check-btn update-available${installing ? ' is-installing' : ''}`}
              onClick={handleSelfUpdate}
              disabled={installing}
              aria-label="Update Coffee CLI"
            >
              {installing ? (
                <svg
                  className={`update-ring${installPhase === 'speed_test' ? ' spin' : ''}`}
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                >
                  <circle className="update-ring-track" cx="12" cy="12" r="9" fill="none" strokeWidth="2.6" />
                  <circle
                    className="update-ring-progress"
                    cx="12"
                    cy="12"
                    r="9"
                    fill="none"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    transform="rotate(-90 12 12)"
                    strokeDasharray={
                      installPhase === 'speed_test'
                        ? `${2 * Math.PI * 9 * 0.25} ${2 * Math.PI * 9}`
                        : 2 * Math.PI * 9
                    }
                    strokeDashoffset={
                      installPhase === 'speed_test'
                        ? 0
                        : 2 * Math.PI * 9 * (1 - installPct / 100)
                    }
                  />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              )}
            </button>
          )}
        </div>
        
        ,
        brandSlot
      )}

      <div className="explorer-tabs">
        <button
          className={`explorer-tab ${activeTab === 'workspace' ? 'active' : ''}`}
          onClick={() => setActiveTab('workspace')}
        >
          {t('explorer.tab.workspace')}
        </button>
        <button
          className={`explorer-tab ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => { setActiveTab('history'); refreshHistory(); }}
        >
          {t('explorer.tab.history')}
        </button>
      </div>

      {(activeTab === 'workspace' && activeSession?.tool && !CWD_AGNOSTIC_TOOLS.has(activeSession.tool)) && (
        <button
          className="workspace-dir-btn"
          onClick={handleOpenFolder}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"></path>
          </svg>
          <span className="workspace-dir-path">
            {activeSession.folderPath
              ? `⁦${activeSession.folderPath}⁩`
              : t('explorer.workspace.select-dir')}
          </span>
        </button>
      )}

      {/* File list Content */}
      <div className="panel-content explorer-content">
        {activeTab === 'history' ? (
          // HistoryBoard returns a fragment and was originally hosted inside
          // .task-board which provided the 16px gutter. In Explorer's flex
          // shell that padding doesn't exist, so we wrap to restore it.
          <div className="explorer-history-host"><HistoryBoard /></div>
        ) : (!activeSession?.tool || CWD_AGNOSTIC_TOOLS.has(activeSession.tool)) ? (
          // Launchpad (no tool picked yet) or a CWD-agnostic tool
          // (OpenClaw / Hermes Agent) — both render the same blank
          // state: a faint folder glyph, no file tree, no dir picker.
          // Without this gate the workspace would show the default
          // cwd's tree even before the user has chosen a tool.
          <div className="empty-state" style={{ justifyContent: 'center', gap: '10px' }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}>
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
        ) : !folderPath ? (
          // Waiting state — terminal will sync the directory automatically
          <div className="empty-state" style={{ justifyContent: 'center', gap: '10px' }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}>
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
        ) : rootEntries === null ? (
          <ScrollPanel>
            <div className="file-tree-container" style={{ pointerEvents: 'none' }}>
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', opacity: Math.max(0.1, 1 - i * 0.08) }}>
                  <div className="shimmer-box" style={{ width: 14, height: 14, borderRadius: 'var(--radius-xs)', flexShrink: 0 }}></div>
                  <div className="shimmer-box" style={{ width: `${30 + (i * 7) % 40}%`, height: 12, borderRadius: 'var(--radius-xs)' }}></div>
                </div>
              ))}
            </div>
          </ScrollPanel>
        ) : (
          <ScrollPanel>
            <div className="file-tree-container">
              {rootEntries.slice().sort((a, b) => {
                if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
                return a.name.localeCompare(b.name);
              }).map(entry => (
                entry.is_dir ? (
                  <BrowserDirNode key={entry.path} name={entry.name} dirPath={entry.path} onCtxMenu={handleCtxMenu} />
                ) : (
                  <BrowserFileNode key={entry.path} entry={entry} parentDirPath={folderPath!} onCtxMenu={handleCtxMenu} />
                )
              ))}
            </div>
          </ScrollPanel>
        )}
      </div>



      {/* Right-click context menu */}
      {ctxMenu && <ContextMenu menu={ctxMenu} onClose={closeCtxMenu} />}

      {/* Theme + language pickers now live in the titlebar-gear SettingsModal
          (App-level), not here. */}
    </div>
  );
}
