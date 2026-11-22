import { useEffect, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { commands } from '../../tauri';
import { useT } from '../../i18n/useT';
import { canRequestControl, remoteHost, requestControl, type RemoteWindow } from '../../lib/remote-control';
import './ToolControlPanel.css';
import './ToolRemoteControlPanel.css';

/** The assistants that can be given the window tools (src/window_control.rs `TOOLS`). */
const SUPPORTED = new Set(['claude', 'codex', 'opencode', 'dsh']);
const MONITOR = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="4" width="13" height="9" rx="2" /><rect x="9" y="11" width="13" height="9" rx="2" /></svg>;

/**
 * Remote Control: the remote computer windows open now, and which assistants' new sessions may see
 * and operate them (src/window_control.rs), one switch each.
 */
export function ToolRemoteControlPanel({ active, tools }: { active: boolean; tools: { value: string; label: string; icon: ReactNode; installed?: boolean }[] }) {
  const t = useT();
  const [enabled, setEnabled] = useState<string[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [windows, setWindows] = useState<RemoteWindow[]>([]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void commands.windowControlTools().then(value => { if (current) { setEnabled(value); setFailed(false); } }, () => { if (current) setFailed(true); });
    // Open windows, kept current as they come and go (src/remote_window.rs).
    const showWindows = (list: RemoteWindow[] | null | undefined) => { if (current && Array.isArray(list)) setWindows(list); };
    void Promise.resolve().then(() => commands.remoteWindowList()).then(showWindows, () => {});
    const stop = Promise.resolve().then(() => listen<RemoteWindow[] | null>('remote-windows-changed', ({ payload }) => {
      if (payload) showWindows(payload); else void commands.remoteWindowList().then(showWindows, () => {});
    })).catch(() => undefined);
    return () => { current = false; void stop.then(unlisten => unlisten?.()); };
  }, [active]);
  const toggle = async (tool: string) => {
    if (pending || !enabled) return;
    setPending(tool); setFailed(false);
    try { setEnabled(await commands.windowControlSetTool(tool, !enabled.includes(tool))); }
    catch { setFailed(true); }
    finally { setPending(null); }
  };
  const shown = tools.slice(0, 6);
  // Tools without the window tools are named once, not given a switch that can never turn on.
  const unsupported = shown.filter(tool => !SUPPORTED.has(tool.value));
  const listed = shown.filter(tool => SUPPORTED.has(tool.value));
  return <div className="tool-control remote-control-page" aria-busy={pending !== null || (!enabled && !failed)}>
    <div className="remote-control-head">
      <strong>{t('tools.tab.remote')}</strong>
      <p>{t('ai_remote.summary')}</p>
    </div>

    <div className="remote-control-section">{t('ai_remote.windows')}</div>
    <div className="remote-control-list">
      {windows.map(win => <div className="remote-control-row tool-control-agent" key={win.label}>
        <span className="remote-control-icon" aria-hidden="true">{MONITOR}<i /></span>
        <span className="remote-control-name">{win.name}</span>
        {remoteHost(win.origin) && <span className="remote-control-host">{remoteHost(win.origin)}</span>}
        <span className="remote-control-fill" />
        <button type="button" className="remote-control-button" onClick={() => void commands.remoteWindowFocus(win.label).catch(() => {})}>{t('ai_remote.focus')}</button>
        <button type="button" className="remote-control-button" aria-label={t('sidebar.devices.close_remote', { name: win.name })} onClick={() => void commands.remoteWindowClose(win.label).catch(() => {})}>{t('ai_remote.close')}</button>
      </div>)}
      {!windows.length && <p className="remote-control-empty">{t('ai_remote.pick.none')}</p>}
      {canRequestControl() && <button type="button" className="remote-control-row tool-control-agent remote-control-add" onClick={() => requestControl()}><span className="remote-control-icon" aria-hidden="true">+</span><span>{t('sidebar.devices.control')}</span></button>}
    </div>

    <div className="remote-control-section">{t('ai_remote.assistants')}</div>
    {failed && <p className="tool-memory-notice" role="alert">{t('control.write_error')}</p>}
    <div className="remote-control-list tool-control-agents">
      {listed.map(tool => {
        const missing = tool.installed === false;
        const on = !!enabled?.includes(tool.value);
        // Turning it off stays possible even when the tool is no longer installed.
        const disabled = !enabled || (missing && !on);
        return <div className="remote-control-row tool-control-agent" key={tool.value}>
          <span className="tool-control-agent-icon" aria-hidden="true">{tool.icon}</span>
          <span className="tool-control-agent-name"><span className="tool-control-agent-label">{tool.label}</span>
            {missing && <span className="tool-control-unavailable">{t('control.not_installed')}</span>}
          </span>
          {pending === tool.value && <span className="tool-control-spinner" aria-hidden="true" />}
          <button type="button" role="switch" aria-label={tool.label} aria-checked={on} aria-busy={pending === tool.value} data-unavailable={disabled} className="tool-control-switch tool-control-card-toggle" disabled={pending !== null || disabled} onClick={() => { void toggle(tool.value); }}><span /></button>
        </div>;
      })}
      {!tools.length && <span className="tool-control-no-agents">{t('control.no_agents')}</span>}
    </div>
    <p className="remote-control-note">{t('ai_remote.risk')}</p>
    {unsupported.length > 0 && <p className="remote-control-note">{t('ai_remote.unsupported', { names: unsupported.map(tool => tool.label).join('、') })}</p>}
  </div>;
}
