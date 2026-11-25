// FontPicker.tsx — themed, searchable terminal-font dropdown.
//
// Replaces a native <select>, which (a) can't be themed — its option list is
// OS-painted (rendered pure white on Windows), and (b) can't even open while a
// terminal is active: the global focus-enforcer (CenterPanel) steals focus back
// to the terminal for any non-INPUT/TEXTAREA element, and a <select> is one.
//
// This is React-state-controlled (the enforcer can't close it) and portaled to
// body (escapes the modal's scroll clipping). The search <input> is safe — the
// enforcer explicitly leaves INPUT focused. Each option previews in its own
// font. Theming uses the same vars as .ctx-menu so it tracks every theme.

import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/useT';
import type { FontInfo } from '../../tauri';

interface FontPickerProps {
  fonts: FontInfo[] | null;
  value: string;
  onChange: (family: string) => void;
}

export function FontPicker({ fonts, value, onChange }: FontPickerProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const defaultLabel = t('settings.terminal.font.default');
  const label = value || defaultLabel;

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 4, width: r.width });
    setQuery('');
    setOpen(true);
  };

  useEffect(() => {
    if (open) {
      const id = setTimeout(() => searchRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [open]);

  // Keep the portaled menu glued to the trigger if the modal body scrolls or
  // the window resizes while open (the menu is fixed-positioned). Capture
  // phase so it catches the scrolling settings body, not just window scroll.
  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (r) setPos({ left: r.left, top: r.bottom + 4, width: r.width });
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  const { mono, other } = useMemo(() => {
    const list = fonts || [];
    const q = query.trim().toLowerCase();
    const f = q ? list.filter((x) => x.family.toLowerCase().includes(q)) : list;
    return { mono: f.filter((x) => x.monospace), other: f.filter((x) => !x.monospace) };
  }, [fonts, query]);

  const pick = (family: string) => {
    onChange(family);
    setOpen(false);
  };

  const renderOpt = (family: string, displayFont: string) => (
    <button
      key={family || '__default'}
      className={`settings-font-opt${value === family ? ' active' : ''}`}
      style={displayFont ? { fontFamily: displayFont } : undefined}
      onClick={() => pick(family)}
    >
      {family || defaultLabel}
    </button>
  );

  return (
    <>
      <button ref={triggerRef} className="settings-font-trigger" onClick={toggle}>
        <span className="settings-font-current">{label}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && pos && createPortal(
        <>
          <div className="settings-font-backdrop" onClick={() => setOpen(false)} />
          <div
            className="settings-font-menu"
            style={{ position: 'fixed', left: pos.left, top: pos.top, width: pos.width }}
          >
            <input
              ref={searchRef}
              className="settings-font-search"
              placeholder={t('settings.font.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="settings-font-list">
              {!query && renderOpt('', '')}
              {fonts === null && (
                <div className="settings-font-hint">{t('diff.loading')}</div>
              )}
              {mono.length > 0 && (
                <div className="settings-font-group">{t('settings.font.monospace')}</div>
              )}
              {mono.map((f) => renderOpt(f.family, `"${f.family}", monospace`))}
              {other.length > 0 && (
                <div className="settings-font-group">{t('settings.font.other')}</div>
              )}
              {other.map((f) => renderOpt(f.family, `"${f.family}"`))}
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  );
}
