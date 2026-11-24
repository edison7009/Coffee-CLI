import { useEffect, useRef, useState, type ReactNode } from 'react';
import { commands } from '../../tauri';
import { useT } from '../../i18n/useT';
import { receiveOrchestration, refreshOrchestration, useOrchestration, type OrchestrationMode } from '../../lib/orchestration';
import { ToolControlDemo } from './ToolControlDemo';
import './ToolControlPanel.css';

const GUIDE_KEY = 'coffee:collab-guide-open';
/** How the 协作 page works: a card whose header folds it (its chevron on the right turns), the steps numbered in
 *  small rounds. Open until folded; the choice is remembered. */
function CollabGuide() {
  const t = useT();
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(GUIDE_KEY) !== '0'; } catch { return true; } });
  const toggle = () => setOpen(was => { const next = !was; try { localStorage.setItem(GUIDE_KEY, next ? '1' : '0'); } catch { /* best effort */ } return next; });
  return <section className={`collab-guide${open ? ' is-open' : ''}`}>
    <button type="button" className="collab-guide-head" aria-expanded={open} onClick={toggle}>
      {/* Lucide book-open; license in /icons/LICENSE-lucide.txt. */}
      <svg className="collab-guide-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 7v14" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" /></svg>
      <span>{t('collab.guide.title')}</span>
      <svg className="collab-guide-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && <ol className="collab-guide-steps">{(['collab.guide.1', 'collab.guide.2', 'collab.guide.3', 'collab.guide.4'] as const).map((step, index) => <li key={step}><i aria-hidden="true">{index + 1}</i><span>{t(step)}</span></li>)}</ol>}
  </section>;
}

export function ToolOrchestrationPanel({ active, tools }: {
  active: boolean; tools: { value: string; label: string; icon: ReactNode; installed?: boolean }[];
}) {
  const t = useT(), { agents = [], mode = 'auto' } = useOrchestration();
  const roles: OrchestrationMode[] = ['auto', 'manager', 'lead'];
  const [ready, setReady] = useState(false), [pending, setPending] = useState<string | null>(null), [error, setError] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    if (!active) return;
    const version = ++revision.current;
    void refreshOrchestration().then(() => { if (version === revision.current) { setReady(true); setError(false); } })
      .catch(() => { if (version === revision.current) setError(true); });
  }, [active]);
  return <div className="tool-control orchestration-config">
    <div className="tool-control-runtime">
      <span className="tool-control-symbol" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="11" y="3" width="10" height="8" rx="2" /><path d="M16 11v7M6 22v-4h20v4" /><rect x="2" y="22" width="8" height="7" rx="2" /><rect x="22" y="22" width="8" height="7" rx="2" /></svg></span>
      <div className="tool-control-summary"><strong>{t('tools.tab.orchestration')}</strong><p>{t('orchestration.description')}</p></div>
    </div>
    {/* How the pieces fit: helpers here, other computers, and the composer's 协作 chip. The steps are a real order. */}
    <CollabGuide />
    {error && <p className="tool-memory-notice" role="alert">{t(ready ? 'control.write_error' : 'control.read_error')}</p>}
    <div className="tool-control-agents">
      {tools.slice(0, 6).map(tool => {
        const supported = ['claude', 'codex', 'opencode', 'dsh', 'pi', 'antigravity'].includes(tool.value), missing = tool.installed === false;
        return <div className="tool-control-agent" key={tool.value}>
        <span className="tool-control-agent-icon" aria-hidden="true">{tool.icon}</span>
        <span className="tool-control-agent-name"><span className="tool-control-agent-label">{tool.label}</span></span>
        {(missing || !supported) && <span className="tool-control-state">{t(missing ? 'control.not_installed' : 'orchestration.unsupported')}</span>}
        {pending === tool.value && <span className="tool-control-spinner" aria-hidden="true" />}
        <button type="button" role="switch" className="tool-control-switch tool-control-card-toggle" aria-label={tool.label} aria-checked={agents.includes(tool.value)} data-unavailable={missing || !supported} disabled={!ready || pending !== null || missing || !supported} onClick={async () => {
          revision.current++;
          setPending(tool.value); setError(false);
          try { receiveOrchestration(await commands.orchestrationSetAgent(tool.value, !agents.includes(tool.value))); }
          catch { setError(true); }
          finally { revision.current++; setPending(null); }
        }}><span /></button>
      </div>})}
      {!tools.length && <span className="tool-control-no-agents">{t('control.no_agents')}</span>}
    </div>
    <div className="orchestration-roles-head"><strong>{t('orchestration.role.title')}</strong><span>{t('orchestration.role.hint')}</span></div>
    {/* One role at a time: each switch turns the others off, so they behave as one choice. */}
    <div className="tool-control-agents orchestration-roles" role="radiogroup" aria-label={t('orchestration.role.title')}>
      {roles.map(role => <div className="tool-control-agent orchestration-role" key={role}>
        <span className="tool-control-agent-name orchestration-role-text"><span className="tool-control-agent-label">{t(`orchestration.role.${role}`)}</span><span className="orchestration-role-desc">{t(`orchestration.role.${role}_desc`)}</span></span>
        {pending === `role:${role}` && <span className="tool-control-spinner" aria-hidden="true" />}
        <button type="button" role="radio" className="tool-control-switch tool-control-card-toggle" aria-label={t(`orchestration.role.${role}`)} aria-checked={mode === role} disabled={!ready || pending !== null} onClick={async () => {
          if (mode === role) return;
          revision.current++;
          setPending(`role:${role}`); setError(false);
          try { receiveOrchestration(await commands.orchestrationSetMode(role)); }
          catch { setError(true); }
          finally { revision.current++; setPending(null); }
        }}><span /></button>
      </div>)}
    </div>
    {active && <ToolControlDemo kind="orchestration" />}
  </div>;
}
