// Explorer.tsx — Left panel: file tree synced from terminal CWD

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAppState } from '../../store/app-state';
import type { ThemeColor, ThemeShape, IconTheme } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { ScrollPanel } from '../common/ScrollPanel';
import { commands } from '../../tauri';
import type { FileEntry, DriveInfo, DirEntryInfo } from '../../tauri';
import './Explorer.css';

// ─── Context Menu ────────────────────────────────────────────────────────────

interface CtxMenuState {
  x: number;
  y: number;
  absolutePath: string;
  relativePath: string;
  isDir?: boolean;
  onRename?: () => void;
}

// Module-level clipboard: survives menu close/open cycles
let fsClipboard: { action: 'copy' | 'cut'; path: string } | null = null;

// Dispatch a custom event to refresh any BrowserDirNode that owns that directory
function dispatchFsRefresh(dirPath: string) {
  window.dispatchEvent(new CustomEvent('fs-refresh', { detail: { dirPath } }));
}

function ContextMenu({ menu, onClose }: { menu: CtxMenuState; onClose: () => void }) {
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
    navigator.clipboard.writeText(text).catch(() => {});
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
      {/* Path copy group */}
      <button className="ctx-menu-item" onClick={() => copyPath(menu.absolutePath)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        {t('menu.copy_abs' as any)}
      </button>
      <button className="ctx-menu-item" onClick={() => copyPath(menu.relativePath)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        {t('menu.copy_rel' as any)}
      </button>
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item ctx-menu-hint" onClick={() => copyPath('@' + menu.relativePath)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4"/>
          <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/>
        </svg>
        {t('menu.copy_ref' as any)}
      </button>

      {/* File operation group */}
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item" onClick={handleCut}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="20" r="2"/><circle cx="18" cy="20" r="2"/>
          <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
        </svg>
        {t('menu.cut' as any)}
      </button>
      <button className="ctx-menu-item" onClick={handleCopy}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
        </svg>
        {t('menu.copy' as any)}
      </button>
      {canPaste && (
        <button className="ctx-menu-item" onClick={handlePaste}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
            <rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>
          </svg>
          {t('menu.paste' as any)}
        </button>
      )}
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item" onClick={handleRename}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
        </svg>
        {t('menu.rename' as any)}
      </button>
      <button className="ctx-menu-item" onClick={handleDelete}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="m19 6-.867 13.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
        {t('menu.delete' as any)}
      </button>
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item" onClick={handleShowInFolder}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m19 20-3-3m0 0a4 4 0 1 0-5.656-5.656A4 4 0 0 0 16 17z"/>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        {t('menu.show_in_folder' as any)}
      </button>
    </div>,
    document.body
  );
}

// ─── Language Dropdown ───────────────────────────────────────────────────────

const LANGUAGES = [
  { code: 'en',    label: 'English',    glyph: 'A'  },
  { code: 'zh-CN', label: '简体中文',   glyph: '文' },
  { code: 'zh-TW', label: '繁體中文',   glyph: '文' },
  { code: 'ja',    label: '日本語',     glyph: 'あ' },
  { code: 'ko',    label: '한국어',     glyph: '가' },
  { code: 'es',    label: 'Español',    glyph: 'Ñ'  },
  { code: 'fr',    label: 'Français',   glyph: 'Fr' },
  { code: 'de',    label: 'Deutsch',    glyph: 'De' },
  { code: 'pt',    label: 'Português',  glyph: 'Pt' },
  { code: 'ru',    label: 'Русский',    glyph: 'Я'  },
  { code: 'vi',    label: 'Tiếng Việt', glyph: 'Vi' },
];

function getLangGlyph(code: string): string {
  return LANGUAGES.find(l => l.code === code)?.glyph || 'A';
}

function LangDropdown({ anchorRef, currentLang, onSelect, onClose }: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  currentLang: string;
  onSelect: (code: string) => void;
  onClose: () => void;
}) {
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

  // Position below the anchor button
  const rect = anchorRef.current?.getBoundingClientRect();
  const style: React.CSSProperties = {
    position: 'fixed',
    top: rect ? rect.bottom + 4 : 0,
    left: rect ? rect.left : 0,
    minWidth: 160,
  };

  return createPortal(
    <div className="ctx-menu lang-dropdown" ref={menuRef} style={style}>
      {LANGUAGES.map(lang => (
        <button
          key={lang.code}
          className={`ctx-menu-item ${lang.code === currentLang ? 'lang-active' : ''}`}
          onClick={() => onSelect(lang.code)}
        >
          <span style={{ fontSize: 14, width: 20, textAlign: 'center', flexShrink: 0 }}>{lang.glyph}</span>
          <span style={{ flex: 1 }}>{lang.label}</span>
          {lang.code === currentLang && <span style={{ fontSize: 12, opacity: 0.7 }}>✓</span>}
        </button>
      ))}
    </div>,
    document.body
  );
}

// ─── Theme Menu (color × shape) ──────────────────────────────────────────────

const THEME_COLORS: { code: ThemeColor; labelKey: string; swatch: string; ring: string }[] = [
  { code: 'light',      labelKey: 'theme.color.light',      swatch: '#FAFAF7', ring: '#c4956a' },
  { code: 'dark',       labelKey: 'theme.color.dark',       swatch: '#1a1917', ring: '#c4956a' },
  { code: 'cappuccino', labelKey: 'theme.color.cappuccino', swatch: '#1a1a1a', ring: '#4a4a4a' },
  { code: 'sakura',     labelKey: 'theme.color.sakura',     swatch: '#221b28', ring: '#f8b4c8' },
  { code: 'lavender',   labelKey: 'theme.color.lavender',   swatch: '#221f2e', ring: '#c8b6ff' },
  { code: 'mint',       labelKey: 'theme.color.mint',       swatch: '#142623', ring: '#7ae8c8' },
];

const THEME_SHAPES: { code: ThemeShape; label: string }[] = [
  { code: 'soft',  label: 'Soft'  },
  { code: 'slab',  label: 'Slab'  },
  { code: 'sharp', label: 'Sharp' },
  { code: 'blade', label: 'Blade' },
  { code: 'panel', label: 'Panel' },
];

const THEME_PRESETS: { labelKey: string; theme: ThemeColor; shape: ThemeShape }[] = [
  { labelKey: 'theme.preset.cappuccino_slab', theme: 'cappuccino', shape: 'slab'  },
  { labelKey: 'theme.preset.sakura_blade',    theme: 'sakura',     shape: 'blade' },
  { labelKey: 'theme.preset.mint_sharp',      theme: 'mint',       shape: 'sharp' },
  { labelKey: 'theme.preset.lavender_panel',  theme: 'lavender',   shape: 'panel' },
  { labelKey: 'theme.preset.light_soft',      theme: 'light',      shape: 'soft'  },
];

import { TERM_COLOR_SCHEMES } from '../center/TierTerminal';

const ICON_ART_THEMES: { id: IconTheme; folderSrc: string }[] = [
  { id: 'default',  folderSrc: '/icons/folder-closed.svg'                    },
  { id: 'flat',     folderSrc: '/icons/themes/flat/folder-closed.svg'        },
  { id: 'outline',  folderSrc: '/icons/themes/outline/folder-closed.svg'     },
  { id: 'pixel',    folderSrc: '/icons/themes/pixel/folder-closed.svg'       },
  { id: 'gradient', folderSrc: '/icons/themes/gradient/folder-closed.svg'    },
  { id: 'round',    folderSrc: '/icons/themes/round/folder-closed.svg'       },
  { id: 'glow',     folderSrc: '/icons/themes/glow/folder-closed.svg'        },
  { id: 'pastel',   folderSrc: '/icons/themes/pastel/folder-closed.svg'      },
];

function ThemeMenu({ anchorRef, currentTheme, currentShape, currentIconTheme, hasBg, termColorScheme, onSelectTheme, onSelectShape, onSelectPreset, onSelectIconTheme, onPickBg, onClearBg, onSelectScheme, onClose, t }: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  currentTheme: ThemeColor;
  currentShape: ThemeShape;
  currentIconTheme: IconTheme;
  hasBg: boolean;
  termColorScheme: string;
  onSelectTheme: (t: ThemeColor) => void;
  onSelectShape: (s: ThemeShape) => void;
  onSelectPreset: (t: ThemeColor, s: ThemeShape) => void;
  onSelectIconTheme: (t: IconTheme) => void;
  onPickBg: () => void;
  onClearBg: () => void;
  onSelectScheme: (id: string) => void;
  onClose: () => void;
  t: (key: any) => string;
}) {
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

  const rect = anchorRef.current?.getBoundingClientRect();
  const style: React.CSSProperties = {
    position: 'fixed',
    top: rect ? rect.bottom + 6 : 0,
    left: rect ? Math.max(8, rect.left - 120) : 0,
    minWidth: 260,
  };

  return createPortal(
    <div className="ctx-menu theme-menu" ref={menuRef} style={style}>
      <div className="theme-menu-section-label">{t('theme.section.color')}</div>
      <div className="theme-swatch-grid">
        {THEME_COLORS.map(c => (
          <button
            key={c.code}
            className={`theme-swatch ${c.code === currentTheme ? 'active' : ''}`}
            onClick={() => onSelectTheme(c.code)}
            style={{ background: c.swatch, ['--swatch-ring' as any]: c.ring }}
          >
            <span className="theme-swatch-label">{t(c.labelKey as any)}</span>
          </button>
        ))}
      </div>

      <div className="ctx-menu-divider" />
      <div className="theme-menu-section-label">{t('theme.section.shape')}</div>
      <div className="theme-shape-row">
        {THEME_SHAPES.map(s => (
          <button
            key={s.code}
            className={`theme-shape-chip ${s.code === currentShape ? 'active' : ''}`}
            onClick={() => onSelectShape(s.code)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="ctx-menu-divider" />
      <div className="theme-menu-section-label">{t('theme.section.presets')}</div>
      <div className="theme-preset-grid">
        {THEME_PRESETS.map(p => (
          <button
            key={p.labelKey}
            className={`theme-preset-item ${p.theme === currentTheme && p.shape === currentShape ? 'active' : ''}`}
            onClick={() => onSelectPreset(p.theme, p.shape)}
          >
            {t(p.labelKey as any)}
          </button>
        ))}
      </div>

      <div className="ctx-menu-divider" />

      {/* Wallpaper + terminal color scheme row */}
      <div className="theme-bg-row">
        <button
          className={`theme-bg-btn ${hasBg ? 'has-bg' : ''}`}
          onClick={hasBg ? onClearBg : onPickBg}
        >
          {hasBg ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
          )}
        </button>
        <button
          className={`term-fg-chip reset ${termColorScheme === '' ? 'active' : ''}`}
          onClick={() => onSelectScheme('')}
        >Aa</button>
        {TERM_COLOR_SCHEMES.map(s => (
          <button
            key={s.id}
            className={`term-fg-chip ${termColorScheme === s.id ? 'active' : ''}`}
            style={{ color: s.fg }}
            onClick={() => onSelectScheme(termColorScheme === s.id ? '' : s.id)}
          >Aa</button>
        ))}
      </div>

      <div className="ctx-menu-divider" />
      <div className="theme-menu-section-label">{t('theme.section.icons')}</div>
      <div className="theme-shape-row icon-theme-row">
        {ICON_ART_THEMES.map(({ id, folderSrc }) => (
          <button
            key={id}
            className={`icon-theme-chip ${currentIconTheme === id ? 'active' : ''}`}
            onClick={() => onSelectIconTheme(id)}
          >
            <img src={folderSrc} alt={id} width="22" height="22" />
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}

function formatBytes(b: number) {
  return b < 1024 ? b + ' B' : (b / 1024).toFixed(1) + ' KB';
}

// ─── Icon Themes ──────────────────────────────────────────────────────────────

// Art-style themes have real SVG assets in /icons/themes/<id>/.
// Filter themes reuse the default icons and rely on CSS filters in Explorer.css.
const ART_THEMES = new Set<IconTheme>(['flat', 'outline', 'pixel', 'gradient', 'round', 'glow', 'pastel']);

/** Returns the correct icon path for folder/file icons based on active theme. */
function getIconPath(theme: IconTheme, name: string): string {
  if (ART_THEMES.has(theme)) return `/icons/themes/${theme}/${name}`;
  return `/icons/${name}`; // default + filter themes use root icons
}

/** Returns the correct path for a language-specific file icon.
 *  Art themes have their own icon sets; filter/default themes use root /icons/. */
function getFileIconSrc(ext: string, theme: IconTheme): string {
  const name = getFileIcon(ext);
  if (ART_THEMES.has(theme)) return `/icons/themes/${theme}/${name}`;
  return `/icons/${name}`;
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
  const { state: { iconTheme } } = useAppState();
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
    const absPath = folderPath.replace(/\\/g, '/') + '/' + rel;
    onCtxMenu({
      x: e.clientX,
      y: e.clientY,
      absolutePath: absPath,
      relativePath: rel,
      isDir: true,
      onRename: () => setRenaming(true),
    });
  };

  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (renaming) renameInputRef.current?.select(); }, [renaming]);

  const commitRename = async () => {
    if (renameVal.trim() && renameVal !== name) {
      const rel = getRelative();
      const absPath = folderPath.replace(/\\/g, '/') + '/' + rel;
      try {
        await commands.fsRename(absPath, renameVal.trim());
        dispatchFsRefresh(folderPath);
      } catch (e) { console.error('[Explorer] rename failed:', e); }
    }
    setRenaming(false);
  };

  return (
    <div className="tree-dir">
      <div
        className={`tree-dir-header ${open ? '' : 'collapsed'} ${renaming ? 'renaming' : ''}`}
        onClick={() => !renaming && setOpen(!open)}
        onContextMenu={handleCtxMenu}
      >
        <span className={`tree-arrow ${open ? '' : 'closed'}`}>▾</span>
        <span className="tree-icon">
          <img src={getIconPath(iconTheme, open ? 'folder-open.svg' : 'folder-closed.svg')} alt="dir" className="icon-svg" />
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
  const { state: { iconTheme } } = useAppState();
  const badge = file.symbols.length > 0 ? `${file.symbols.length} sym` : formatBytes(file.size);
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (renaming) renameInputRef.current?.select(); }, [renaming]);

  const commitRename = async () => {
    if (renameVal.trim() && renameVal !== name) {
      const absPath = folderPath.replace(/\\/g, '/') + '/' + file.relative_path;
      try {
        await commands.fsRename(absPath, renameVal.trim());
        dispatchFsRefresh(folderPath);
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
      absolutePath: folderPath.replace(/\\/g, '/') + '/' + file.relative_path,
      relativePath: file.relative_path,
      isDir: false,
      onRename: () => setRenaming(true),
    });
  };

  return (
    <div className={`tree-file ${renaming ? 'renaming' : ''}`} onContextMenu={handleCtxMenu}>
      <span className="tree-icon">
        <img src={getFileIconSrc(file.extension, iconTheme)} alt="err" className="icon-svg" onError={(e) => (e.currentTarget.src = getIconPath(iconTheme, 'file.svg'))} />
      </span>
      <span className="tree-fname" style={{ display: renaming ? 'none' : undefined }}>{name}</span>
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
      <span className="tree-badge">{badge}</span>
    </div>
  );
}

// ─── Drive Kind → SVG Icon Path ──────────────────────────────────────────────

// Reverted to using standard folder icons for minimalist aesthetic
const DRIVE_ICONS: Record<string, string> = {};

// ─── Lazy Directory Browser Node ─────────────────────────────────────────────

/** A single expandable directory node for the "My Computer" tab.
 *  Loads children lazily from the backend on first expand. */
function BrowserDirNode({ name, dirPath, icon, onCtxMenu }: { name: string; dirPath: string; icon?: string; onCtxMenu: (menu: CtxMenuState) => void }) {
  const { state: { iconTheme } } = useAppState();
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntryInfo[] | null>(null);
  const [loading, setLoading] = useState(false);

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
        const parentDir = absPath.replace(/\/[^\/]+$/, '');
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

  return (
    <div className="tree-dir">
      <div className={`tree-dir-header ${renaming ? 'renaming' : ''}`} onClick={() => !renaming && toggle()} onContextMenu={handleDirCtxMenu}>
        <span className={`tree-arrow ${open ? '' : 'closed'}`}>▾</span>
        <span className="tree-icon">
          <img src={icon || getIconPath(iconTheme, open ? 'folder-open.svg' : 'folder-closed.svg')} alt="dir" className="icon-svg" />
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

  return (
    <div className={`tree-file ${renaming ? 'renaming' : ''}`} onContextMenu={handleCtxMenu}>
      <span className="tree-icon">
        <img
          src={getFileIconSrc(entry.name.split('.').pop() || '', iconTheme)}
          alt="file"
          className="icon-svg"
          onError={(e) => (e.currentTarget.src = getIconPath(iconTheme, 'file.svg'))}
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
      <span className="tree-badge">{formatBytes(entry.size)}</span>
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

  // Theme menu state
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeBtnRef = useRef<HTMLButtonElement>(null);

  // Language dropdown state
  const [langDropdownOpen, setLangDropdownOpen] = useState(false);
  const langBtnRef = useRef<HTMLButtonElement>(null);

  // Update check
  const [hasUpdate, setHasUpdate] = useState(false);
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

  const [activeTab, setActiveTab] = useState<'workspace' | 'computer'>('workspace');
  const [drives, setDrives] = useState<DriveInfo[]>([]);

  // Automatically switch to "My Computer" tab when a remote terminal is focused
  useEffect(() => {
    if (activeSession?.tool === 'remote') {
      setActiveTab('computer');
    }
  }, [state.activeTerminalId, activeSession?.tool]);

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

          // 2. Also tell the backend (for watcher + scan data)
          await commands.scanFolder(selected);

          // 3. Force unmount-remount of the TierTerminal to restart the Agent in the new dir
          dispatch({ type: 'RESTART_TERMINAL', id: activeTerminalId, newId: crypto.randomUUID() });
        }
      }
    } catch (err) {
      console.error('[Explorer] Failed to open folder:', err);
    }
  };

  // Load drives when the "My Computer" tab is activated
  useEffect(() => {
    if (activeTab === 'computer' && drives.length === 0) {
      commands.listDrives().then(setDrives).catch(() => {});
    }
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps



  // When any fs operation touches a path inside the workspace folder, re-scan so the
  // Workspace tab tree stays in sync (BrowserDirNode handles the Computer tab itself).
  useEffect(() => {
    if (!folderPath) return;
    const normFolder = folderPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ dirPath: string }>;
      const normDir = ev.detail.dirPath.replace(/\\/g, '/').replace(/\/+$/, '');
      if (normDir === normFolder || normDir.startsWith(normFolder + '/')) {
        commands.scanFolder(folderPath).then(data => {
          dispatch({ type: 'SET_SCAN', data });
        }).catch(() => {});
      }
    };
    window.addEventListener('fs-refresh', handler);
    return () => window.removeEventListener('fs-refresh', handler);
  }, [folderPath, dispatch]);


  const treeRoot = useMemo(() => buildTree(files), [files]);

  return (
    <div className="panel panel-left explorer-panel" data-icon-theme={state.iconTheme}>
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
          <span>{t('app.title')}</span>
          {hasUpdate && (
            <button
              className="icon-btn xs update-check-btn update-available"
              onClick={() => commands.openUrl('https://coffeecli.com')}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
            </button>
          )}
        </div>
        
        <div className="window-controls">
          <button
            className={`icon-btn xs ${activeSession?.gambitOpen ? 'active' : ''}`}
            onClick={() => {
              if (state.activeTerminalId) {
                dispatch({ type: 'TOGGLE_GAMBIT', id: state.activeTerminalId });
              }
            }}
          >
            {activeSession?.gambitOpen ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 6 L18 18 M6 18 L18 6" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            )}
          </button>
          <button
            ref={themeBtnRef}
            className="icon-btn xs"
            onClick={() => setThemeMenuOpen(v => !v)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </button>
          <button
            ref={langBtnRef}
            className="icon-btn xs lang-btn lang-glyph"
            onClick={() => setLangDropdownOpen(!langDropdownOpen)}
          >
            {getLangGlyph(state.currentLang)}
          </button>
        </div>
      </div>

      <div className="explorer-tabs">
        <button
          className={`explorer-tab ${activeTab === 'computer' ? 'active' : ''}`}
          onClick={() => setActiveTab('computer')}
        >
          {t('explorer.tab.computer' as any)}
        </button>
        <button
          className={`explorer-tab ${activeTab === 'workspace' ? 'active' : ''}`}
          onClick={() => setActiveTab('workspace')}
        >
          {t('explorer.tab.workspace' as any)}
        </button>
      </div>

      {(activeTab === 'workspace' && activeSession?.tool) && (
        <button
          className="workspace-dir-btn"
          onClick={handleOpenFolder}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"></path>
          </svg>
          <span className="workspace-dir-path">
            {activeSession.folderPath || t('explorer.workspace.select-dir' as any)}
          </span>
        </button>
      )}

      {/* File list Content */}
      <div className="panel-content explorer-content">
        {activeTab === 'computer' ? (
          <ScrollPanel>
            <div className="file-tree-container">
              {drives.length === 0 ? (
                <div style={{ padding: '16px', color: 'var(--text-3)', fontSize: 12, textAlign: 'center' }}>Loading drives...</div>
              ) : (
                drives.map(drive => {
                  // i18n: translate the drive label via its kind
                  const i18nKey = `drive.${drive.kind}` as any;
                  const driveLabel = t(i18nKey, { label: drive.label });
                  const driveIcon = DRIVE_ICONS[drive.kind] || undefined;
                  return (
                    <BrowserDirNode
                      key={drive.path}
                      name={driveLabel}
                      dirPath={drive.path}
                      icon={driveIcon}
                      onCtxMenu={handleCtxMenu}
                    />
                  );
                })
              )}
            </div>
          </ScrollPanel>
        ) : !folderPath ? (
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
                  <div className="shimmer-box" style={{ width: 14, height: 14, borderRadius: 'var(--radius-xs)', flexShrink: 0 }}></div>
                  <div className="shimmer-box" style={{ width: `${30 + (i * 7) % 40}%`, height: 12, borderRadius: 'var(--radius-xs)' }}></div>
                </div>
              ))}
            </div>
          </ScrollPanel>
        ) : (
          <ScrollPanel>
            <div className="file-tree-container">
              {Object.entries(treeRoot.children)
                .sort(([aK, aV], [bK, bV]) => {
                  const aIsDir = aV.type === 'dir';
                  const bIsDir = bV.type === 'dir';
                  if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
                  return aK.localeCompare(bK);
                })
                .map(([name, node]) => (
                node.type === 'dir'
                  ? <DirNode key={name} name={name} node={node as TreeNode} folderPath={folderPath!} onCtxMenu={handleCtxMenu} />
                  : <FileNode key={name} name={name} file={(node as { data: FileEntry }).data} folderPath={folderPath!} onCtxMenu={handleCtxMenu} />
              ))}
            </div>
          </ScrollPanel>
        )}
      </div>



      {/* Right-click context menu */}
      {ctxMenu && <ContextMenu menu={ctxMenu} onClose={closeCtxMenu} />}

      {/* Language dropdown */}
      {langDropdownOpen && (
        <LangDropdown
          anchorRef={langBtnRef}
          currentLang={state.currentLang}
          onSelect={(code) => {
            dispatch({ type: 'SET_LANG', lang: code });
            try {
              localStorage.setItem('cc-lang', code);
              if (code !== 'en') localStorage.setItem('cc-native-lang', code);
            } catch {}
            setLangDropdownOpen(false);
          }}
          onClose={() => setLangDropdownOpen(false)}
        />
      )}

      {/* Theme menu (color × shape × icon style × wallpaper × term fg) */}
      {themeMenuOpen && (
        <ThemeMenu
          anchorRef={themeBtnRef}
          currentTheme={state.currentTheme}
          currentShape={state.currentShape}
          currentIconTheme={state.iconTheme}
          hasBg={state.bgType !== 'none' && state.bgPath !== ''}
          termColorScheme={state.termColorScheme}
          onSelectTheme={(t) => dispatch({ type: 'SET_THEME', theme: t })}
          onSelectShape={(s) => dispatch({ type: 'SET_SHAPE', shape: s })}
          onSelectPreset={(t, s) => {
            dispatch({ type: 'SET_THEME', theme: t });
            dispatch({ type: 'SET_SHAPE', shape: s });
          }}
          onSelectIconTheme={(t) => {
            dispatch({ type: 'SET_ICON_THEME', theme: t });
            try { localStorage.setItem('cc-icon-theme', t); } catch {}
          }}
          onPickBg={async () => {
            try {
              const { open } = await import('@tauri-apps/plugin-dialog');
              const selected = await open({
                filters: [{ name: 'Background', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm'] }],
              });
              if (selected && typeof selected === 'string') {
                const ext = selected.split('.').pop()?.toLowerCase() || '';
                const bgType = ['mp4', 'webm'].includes(ext) ? 'video' : 'image';
                try { localStorage.setItem('cc-bg-path', selected); localStorage.setItem('cc-bg-type', bgType); } catch {}
                dispatch({ type: 'SET_BG', path: selected, bgType });
              }
            } catch (err) { console.error('[ThemeMenu] Background picker failed:', err); }
          }}
          onClearBg={() => {
            try { localStorage.removeItem('cc-bg-path'); localStorage.removeItem('cc-bg-type'); } catch {}
            dispatch({ type: 'CLEAR_BG' });
          }}
          onSelectScheme={(id) => {
            try { id ? localStorage.setItem('cc-term-scheme', id) : localStorage.removeItem('cc-term-scheme'); } catch {}
            dispatch({ type: 'SET_TERM_SCHEME', scheme: id });
          }}
          onClose={() => setThemeMenuOpen(false)}
          t={t}
        />
      )}
    </div>
  );
}
