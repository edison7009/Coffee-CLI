import { useState, useSyncExternalStore } from 'react';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { folderName, getAutomations, scheduleSummary, subscribeAutomations, type AutomationTool } from '../../lib/automations';
import { getToolDisplayName } from '../../lib/tool-info';
import { InlineSvgIcon } from '../InlineSvgIcon';
import CLAUDE_DATA_URL from '../../icons-inline/claude.svg?inline';
import CODEX_SVG from '../../icons-inline/codex.svg?raw';
import DSH_DATA_URL from '../../icons-inline/dsh.png?inline';
import OPENCODE_DATA_URL from '../../icons-inline/opencode.png?inline';
import PI_SVG from '../../icons-inline/pi.svg?raw';
import './TaskAutomations.css';

const COLLAPSED_KEY = 'cc-task-automations-collapsed';

/** The five desktop tools' marks, from the same bytes the launchpad and history use. */
function ToolMark({ tool }: { tool: AutomationTool }) {
  if (tool === 'codex' || tool === 'pi') return <InlineSvgIcon markup={tool === 'codex' ? CODEX_SVG : PI_SVG} size="100%" />;
  const src = tool === 'claude' ? CLAUDE_DATA_URL : tool === 'dsh' ? DSH_DATA_URL : OPENCODE_DATA_URL;
  return <img src={src} alt="" className={tool === 'claude' ? undefined : 'task-automation-mark-tile'} />;
}

/**
 * Automations at the top of the task list: on or off at a glance, and each prompt sent to the current conversation
 * like a task. Editing stays on the automations page, which the name opens.
 */
export function TaskAutomations({ onSend }: { onSend: (prompt: string) => void }) {
  const t = useT();
  const { state, dispatch } = useAppState();
  const automations = useSyncExternalStore(subscribeAutomations, getAutomations, getAutomations);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; } });
  if (!automations.length) return null;
  const toggleSection = () => { const next = !collapsed; setCollapsed(next); try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* Best-effort operation; failure is non-fatal. */ } };
  const on = automations.filter(item => item.enabled).length;
  return <section className="task-automations" aria-label={t('automation.title')}>
    <button type="button" className="task-section-header task-automations-head" aria-expanded={!collapsed} onClick={toggleSection}>
      <svg className="task-automations-chevron" data-open={!collapsed} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
      <span>{t('automation.title')}</span>
      <span className="task-automations-count">{on}/{automations.length}</span>
    </button>
    {!collapsed && automations.map(item => <div key={item.id} className="task-card task-automation-card" data-enabled={item.enabled}
      // Like a note: a soft glow follows the pointer across the card.
      onPointerMove={e => { const r = e.currentTarget.getBoundingClientRect(); e.currentTarget.style.setProperty('--glow-x', `${e.clientX - r.left}px`); }}>
      <div className="task-automation-row">
        <button type="button" className="task-automation-name" onClick={() => dispatch({ type: 'SET_AUTOMATIONS_OPEN', open: true })}>
          <span className="task-automation-line">
            <span className="task-automation-title">{item.name}</span>
          </span>
          <span className="task-automation-sub">
            <span className="task-automation-mark" role="img" aria-label={getToolDisplayName(item.tool)}><ToolMark tool={item.tool} /></span>
            <span className="task-automation-meta">{scheduleSummary(item.schedule, t, state.currentLang)} · {folderName(item.cwd)}</span>
          </span>
        </button>
        <button type="button" className="task-automation-send" aria-label={t('automation.send_current')} onClick={() => onSend(item.prompt)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><polygon points="5 3 21 12 5 21" /></svg>
        </button>
      </div>
    </div>)}
  </section>;
}
