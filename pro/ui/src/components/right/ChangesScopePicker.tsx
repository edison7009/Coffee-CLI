import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/useT';
// Share the exact floating menu and option styles used by the settings font picker.
import '../common/SettingsModal.css';

export type ChangeScope = 'all' | 'working' | 'committed';

export function ChangesScopePicker({ value, onChange }: { value: ChangeScope; onChange: (value: ChangeScope) => void }) {
  const t = useT();
  const options = [{ value: 'all', label: t('changes.all_records') }, { value: 'working', label: t('changes.uncommitted') }, { value: 'committed', label: t('changes.session_commits') }] as const;
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = position !== null;
  const reposition = () => {
    const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
    const width = Math.min(Math.max(rect.width, 172), window.innerWidth - 16);
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: rect.bottom + 124 > window.innerHeight ? Math.max(8, rect.top - 124) : rect.bottom + 4, width });
  };
  const show = () => { setHighlight(options.findIndex(option => option.value === value)); reposition(); };
  const pick = (scope: ChangeScope) => { onChange(scope); setPosition(null); };
  useEffect(() => {
    if (!open) return;
    const update = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) reposition(); };
    window.addEventListener('scroll', update, true); window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); };
  }, [open]);

  return <>
    <div className="changes-scope-trigger">
      <button ref={trigger} type="button" role="combobox" aria-label={t('changes.scope')} aria-autocomplete="none" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} aria-activedescendant={open ? `${id}-${highlight}` : undefined} onClick={() => open ? setPosition(null) : show()} onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); }
        if (event.key === 'Escape' || event.key === 'Tab') { setPosition(null); return; }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (!open) show(); else setHighlight(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
        } else if (event.key === 'Home' || event.key === 'End') {
          if (!open) reposition(); setHighlight(event.key === 'Home' ? 0 : options.length - 1);
        } else if (event.key === 'Enter' || event.key === ' ') { if (open) pick(options[highlight].value); else show(); }
      }}><span>{options.find(option => option.value === value)?.label ?? ''}</span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>
    </div>
    {position && createPortal(<>
      <div className="settings-font-backdrop" onClick={() => setPosition(null)} />
      <div ref={menu} id={id} role="listbox" aria-label={t('changes.scope')} className="settings-font-menu changes-scope-menu" style={{ position: 'fixed', ...position }}>
        {options.map((option, index) => <button key={option.value} id={`${id}-${index}`} type="button" role="option" tabIndex={-1} aria-selected={value === option.value} className={`settings-font-opt${value === option.value ? ' active' : ''}${highlight === index ? ' is-highlighted' : ''}`} onMouseEnter={() => setHighlight(index)} onMouseDown={event => event.preventDefault()} onClick={() => pick(option.value)}>{option.label}</button>)}
      </div>
    </>, document.body)}
  </>;
}
