// Narrow windows and phones show only the current tab in the strip; this button lists every tab,
// so switching and closing stay one tap away without squeezing tabs into slivers.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/useT';

export interface CompactTab { id: string; icon: ReactNode; title: string; status?: string; active: boolean }

export function CompactTabMenu({ tabs, onPick, onClose }: { tabs: CompactTab[]; onPick: (id: string) => void; onClose: (event: React.MouseEvent, id: string) => void }) {
  const t = useT();
  // Where the list opens; null while closed.
  const [rect, setRect] = useState<DOMRect | null>(null);
  const open = rect !== null;
  const setOpen = (next: boolean) => setRect(next && button.current ? button.current.getBoundingClientRect() : null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Click elsewhere or Escape closes the list.
  useEffect(() => {
    if (!open) return;
    const down = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); };
  }, [open]);

  return <>
    <button ref={button} type="button" className="compact-tabs-button" aria-haspopup="menu" aria-expanded={open} aria-label={t('tabs.all', { count: String(tabs.length) })}
      onClick={() => setOpen(!open)}>
      <span>{tabs.length}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {rect && createPortal(<div ref={menu} className="ctx-menu compact-tabs-menu" role="menu" aria-label={t('tabs.all', { count: String(tabs.length) })}
      style={{ position: 'fixed', top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)) }}>
      {tabs.map(tab => <div key={tab.id} role="menuitem" tabIndex={0} className={`compact-tabs-item${tab.active ? ' is-active' : ''}`}
        onClick={() => { setOpen(false); onPick(tab.id); }}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(false); onPick(tab.id); } }}>
        <span className="compact-tabs-icon">{tab.icon}</span>
        <span className="compact-tabs-title">{tab.title}</span>
        {tab.status && <i className={`compact-tabs-status status-${tab.status}`} aria-hidden="true" />}
        <button type="button" className="compact-tabs-close" aria-label={t('tabs.close')} onClick={event => { event.stopPropagation(); onClose(event, tab.id); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>)}
    </div>, document.body)}
  </>;
}
