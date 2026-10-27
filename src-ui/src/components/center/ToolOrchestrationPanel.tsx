import { useEffect, useRef, useState, type ReactNode } from 'react';
import { commands } from '../../tauri';
import { useT } from '../../i18n/useT';
import { receiveOrchestration, refreshOrchestration, useOrchestration } from '../../lib/orchestration';
import { ToolControlDemo } from './ToolControlDemo';
import './ToolControlPanel.css';

export function ToolOrchestrationPanel({ active, tools }: {
  active: boolean; tools: { value: string; label: string; icon: ReactNode; installed?: boolean }[];
}) {
  const t = useT(), { agents = [] } = useOrchestration();
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
    {error && <p className="tool-memory-notice" role="alert">{t(ready ? 'control.write_error' : 'control.read_error')}</p>}
    <div className="tool-control-agents">
      {tools.slice(0, 6).map(tool => {
        const supported = ['claude', 'codex', 'opencode'].includes(tool.value), missing = tool.installed === false;
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
    {active && <ToolControlDemo kind="orchestration" />}
  </div>;
}
