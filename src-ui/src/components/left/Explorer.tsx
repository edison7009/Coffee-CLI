// Explorer.tsx — Left panel: file tree synced from terminal CWD

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { ScrollPanel } from '../common/ScrollPanel';
import type { FileEntry } from '../../tauri';
import './Explorer.css';

// ─── Context Menu ────────────────────────────────────────────────────────────

interface CtxMenuState {
  x: number;
  y: number;
  absolutePath: string;
  relativePath: string;
}

function ContextMenu({ menu, onClose }: { menu: CtxMenuState; onClose: () => void }) {
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

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    onClose();
  };

  // Clamp menu position so it doesn't overflow the viewport
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(menu.x, window.innerWidth - 220),
    top: Math.min(menu.y, window.innerHeight - 100),
  };

  return (
    <div className="ctx-menu" ref={menuRef} style={style}>
      <button className="ctx-menu-item" onClick={() => copy(menu.absolutePath)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        Copy Absolute Path
      </button>
      <button className="ctx-menu-item" onClick={() => copy(menu.relativePath)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        Copy Relative Path
      </button>
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item ctx-menu-hint" onClick={() => copy('@' + menu.relativePath)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4"/>
          <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/>
        </svg>
        Copy as @reference
      </button>
    </div>
  );
}

function formatBytes(b: number) {
  return b < 1024 ? b + ' B' : (b / 1024).toFixed(1) + ' KB';
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

// ─── Recursive File Tree ───────────────────────────────────────────────────────

type TreeLeaf = { type: 'file'; data: FileEntry };
type TreeNode = { type: 'dir'; name: string; children: Record<string, TreeNode | TreeLeaf> };

function buildTree(files: FileEntry[]) {
  const root: TreeNode = { type: 'dir', name: '', children: {} };
  
  files.forEach(f => {
    const parts = f.relative_path.split('/');
    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!current.children[p]) {
        current.children[p] = { type: 'dir', name: p, children: {} };
      }
      current = current.children[p] as TreeNode;
    }
    const fileName = parts[parts.length - 1];
    current.children[fileName] = { type: 'file', data: f };
  });

  return root;
}

function DirNode({ name, node, folderPath, onCtxMenu }: {
  name: string;
  node: TreeNode;
  folderPath: string;
  onCtxMenu: (menu: CtxMenuState) => void;
}) {
  const [open, setOpen] = useState(false);

  const children = Object.entries(node.children).sort(([aK, aV], [bK, bV]) => {
    const aIsDir = aV.type === 'dir';
    const bIsDir = bV.type === 'dir';
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return aK.localeCompare(bK);
  });

  // Derive the relative path by collecting child file entries
  // For dirs we reconstruct: first file's relative path minus its tail
  const getRelative = () => {
    const firstFile = Object.values(node.children).find(c => c.type === 'file') as { data: FileEntry } | undefined;
    if (!firstFile) return name;
    const parts = firstFile.data.relative_path.split('/');
    return parts.slice(0, -1).join('/');
  };

  const handleCtxMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rel = getRelative();
    onCtxMenu({
      x: e.clientX,
      y: e.clientY,
      absolutePath: folderPath.replace(/\\/g, '/') + '/' + rel,
      relativePath: rel,
    });
  };

  return (
    <div className="tree-dir">
      <div
        className={`tree-dir-header ${open ? '' : 'collapsed'}`}
        onClick={() => setOpen(!open)}
        onContextMenu={handleCtxMenu}
      >
        <span className={`tree-arrow ${open ? '' : 'closed'}`}>▾</span>
        <span className="tree-icon">
          <img src={open ? '/icons/folder-open.svg' : '/icons/folder-closed.svg'} alt="dir" className="icon-svg" />
        </span>
        <span className="tree-name">{name}</span>
      </div>
      {open && (
        <div className="tree-children">
          {children.map(([childName, childNode]) => (
            childNode.type === 'dir'
              ? <DirNode key={childName} name={childName} node={childNode as TreeNode} folderPath={folderPath} onCtxMenu={onCtxMenu} />
              : <FileNode key={childName} name={childName} file={(childNode as { data: FileEntry }).data} folderPath={folderPath} onCtxMenu={onCtxMenu} />
          ))}
        </div>
      )}
    </div>
  );
}

function FileNode({ name, file, folderPath, onCtxMenu }: {
  name: string;
  file: FileEntry;
  folderPath: string;
  onCtxMenu: (menu: CtxMenuState) => void;
}) {
  const icon = getFileIcon(file.extension);
  const badge = file.symbols.length > 0 ? `${file.symbols.length} sym` : formatBytes(file.size);

  const handleCtxMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onCtxMenu({
      x: e.clientX,
      y: e.clientY,
      absolutePath: folderPath.replace(/\\/g, '/') + '/' + file.relative_path,
      relativePath: file.relative_path,
    });
  };

  return (
    <div className="tree-file" onContextMenu={handleCtxMenu}>
      <span className="tree-icon">
        <img src={`/icons/${icon}`} alt="err" className="icon-svg" onError={(e) => (e.currentTarget.src = '/icons/file.svg')} />
      </span>
      <span className="tree-fname">{name}</span>
      <span className="tree-badge">{badge}</span>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function Explorer() {
  const { state, dispatch } = useAppState();
  const t = useT();

  const activeSession = state.terminals.find(t => t.id === state.activeTerminalId);
  const folderPath = activeSession?.folderPath || null;
  const scanData = activeSession?.scanData || null;

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const handleCtxMenu = useCallback((menu: CtxMenuState) => setCtxMenu(menu), []);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const files = scanData?.files || [];
  const isWatching = !!folderPath;

  const toggleTheme = () => {
    dispatch({ type: 'SET_THEME', theme: state.currentTheme === 'dark' ? 'light' : 'dark' });
  };
  const toggleLang = () => {
    const next = state.currentLang === 'en' ? 'zh-CN' : 'en';
    dispatch({ type: 'SET_LANG', lang: next });
    try { localStorage.setItem('cc-lang', next); } catch {}
  };

  const [islandForced, setIslandForced] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<{ forced: boolean }>('island-state-sync', (e) => {
        setIslandForced(e.payload.forced);
      }).then(u => unlisten = u);
    }).catch(() => {});
    return () => unlisten?.();
  }, []);

  const toggleIsland = () => {
    const next = !islandForced;
    setIslandForced(next);
    import('@tauri-apps/api/event').then(({ emit }) => {
      emit('island-toggle', { forceShow: next });
    }).catch(() => {});
  };



  const treeRoot = useMemo(() => buildTree(files), [files]);

  return (
    <div className="panel panel-left explorer-panel">
      {/* Brand + theme/lang controls */}
      <div className="panel-header">
        <div className="brand">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" className="brand-icon">
            <defs>
              <mask id="brandIconMask">
                <path fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4">
                  <animate attributeName="d" dur="3s" repeatCount="indefinite" values="M8 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 0c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4;M8 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M12 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4M16 -8c0 2 -2 2 -2 4s2 2 2 4s-2 2 -2 4s2 2 2 4"/>
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
          <span>Coffee Mode</span>
        </div>
        
        <div className="window-controls">
          <button className="icon-btn xs" onClick={toggleTheme}>
            {state.currentTheme === 'dark' ? '🌙' : '☀️'}
          </button>
          <button className="icon-btn xs lang-btn" onClick={toggleLang}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 8 6 6" />
              <path d="m4 14 6-6 2-3" />
              <path d="M2 5h12" />
              <path d="M7 2h1" />
              <path d="m22 22-5-10-5 10" />
              <path d="M14 18h6" />
            </svg>
          </button>
          <button className={`icon-btn xs ${islandForced ? 'island-active' : ''}`} onClick={toggleIsland}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill={islandForced ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="16" height="6" x="4" y="9" rx="3" />
            </svg>
          </button>
        </div>
      </div>




      {/* File list Content */}
      <div className="panel-content explorer-content">
        {!folderPath ? (
          // Waiting state — terminal will sync the directory automatically
          <div className="empty-state" style={{ justifyContent: 'center', gap: '10px' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
        ) : !scanData ? (
          <ScrollPanel>
            <div className="file-tree-container" style={{ pointerEvents: 'none' }}>
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', opacity: Math.max(0.1, 1 - i * 0.08) }}>
                  <div className="shimmer-box" style={{ width: 14, height: 14, borderRadius: 2, flexShrink: 0 }}></div>
                  <div className="shimmer-box" style={{ width: `${30 + (i * 7) % 40}%`, height: 12, borderRadius: 2 }}></div>
                </div>
              ))}
            </div>
          </ScrollPanel>
        ) : (
          <ScrollPanel>
            <div className="file-tree-container">
              {Object.entries(treeRoot.children).map(([name, node]) => (
                node.type === 'dir'
                  ? <DirNode key={name} name={name} node={node as TreeNode} folderPath={folderPath!} onCtxMenu={handleCtxMenu} />
                  : <FileNode key={name} name={name} file={(node as { data: FileEntry }).data} folderPath={folderPath!} onCtxMenu={handleCtxMenu} />
              ))}
            </div>
          </ScrollPanel>
        )}
      </div>

      {/* Status Footer */}
      <div className="panel-footer status-bar" id="explorer-status">
        {isWatching ? t('explorer.watching' as any, { n: files.length }) : t('explorer.no_folder' as any)}
      </div>

      {/* Right-click context menu */}
      {ctxMenu && <ContextMenu menu={ctxMenu} onClose={closeCtxMenu} />}
    </div>
  );
}
