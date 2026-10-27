import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isTauri } from '../../tauri';
import { useT } from '../../i18n/useT';
import { onWindowForeground } from '../../lib/window-focus-filter';
import { checkCliUpdate, updateCli, useCliUpdate } from '../../lib/cli-updates';
import './CliUpdateButton.css';

export function CliUpdateButton({ tool, active, installed }: { tool: string; active: boolean; installed: boolean }) {
  const t = useT(), entry = useCliUpdate(tool);
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = tipRef.current;
    if (!tip || !node) return;
    const width = node.getBoundingClientRect().width;
    node.style.left = `${Math.max(8, Math.min(tip.left - width / 2, window.innerWidth - width - 8))}px`;
  }, [tip, entry, t]);
  useEffect(() => {
    if (!isTauri || !active || !installed) return;
    const refresh = () => { if (!document.hidden) void checkCliUpdate(tool); };
    const timer = setTimeout(refresh, 600), interval = setInterval(refresh, 60000);
    const unsubscribe = onWindowForeground(refresh);
    return () => { clearTimeout(timer); clearInterval(interval); unsubscribe(); };
  }, [tool, active, installed]);
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener('scroll', hide, true); window.addEventListener('resize', hide);
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); };
  }, [tip]);
  if (!active || !installed || (!entry.busy && !entry.status?.available)) return null;
  const updateLabel = t('cli_update.action', { version: entry.status?.latest ?? '' });
  const label = entry.busy ? t('cli_update.updating') : updateLabel;
  const error = entry.error === 'cli_update_timeout' ? t('cli_update.timeout') : entry.error === 'cli_update_verify' ? t('cli_update.verify') : t('cli_update.failed');
  return <span className="cli-update-control" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <button type="button" className={`cli-update-button${entry.error ? ' has-error' : ''}`} aria-label={label} aria-busy={entry.busy} disabled={entry.busy} onClick={event => { event.stopPropagation(); setTip(null); void updateCli(tool); }} onMouseEnter={event => { const rect = event.currentTarget.getBoundingClientRect(); setTip({ left: rect.left + rect.width / 2, top: rect.bottom + 8 }); }} onMouseLeave={() => setTip(null)} onFocus={event => { const rect = event.currentTarget.getBoundingClientRect(); setTip({ left: rect.left + rect.width / 2, top: rect.bottom + 8 }); }} onBlur={() => setTip(null)}>
      <span className="cli-update-label" style={entry.busy ? { visibility: 'hidden' } : undefined}>{updateLabel}</span>
      {entry.busy && <span className="cli-update-dots" aria-hidden="true"><i /><i /><i /><i /></span>}
    </button>
    {entry.error && <span className="cli-update-error" role="alert">{error}</span>}
    {tip && createPortal(<span ref={tipRef} className="cli-update-tip" role="tooltip" style={{ left: tip.left, top: tip.top }}>{entry.error ? error : entry.busy ? label : t('cli_update.hint', { current: entry.status?.current ?? '', latest: entry.status?.latest ?? '' })}</span>, document.body)}
  </span>;
}
