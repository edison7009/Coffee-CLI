import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../../i18n/useT';
import { ToolMemoryPanel } from './ToolMemoryPanel';
import './ToolSettingsPage.css';

export function ToolSettingsPage({ active, tools, count, limit, children }: {
  active: boolean; tools: { value: string; label: string; icon: ReactNode }[]; count: number; limit: number; children: ReactNode;
}) {
  const t = useT(), id = useId();
  const [tab, setTab] = useState<'selection' | 'memory' | 'skills' | 'mcp'>('selection');
  const tabList = useRef<HTMLSpanElement>(null), indicator = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const list = tabList.current, marker = indicator.current;
    if (!active || !list || !marker) return;
    let frame: number | undefined;
    const align = () => {
      const selected = list.querySelector<HTMLButtonElement>('[aria-selected="true"]');
      if (!selected?.offsetWidth) return;
      marker.style.width = `${selected.offsetWidth}px`;
      marker.style.transform = `translateX(${selected.offsetLeft}px)`;
      if (!marker.dataset.ready && frame === undefined) frame = requestAnimationFrame(() => { marker.dataset.ready = 'true'; frame = undefined; });
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(list);
    list.querySelectorAll('button').forEach(button => observer.observe(button));
    return () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [active, tab, count, limit, t]);
  const tabs = ['selection', 'memory', 'skills', 'mcp'] as const;
  return <section className={`tool-settings-page${tab === 'memory' ? ' tool-settings-page--memory' : ''}`} aria-label={t('tools.title')} style={active ? undefined : { display: 'none' }}>
    <div className="tool-settings-inner">
      <span ref={tabList} className="tool-settings-tabs" role="tablist" aria-label={t('tools.title')}>
        <span ref={indicator} className="tool-settings-indicator" aria-hidden="true" />
        {tabs.map((key, index) => <button type="button" key={key} id={`${id}-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`${id}-panel-${key}`} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          setTab(tabs[next]); document.getElementById(`${id}-tab-${tabs[next]}`)?.focus();
        }}>{t(`tools.tab.${key}`)}{key === 'selection' && <span className="tool-settings-tab-count"> {count}/{limit}</span>}</button>)}
      </span>
      {tabs.map(key => <div key={key} id={`${id}-panel-${key}`} role="tabpanel" aria-labelledby={`${id}-tab-${key}`} className="tool-settings-panel" hidden={tab !== key}>
        {key === 'selection' ? (active && tab === 'selection' ? children : null) : key === 'memory' ? <ToolMemoryPanel active={active && tab === 'memory'} tools={tools} /> : <div className="tool-settings-placeholder">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{key === 'skills' ? <><path d="M12 7v14M3 3h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3z" /></> : <><rect x="8" y="3" width="8" height="6" rx="1" /><path d="M12 9v5M4 14h16M4 14v3m8-3v3m8-3v3" /><path d="M2 17h4v4H2zm8 0h4v4h-4zm8 0h4v4h-4z" /></>}</svg>
          <p>{t(key === 'skills' ? 'tools.skills.placeholder' : 'tools.mcp.placeholder')}</p>
        </div>}
      </div>)}
    </div>
  </section>;
}
