import { useT } from '../../i18n/useT';
import './ContextUsage.css';

export function ContextUsage({ used, capacity, total }: { used: number; capacity: number; total?: number }) {
  const t = useT();
  const percent = capacity > 0 ? Math.max(0, Math.min(100, used / capacity * 100)) : 0;
  return <div className="context-usage">
    <div className="claude-context-readout"><span>{t('claude.context_used')}</span><strong>{Math.round(percent)}%</strong></div>
    <div className="context-usage-meter" role="progressbar" aria-label={t('claude.context_used')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><span style={{ width: `${percent}%` }} /></div>
    <div className="context-usage-count">{used.toLocaleString()} / {capacity > 0 ? capacity.toLocaleString() : '—'}</div>
    <div className="claude-context-readout context-usage-total"><span>{t('codex.total_tokens')}</span><span>{total === undefined ? '—' : total.toLocaleString()}</span></div>
  </div>;
}
