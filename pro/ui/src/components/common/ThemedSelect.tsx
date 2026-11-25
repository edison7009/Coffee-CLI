import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './SettingsModal.css';
import './ThemedSelect.css';

/** `wide` spans the whole row of a two-column menu; `group` draws a divider above it and starts a new row. */
export interface ThemedSelectOption { value: string; label: string; icon?: ReactNode; wide?: boolean; group?: boolean }

/** Where each option sits in the menu: its row and column (wide ones and new groups always start a row). */
function gridOf(options: ThemedSelectOption[], columns: number) {
  let row = -1, col = columns;
  return options.map(option => {
    if (option.wide || option.group || col >= columns) { row++; col = 0; }
    const cell = { row, col };
    col = option.wide ? columns : col + 1;
    return cell;
  });
}

export function ThemedSelect({ label, value, options, onChange, disabled = false, className = '', menuClassName = '', align = 'start', menuWidth = 180, columns = 1 }: {
  disabled?: boolean; className?: string; menuClassName?: string; align?: 'start' | 'end'; menuWidth?: number; columns?: 1 | 2;
  label: string; value: string; options: ThemedSelectOption[]; onChange: (value: string) => void;
}) {
  const grid = useMemo(() => gridOf(options, columns), [options, columns]);
  const rows = (grid.at(-1)?.row ?? 0) + 1, groups = options.filter(option => option.group).length;
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const activeIndex = Math.min(highlight, options.length - 1);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const id = useId(), open = position !== null;
  const reposition = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
    const width = Math.min(Math.max(rect.width, menuWidth), window.innerWidth - 16);
    const maxHeight = Math.min(columns > 1 ? 480 : 320, window.innerHeight - 16), height = Math.min(rows * 36 + groups * 9 + 10, maxHeight);
    const left = align === 'end' ? rect.right - width : rect.left;
    setPosition({ left: Math.max(8, Math.min(left, window.innerWidth - width - 8)), top: rect.bottom + height + 4 > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : rect.bottom + 4, width, maxHeight });
  }, [rows, groups, columns, align, menuWidth]);
  const show = () => { setHighlight(Math.max(0, options.findIndex(option => option.value === value))); reposition(); };
  const pick = (next: string) => { onChange(next); setPosition(null); };
  useEffect(() => {
    if (!open) return;
    const update = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) reposition(); };
    window.addEventListener('scroll', update, true); window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); };
  }, [open, reposition]);
  useEffect(() => {
    if (open) document.getElementById(`${id}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, id]);
  return <>
    <button ref={trigger} type="button" disabled={disabled} className={`settings-font-trigger ${className}`} role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} aria-activedescendant={open ? `${id}-${activeIndex}` : undefined} onClick={() => open ? setPosition(null) : show()} onKeyDown={event => {
      const sideways = columns > 1 && open && (event.key === 'ArrowLeft' || event.key === 'ArrowRight');
      if (sideways || ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); }
      if (event.key === 'Escape' || event.key === 'Tab') { setPosition(null); return; }
      if (sideways) {
        setHighlight((activeIndex + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!open) show();
        else if (columns === 1) setHighlight((activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
        else {
          // Up and down keep the column: the nearest option in the row above or below, wrapping at the ends.
          const here = grid[activeIndex], row = (here.row + (event.key === 'ArrowDown' ? 1 : -1) + rows) % rows;
          const inRow = grid.flatMap((cell, index) => cell.row === row ? [{ index, distance: Math.abs(cell.col - here.col) }] : []);
          setHighlight(inRow.reduce((best, cell) => cell.distance < best.distance ? cell : best).index);
        }
      } else if (event.key === 'Home' || event.key === 'End') {
        if (!open) reposition(); setHighlight(event.key === 'Home' ? 0 : options.length - 1);
      } else if (event.key === 'Enter' || event.key === ' ') { if (open) pick(options[activeIndex].value); else show(); }
    }}><span className="settings-font-current">{options.find(option => option.value === value)?.label ?? value}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg></button>
    {position && createPortal(<>
      <div className="settings-font-backdrop" onClick={() => setPosition(null)} />
      <div ref={menu} id={id} role="listbox" aria-label={label} className={`settings-font-menu themed-select-menu${columns > 1 ? ' is-grid' : ''} ${menuClassName}`} style={{ position: 'fixed', ...position }}>
        {options.map((option, index) => <Fragment key={option.value}>
          {option.group && <div className="themed-select-divider" role="presentation" />}
          <button id={`${id}-${index}`} type="button" role="option" tabIndex={-1} aria-selected={value === option.value} className={`settings-font-opt${option.wide ? ' is-wide' : ''}${value === option.value ? ' active' : ''}${activeIndex === index ? ' is-highlighted' : ''}`} onMouseMove={() => setHighlight(index)} onMouseDown={event => event.preventDefault()} onClick={() => pick(option.value)}>
            {option.icon && <span className="themed-select-icon" aria-hidden="true">{option.icon}</span>}<span className="themed-select-label">{option.label}</span>
          </button>
        </Fragment>)}
      </div>
    </>, document.body)}
  </>;
}
