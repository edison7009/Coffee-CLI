import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { commands, type CatalogSkill, type SkillInventory, type ToolSkill } from '../../tauri';
import { readSkillInventory, saveSkillInventory, readSkillCatalogue, fetchSkillCatalogue, readSkillDescription, fetchSkillDescription } from '../../lib/tool-skills';
import { useT } from '../../i18n/useT';
import type { I18nKey } from '../../i18n/en';
import './ToolSkillsPanel.css';

const tabLabels: Record<string, string> = {
  claude:'Claude', codex:'Codex', cursor:'Cursor', copilot:'Copilot', antigravity:'Antigrav.',
  openclaw:'OpenClaw', hermes:'Hermes', opencode:'OpenCode', pi:'Pi', cline:'Cline', goose:'Goose', aider:'Aider',
  omp:'OhMyPi', crush:'Crush', qwen:'Qwen', kilo:'Kilo', kiro:'Kiro', kimicode:'Kimi',
  codebuddy:'CodeBuddy', grok:'Grok', mimocode:'MiMo', minimax:'MiniMax', muse:'Muse',
};

const errorKeys: Record<string, I18nKey> = {
  skills_network:'skills.network_error', skills_source:'skills.source_error', skills_size:'skills.size_error',
  skills_modified:'skills.modified_error', skills_exists:'skills.exists_error', skills_unsupported:'skills.unsupported', skills_read:'skills.read_error',
};
function SkillCardDetails({ item, children }: { item: CatalogSkill | ToolSkill; children: ReactNode }) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const [description, setDescription] = useState(item.description || (item.source && readSkillDescription(item.source, item.name)) || '');
  const [avatarFailed, setAvatarFailed] = useState(false);
  const owner = item.source?.split('/')[0];
  const avatar = owner && /^[\w.-]+$/.test(owner) ? `https://github.com/${owner}.png?size=80` : null;
  useEffect(() => {
    if (item.description || !item.source || !host.current) return;
    let cancelled = false;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void fetchSkillDescription(item.source!, item.name).then(value => { if (!cancelled) setDescription(value); }).catch(() => {});
    }, { rootMargin:'120px' });
    observer.observe(host.current);
    return () => { cancelled = true; observer.disconnect(); };
  }, [item.source, item.name, item.description]);
  return <div ref={host} className="skill-details">
    <div className="skill-card-top">
      <div className="skill-identity">
        <span className="skill-avatar" aria-hidden="true">{avatar && !avatarFailed ? <img src={avatar} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setAvatarFailed(true)} /> : item.name.slice(0, 1).toUpperCase()}</span>
        <div className="skill-card-heading"><strong>{item.name}</strong><span className="skill-source">{item.source ? <button type="button" onClick={() => { void commands.openUrl(`https://github.com/${item.source}`).catch(() => {}); }}>{item.source}</button> : t('skills.local')}</span></div>
      </div>
      {children}
    </div>
    <p className="skill-description">{item.description || description || '\u00a0'}</p>
  </div>;
}
export function ToolSkillsPanel({ active, tools }: { active: boolean; tools: { value: string; label: string; icon: ReactNode }[] }) {
  const t = useT();
  const enabled = tools.slice(0, 6), toolKeys = enabled.map(item => item.value).join('|');
  const [selected, setSelected] = useState('discover'), [query, setQuery] = useState('');
  const view = enabled.some(item => item.value === selected) ? selected : 'discover';
  const [inventories, setInventories] = useState<Record<string, SkillInventory>>({});
  const inventoryFor = (tool: string) => inventories[tool] ?? readSkillInventory(tool);
  const inventory = inventoryFor(view);
  const [catalogues, setCatalogues] = useState<Record<string, CatalogSkill[]>>({});
  const search = query.trim().length >= 2 ? query.trim() : '';
  const catalogue = catalogues[search] ?? readSkillCatalogue(search) ?? [];
  const [error, setError] = useState<{ scope: string; key: I18nKey; label?: string } | null>(null);
  const [pending, setPending] = useState<{ key: string; tool: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null), [confirm, setConfirm] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tip, setTip] = useState<{ label: string; left: number; top: number } | null>(null);
  const tabList = useRef<HTMLSpanElement>(null), tabMarker = useRef<HTMLSpanElement>(null);
  const versions = useRef<Record<string, number>>({}), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => {
    const list = tabList.current, marker = tabMarker.current;
    if (!active || !list || !marker) return;
    const align = () => {
      const current = list.querySelector<HTMLButtonElement>('[aria-selected="true"]');
      if (current?.offsetWidth) marker.style.transform = `translateX(${current.offsetLeft + (current.offsetWidth - 28) / 2}px)`;
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(list); list.querySelectorAll('button').forEach(button => observer.observe(button));
    return () => observer.disconnect();
  }, [active, view, toolKeys]);
  const remember = (key: string, value: SkillInventory) => {
    saveSkillInventory(key, value);
    if (alive.current) setInventories(previous => ({ ...previous, [key]:value }));
  };
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    for (const tool of toolKeys.split('|').filter(Boolean)) {
      const version = versions.current[tool] = (versions.current[tool] ?? 0) + 1;
      void commands.getToolSkills(tool).then(value => {
        if (cancelled || versions.current[tool] !== version) return;
        saveSkillInventory(tool, value); setInventories(previous => ({ ...previous, [tool]:value }));
        if (value.skills.some(item => item.managed)) void commands.checkToolSkillUpdates(tool).then(value => {
          if (cancelled || versions.current[tool] !== version) return;
          saveSkillInventory(tool, value); setInventories(previous => ({ ...previous, [tool]:value }));
        }).catch(() => {});
      }).catch(reason => { if (!cancelled && versions.current[tool] === version) setError({ scope:tool, key:errorKeys[String(reason)] ?? 'skills.read_error' }); });
    }
    return () => { cancelled = true; };
  }, [active, toolKeys]);
  useEffect(() => {
    if (!active || view !== 'discover') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      void fetchSkillCatalogue(search).then(items => {
        if (!cancelled) { setCatalogues(previous => ({ ...previous, [search]:items })); setError(previous => previous?.key === 'skills.network_error' ? null : previous); }
      }).catch(reason => { if (!cancelled) setError({ scope:'discover', key:errorKeys[String(reason)] ?? 'skills.network_error' }); }).finally(() => { if (!cancelled) setLoading(false); });
    }, search ? 350 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, view, search]);
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null); window.addEventListener('scroll', hide, true); window.addEventListener('resize', hide);
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); };
  }, [tip]);
  const showTip = (label: string, element: HTMLElement) => {
    const r = element.getBoundingClientRect();
    setTip({ label, left:Math.max(8, Math.min(r.left, window.innerWidth - 248)), top:r.bottom + 6 });
  };
  const navigate = (next: string) => { setSelected(next); setError(null); setConfirm(null); setExpanded(null); setTip(null); };
  const operate = async (item: CatalogSkill | ToolSkill, tool: string, remove = false) => {
    if (pending || !enabled.some(entry => entry.value === tool) || !inventoryFor(tool)?.supported || !remove && !item.source) return;
    const key = 'path' in item ? item.path : `${item.source}/${item.name}`;
    versions.current[tool] = (versions.current[tool] ?? 0) + 1;
    setPending({ key, tool }); setError(null); setConfirm(null); setTip(null);
    try {
      const value = remove && 'path' in item ? await commands.removeToolSkill(tool, item.path) : await commands.installToolSkill(tool, item.source!, item.name);
      versions.current[tool] = (versions.current[tool] ?? 0) + 1;
      remember(tool, value);
    } catch (reason) { if (alive.current) setError({ scope:view, label:enabled.find(entry => entry.value === tool)?.label, key:errorKeys[String(reason)] ?? 'skills.write_error' }); }
    finally { if (alive.current) setPending(null); }
  };
  const installed = inventory?.skills ?? [];
  const searching = view === 'discover' && loading;
  const items = view === 'discover' ? catalogue : installed.filter(item => `${item.name} ${item.description} ${item.source ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  if (!active) return null;
  return <div className="tool-skills">
    <div className="skills-toolbar">
      <span ref={tabList} className="skills-tabs" role="tablist" aria-label="Skills">
        <span ref={tabMarker} className="skills-tab-marker" aria-hidden="true" />
        <button type="button" role="tab" aria-label={t('skills.discover')} aria-selected={view === 'discover'} onClick={() => navigate('discover')}><span className="skills-tool-icon skills-discover-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="9" /><path d="m16 8-2.5 5.5L8 16l2.5-5.5Z" /></svg></span><span className="skills-tab-label">{t('skills.discover')}</span></button>
        {enabled.map(entry => <button key={entry.value} type="button" role="tab" aria-label={entry.label} aria-selected={view === entry.value} onClick={() => navigate(entry.value)}><span className="skills-tool-icon" aria-hidden="true">{entry.icon}</span><span className="skills-tab-label">{tabLabels[entry.value] ?? entry.label}</span></button>)}
      </span>
      <div className="skills-search">{searching ? <span className="skill-spinner" aria-hidden="true" /> : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="7.5" /><path d="m16 16 5 5" /></svg>}<input aria-label={t('skills.search')} placeholder={t('skills.search')} value={query} maxLength={200} onChange={event => setQuery(event.target.value)} /></div>
    </div>
    {active && tip && createPortal(<span className="tool-memory-tool-tip" role="tooltip" style={{ left:tip.left, top:tip.top }}>{tip.label}</span>, document.body)}
    {error?.scope === view && <p className="skills-error" role="alert">{error.label && `${error.label} · `}{t(error.key)}</p>}
    {view !== 'discover' && inventory?.supported === false ? <div className="skills-empty">{t('skills.unsupported')}</div> : <div className="skills-grid" aria-busy={!!pending || searching}>
      {items.map(item => {
        const local = 'path' in item ? item : null;
        const key = 'path' in item ? item.path : `${item.source}/${item.name}`;
        const recipients = enabled.filter(entry => inventoryFor(entry.value)?.skills.some(skill => skill.name === item.name && skill.source === item.source));
        const open = expanded === key;
        return <article key={key} className="skill-card">
          <SkillCardDetails item={item}>
            {view === 'discover' ? <button type="button" className="skill-install" aria-expanded={open} disabled={enabled.length === 0} onClick={() => { setExpanded(open ? null : key); setTip(null); }}>{t('skills.install')}</button> : <div className="skill-card-actions">
              {local?.managed && local.update && !local.modified && <button type="button" className="skill-install" disabled={!!pending} onClick={() => { void operate(local, view); }}>{pending?.key === key ? <span className="skill-spinner" /> : t('skills.update')}</button>}
              {local?.managed && <button type="button" className="skills-icon-button skill-remove" aria-label={`${t('skills.remove')} ${item.name}`} disabled={!!pending} onClick={() => setConfirm(key)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></svg></button>}
            </div>}
          </SkillCardDetails>
          {local?.modified && <span className="skill-status">{t('skills.modified')}</span>}
          {view === 'discover' && recipients.length > 0 && !open && <div className="skill-installed-tools">{recipients.map(entry => <span key={entry.value} className="skills-tool-icon" role="img" aria-label={`${entry.label} · ${t('skills.installed')}`} tabIndex={0} onMouseEnter={event => showTip(`${entry.label} · ${t('skills.installed')}`, event.currentTarget)} onMouseLeave={() => setTip(null)} onFocus={event => showTip(`${entry.label} · ${t('skills.installed')}`, event.currentTarget)} onBlur={() => setTip(null)}>{entry.icon}</span>)}</div>}
          {view === 'discover' && <div className="skill-targets-expander" data-open={open} aria-hidden={!open} inert={!open}><div><div className="skill-install-targets" role="group" aria-label={`${t('skills.install')} ${item.name}`}>
            {enabled.map(entry => {
              const matches = inventoryFor(entry.value)?.skills.filter(skill => skill.name === item.name) ?? [];
              const existing = matches.find(skill => skill.source === item.source) ?? matches[0];
              const present = existing?.source === item.source && !!existing;
              const unsupported = inventoryFor(entry.value)?.supported === false;
              const busy = pending?.key === key && pending.tool === entry.value;
              const label = `${entry.label} · ${t(present ? 'skills.installed' : unsupported ? 'skills.unsupported' : existing ? 'skills.exists_error' : 'skills.click_install')}`;
              return <button type="button" key={entry.value} aria-label={`${t(present ? 'skills.installed' : 'skills.install')} · ${entry.label}`} aria-pressed={present} data-installed={present} disabled={!!pending || !inventoryFor(entry.value)?.supported || !!existing} onClick={() => { void operate(item, entry.value); }} onMouseEnter={event => showTip(label, event.currentTarget)} onMouseLeave={() => setTip(null)} onFocus={event => showTip(label, event.currentTarget)} onBlur={() => setTip(null)}><span className="skills-tool-icon" aria-hidden="true">{busy ? <span className="skill-spinner" /> : entry.icon}</span>{present && <svg className="skill-installed-check" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg>}</button>;
            })}
          </div></div></div>}
          {confirm === key && local && <div className="skill-remove-confirm"><span>{t('skills.remove_confirm', { name:item.name })}</span><button type="button" onClick={() => setConfirm(null)}>{t('tool_config.cancel')}</button><button type="button" className="skill-remove-action" disabled={!!pending} onClick={() => { void operate(local, view, true); }}>{t('skills.remove')}</button></div>}
        </article>;
      })}
      {items.length === 0 && !searching && error?.scope !== view && <div className="skills-empty">{t(view === 'discover' ? 'skills.no_results' : 'skills.empty')}</div>}
    </div>}
  </div>;
}
