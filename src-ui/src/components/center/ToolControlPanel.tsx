import { useEffect, useRef, useState, type ReactNode } from 'react';
import { commands, type ToolControlStatus } from '../../tauri';
import { useT } from '../../i18n/useT';
import type { I18nKey } from '../../i18n/en';
import { ToolControlDemo } from './ToolControlDemo';
import './ToolControlPanel.css';

const errors: Record<string, I18nKey> = {
  control_read: 'control.read_error', control_write: 'control.write_error', control_conflict: 'control.conflict',
  control_network: 'control.network_error', control_integrity: 'control.integrity_error', control_unavailable: 'control.unavailable',
  control_unsupported: 'control.unsupported',
  control_tool_missing: 'control.not_installed',
};

export function ToolControlPanel({ kind, active, tools }: {
  kind: 'computer' | 'browser'; active: boolean; tools: { value: string; label: string; icon: ReactNode; installed?: boolean }[];
}) {
  const t = useT();
  const [status, setStatus] = useState<ToolControlStatus>();
  const [pending, setPending] = useState<string | null>(null);
  const busy = pending !== null;
  const [error, setError] = useState<I18nKey>();
  const [checked, setChecked] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const version = revision.current;
    void commands.getToolControl(kind).then(value => { if (!cancelled && version === revision.current) setStatus(value); })
      .catch(reason => { if (!cancelled && version === revision.current) setError(errors[String(reason)] ?? 'control.read_error'); });
    return () => { cancelled = true; };
  }, [active, kind]);
  const run = async (action: () => Promise<ToolControlStatus>, target = 'runtime', check = false) => {
    if (busy) return;
    revision.current++;
    setPending(target); setError(undefined);
    try { const value = await action(); revision.current++; setStatus(value); if (check) setChecked(true); }
    catch (reason) { revision.current++; setError(errors[String(reason)] ?? 'control.write_error'); }
    finally { setPending(null); }
  };
  const agents = tools.slice(0, 6);
  return <div className="tool-control" aria-busy={busy || (!status && !error)}>
    <div className="tool-control-runtime">
      <span className="tool-control-symbol" aria-hidden="true">{kind === 'computer'
        ? <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="5" width="24" height="17" rx="3" /><path d="M16 22v5m-6 0h12M9 10h7m-7 4h4" /></svg>
        : <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="16" cy="16" r="12" /><ellipse cx="16" cy="16" rx="5" ry="12" /><path d="M4 16h24M6 10h20M6 22h20" /></svg>}</span>
      <div className="tool-control-summary">
        <strong>{kind === 'computer' ? 'Computer Use' : 'Browser Use'}</strong>
        <p>{t(kind === 'computer' ? 'control.computer_description' : 'control.browser_description')}</p>
      </div>
      <span className={`tool-control-state${status?.ready ? ' is-ready' : ''}`} role="status">{!status ? error ? '' : t('diff.loading') : !status.supported ? t('control.unsupported') : checked && status.ready ? t('control.available') : status.installed ? t(kind === 'computer' ? 'control.builtin' : 'control.installed') : t('control.not_installed')}</span>
      {status?.supported && <button type="button" className={`tool-memory-button tool-control-action${kind === 'browser' && !status.installed ? ' tool-memory-save' : ''}`} aria-label={t(kind === 'browser' && !status.installed ? 'skills.install' : 'control.check')} aria-busy={pending === 'runtime'} disabled={busy} onClick={() => { void run(() => kind === 'browser' && !status.installed ? commands.installBrowserControl() : commands.checkToolControl(kind), 'runtime', true); }}>
        <span style={pending === 'runtime' ? { visibility: 'hidden' } : undefined}>{t(kind === 'browser' && !status.installed ? 'skills.install' : 'control.check')}</span>
        {pending === 'runtime' && <span className="tool-control-spinner" aria-hidden="true" />}
      </button>}
      {!status && error && <button type="button" className="tool-memory-button tool-control-action" aria-label={t('tools.memory.reload')} aria-busy={pending === 'runtime'} disabled={busy} onClick={() => { void run(() => commands.getToolControl(kind)); }}><span style={pending === 'runtime' ? { visibility: 'hidden' } : undefined}>{t('tools.memory.reload')}</span>{pending === 'runtime' && <span className="tool-control-spinner" aria-hidden="true" />}</button>}
    </div>
    {error && <p className="tool-memory-notice" role="alert">{t(error)}</p>}
    {status?.supported && status.installed && kind === 'browser' && !status.browser && <p className="tool-memory-notice" role="status">{t('control.browser_missing')}</p>}
    {status?.supported && <div className="tool-control-agents">
      {agents.map(tool => {
        const agent = status.agents.find(agent => agent.tool === tool.value) ?? { supported: false, enabled: false, conflict: false };
        const missing = tool.installed === false;
        const unavailable = !missing && (agent.supported === false || agent.conflict);
        const disabled = missing || unavailable || (!agent.enabled && !status.ready);
        const help = !unavailable ? undefined : t(agent.supported === false ? 'control.agent_unsupported_help' : agent.issue === 'conflict' ? 'control.agent_conflict_help' : 'control.agent_config_help', { tool: tool.label, server: `coffee-${kind}-use` });
        return <div className="tool-control-agent" key={tool.value}>
          <span className="tool-control-agent-icon" aria-hidden="true">{tool.icon}</span>
          <span className="tool-control-agent-name"><span className="tool-control-agent-label">{tool.label}</span>
            {(missing || unavailable) && <span className="tool-control-unavailable" data-tip={help} tabIndex={help ? 0 : undefined} aria-label={help}>{t(missing ? 'control.not_installed' : 'control.agent_unavailable')}</span>}
          </span>
          {pending === tool.value && <span className="tool-control-spinner" aria-hidden="true" />}
          <button type="button" role="switch" aria-label={tool.label} aria-checked={agent.enabled} aria-busy={pending === tool.value} data-unavailable={disabled} className="tool-control-switch tool-control-card-toggle" disabled={busy || disabled} onClick={() => { void run(() => commands.setToolControl(kind, tool.value, !agent.enabled), tool.value); }}><span /></button>
        </div>;
      })}
      {!agents.length && <span className="tool-control-no-agents">{t('control.no_agents')}</span>}
    </div>}
    {active && <ToolControlDemo kind={kind} />}
  </div>;
}
