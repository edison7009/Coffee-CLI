import { useEffect, useState, type ReactNode } from 'react';
import { commands } from '../../tauri';
import { useT } from '../../i18n/useT';
import './ToolControlPanel.css';

/**
 * Remote Control: whether Claude sessions started here may see and operate the open remote computer
 * windows (src/window_control.rs). Only Claude has the window tools so far.
 */
export function ToolRemoteControlPanel({ active, tools }: { active: boolean; tools: { value: string; label: string; icon: ReactNode; installed?: boolean }[] }) {
  const t = useT();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void commands.windowControlEnabled().then(value => { if (current) { setEnabled(value); setFailed(false); } }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [active]);
  const toggle = async () => {
    if (pending || enabled === null) return;
    setPending(true); setFailed(false);
    try { await commands.windowControlSetEnabled(!enabled); setEnabled(!enabled); }
    catch { setFailed(true); }
    finally { setPending(false); }
  };
  return <div className="tool-control" aria-busy={pending || (enabled === null && !failed)}>
    <div className="tool-control-runtime">
      <span className="tool-control-symbol" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="6" width="17" height="12" rx="2.5" /><rect x="12" y="13" width="17" height="12" rx="2.5" /><path d="M7 22v3h4" /></svg>
      </span>
      <div className="tool-control-summary">
        <strong>{t('tools.tab.remote')}</strong>
        <p>{t('ai_remote.description')}</p>
      </div>
    </div>
    {failed && <p className="tool-memory-notice" role="alert">{t('control.write_error')}</p>}
    <div className="tool-control-agents">
      {tools.slice(0, 6).map(tool => {
        const claude = tool.value === 'claude';
        const missing = tool.installed === false;
        // Turning it off stays possible even when Claude is no longer installed.
        const disabled = !claude || enabled === null || (missing && !enabled);
        return <div className="tool-control-agent" key={tool.value}>
          <span className="tool-control-agent-icon" aria-hidden="true">{tool.icon}</span>
          <span className="tool-control-agent-name"><span className="tool-control-agent-label">{tool.label}</span>
            {(missing || !claude) && <span className="tool-control-unavailable">{t(missing ? 'control.not_installed' : 'orchestration.unsupported')}</span>}
          </span>
          {claude && pending && <span className="tool-control-spinner" aria-hidden="true" />}
          <button type="button" role="switch" aria-label={tool.label} aria-checked={claude && !!enabled} aria-busy={claude && pending} data-unavailable={disabled} className="tool-control-switch tool-control-card-toggle" disabled={pending || disabled} onClick={() => { void toggle(); }}><span /></button>
        </div>;
      })}
      {!tools.length && <span className="tool-control-no-agents">{t('control.no_agents')}</span>}
    </div>
  </div>;
}
