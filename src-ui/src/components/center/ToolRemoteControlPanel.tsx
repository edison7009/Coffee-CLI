import { useEffect, useState, type ReactNode } from 'react';
import { commands } from '../../tauri';
import { useT } from '../../i18n/useT';
import './ToolControlPanel.css';

/** The assistants that can be given the window tools (src/window_control.rs `TOOLS`). */
const SUPPORTED = new Set(['claude', 'codex', 'opencode', 'dsh']);

/**
 * Remote Control: which assistants' new sessions may see and operate the open remote computer
 * windows (src/window_control.rs), one switch each.
 */
export function ToolRemoteControlPanel({ active, tools }: { active: boolean; tools: { value: string; label: string; icon: ReactNode; installed?: boolean }[] }) {
  const t = useT();
  const [enabled, setEnabled] = useState<string[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void commands.windowControlTools().then(value => { if (current) { setEnabled(value); setFailed(false); } }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [active]);
  const toggle = async (tool: string) => {
    if (pending || !enabled) return;
    setPending(tool); setFailed(false);
    try { setEnabled(await commands.windowControlSetTool(tool, !enabled.includes(tool))); }
    catch { setFailed(true); }
    finally { setPending(null); }
  };
  return <div className="tool-control" aria-busy={pending !== null || (!enabled && !failed)}>
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
        const supported = SUPPORTED.has(tool.value), missing = tool.installed === false;
        const on = !!enabled?.includes(tool.value);
        // Turning it off stays possible even when the tool is no longer installed.
        const disabled = !supported || !enabled || (missing && !on);
        return <div className="tool-control-agent" key={tool.value}>
          <span className="tool-control-agent-icon" aria-hidden="true">{tool.icon}</span>
          <span className="tool-control-agent-name"><span className="tool-control-agent-label">{tool.label}</span>
            {(missing || !supported) && <span className="tool-control-unavailable">{t(missing ? 'control.not_installed' : 'orchestration.unsupported')}</span>}
          </span>
          {pending === tool.value && <span className="tool-control-spinner" aria-hidden="true" />}
          <button type="button" role="switch" aria-label={tool.label} aria-checked={on} aria-busy={pending === tool.value} data-unavailable={disabled} className="tool-control-switch tool-control-card-toggle" disabled={pending !== null || disabled} onClick={() => { void toggle(tool.value); }}><span /></button>
        </div>;
      })}
      {!tools.length && <span className="tool-control-no-agents">{t('control.no_agents')}</span>}
    </div>
  </div>;
}
