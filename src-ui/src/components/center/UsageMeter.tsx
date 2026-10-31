import { useEffect, useState } from 'react';
import { useT } from '../../i18n/useT';
import { compactCountdown, formatBalance, remainingPercent, visibleQuotas, type Quota } from '../../lib/usage-quota';
import './UsageMeter.css';

const PERIOD_KEYS = { fiveHour: 'usage.period.fiveHour', daily: 'usage.period.daily', weekly: 'usage.period.weekly', monthly: 'usage.period.monthly' } as const;

function tone(remaining: number) {
  return remaining > 30 ? 'healthy' : remaining > 10 ? 'low' : 'critical';
}

/** Clicking refreshes in the background; the numbers simply change when the reply arrives. */
export function UsageMeter({ quotas, onRefresh }: { quotas: Quota[]; onRefresh?: () => void }) {
  const t = useT();
  const shown = visibleQuotas(quotas);
  const ticking = shown.some(quota => quota.resetAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    // The meter can mount long before a reset time arrives; resync on the next tick.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [ticking]);
  if (!shown.length) return null;
  const labels: string[] = [];
  const items = shown.map((quota, index) => {
    if (quota.balance !== undefined) {
      const amount = formatBalance(quota);
      labels.push(t('usage.balance', { amount }));
      return <span key={`balance-${index}`} className="usage-meter-item usage-meter-item--balance" role="img" aria-label={t('usage.balance', { amount })}>
        <span className="usage-meter-period" aria-hidden="true">{t('usage.balance_label')}</span>
        <strong aria-hidden="true">{amount}</strong>
      </span>;
    }
    const remaining = Math.round(remainingPercent(quota));
    const countdown = compactCountdown(quota.resetAt, now);
    const period = quota.period ? t(PERIOD_KEYS[quota.period]) : '';
    const label = [period, t('usage.remaining', { percent: remaining }), countdown && t('usage.resets_in', { time: countdown })].filter(Boolean).join(' · ');
    labels.push(label);
    return <span key={`${quota.period ?? 'window'}-${index}`} className="usage-meter-item" data-tone={tone(remaining)} role="img" aria-label={label}>
      <span className="usage-meter-text" aria-hidden="true">
        {period && <span className="usage-meter-period">{period}</span>}
        {countdown && <strong className="usage-meter-countdown">{countdown}</strong>}
        <span className="usage-meter-percent">{remaining}%</span>
      </span>
      <span className="usage-meter-bar" aria-hidden="true"><span style={{ width: `${remaining}%` }} /></span>
      </span>;
  });
  // The button's name carries every reading, since a named button hides its children's names.
  return <button type="button" className="usage-meter" aria-label={`${t('usage.label')}: ${labels.join('; ')}`} onClick={onRefresh} disabled={!onRefresh}>{items}</button>;
}
