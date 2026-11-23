import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/useT';
import { compactCountdown, formatBalance, remainingPercent, visibleQuotas, type Quota } from '../../lib/usage-quota';
import './UsageMeter.css';

const PERIOD_KEYS = { fiveHour: 'usage.period.fiveHour', daily: 'usage.period.daily', weekly: 'usage.period.weekly', monthly: 'usage.period.monthly' } as const;

function tone(remaining: number) {
  return remaining > 30 ? 'healthy' : remaining > 10 ? 'low' : 'critical';
}

/** Clicking refreshes in the background; the numbers simply change when the reply arrives. */
/** A small ring filled to how much is left (方案 A's composer line). */
function Ring({ percent }: { percent: number }) {
  const r = 5.5, c = 2 * Math.PI * r;
  return <svg className="usage-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" className="usage-ring-track" />
    <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" className="usage-ring-fill" strokeDasharray={`${c * Math.max(0, Math.min(100, percent)) / 100} ${c}`} transform="rotate(-90 7 7)" strokeLinecap="round" />
  </svg>;
}

/** Clicking refreshes in the background; the numbers simply change when the reply arrives.
 *  `compact`: only the window closest to running out, as a ring and its percent; every reading is in the tip. */
export function UsageMeter({ quotas, onRefresh, compact = false }: { quotas: Quota[]; onRefresh?: () => void; compact?: boolean }) {
  const t = useT();
  const shown = visibleQuotas(quotas);
  const ticking = shown.some(quota => quota.resetAt);
  const [now, setNow] = useState(() => Date.now());
  // Compact: hovering (or focusing) shows every reading above it, the same bars Code shows on its line.
  const [tipAt, setTipAt] = useState<{ x: number; y: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = tipRef.current;
    if (!tipAt || !node) return;
    const w = node.offsetWidth;
    node.style.left = `${Math.round(Math.max(8, Math.min(tipAt.x - w / 2, window.innerWidth - w - 8)))}px`;
    node.style.top = `${Math.round(tipAt.y - node.offsetHeight - 8)}px`;
  });
  // Put away when the window loses focus, scrolls or resizes (as the rail's tips are), and when the readings go.
  useEffect(() => {
    if (!tipAt) return;
    const hide = () => setTipAt(null);
    window.addEventListener('blur', hide); window.addEventListener('scroll', hide, true); window.addEventListener('resize', hide);
    return () => { window.removeEventListener('blur', hide); window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); };
  }, [tipAt]);
  // No readings: the meter is gone, and its tip with it (no stale card when readings come back).
  const hasReadings = visibleQuotas(quotas).length > 0;
  const [hadReadings, setHadReadings] = useState(hasReadings);
  if (hadReadings !== hasReadings) { setHadReadings(hasReadings); if (!hasReadings) setTipAt(null); }
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
      const label = t(quota.spent ? 'usage.spent' : 'usage.balance', { amount });
      labels.push(label);
      return <span key={`balance-${index}`} className="usage-meter-item usage-meter-item--balance" role="img" aria-label={label}>
        <span className="usage-meter-period" aria-hidden="true">{t(quota.spent ? 'usage.spent_label' : 'usage.balance_label')}</span>
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
  if (compact) {
    const windows = shown.filter(quota => quota.balance === undefined);
    const tightest = windows.reduce<Quota | undefined>((low, quota) => !low || remainingPercent(quota) < remainingPercent(low) ? quota : low, undefined);
    const balance = shown.find(quota => quota.balance !== undefined);
    const percent = tightest ? Math.round(remainingPercent(tightest)) : undefined;
    const show = (el: HTMLElement) => { const r = el.getBoundingClientRect(); setTipAt({ x: r.left + r.width / 2, y: r.top }); };
    return <>
      <button type="button" className="usage-meter usage-meter--compact" aria-label={`${t('usage.label')}: ${labels.join('; ')}`} onClick={onRefresh} disabled={!onRefresh}
        onMouseEnter={event => show(event.currentTarget)} onMouseLeave={() => setTipAt(null)} onFocus={event => { if (event.currentTarget.matches(':focus-visible')) show(event.currentTarget); }} onBlur={() => setTipAt(null)}>
        {percent !== undefined ? <><Ring percent={percent} /><span className="usage-meter-percent" data-tone={tone(percent)}>{percent}%</span></>
          : balance ? <strong>{formatBalance(balance)}</strong> : null}
      </button>
      {tipAt && createPortal(<div ref={tipRef} className="usage-meter-tip" role="tooltip" style={{ left: tipAt.x, top: tipAt.y }}>
        <div className="usage-meter-tip-title">{t('usage.label')}</div>
        <div className="usage-meter usage-meter-tip-items">{items}</div>
      </div>, document.body)}
    </>;
  }
  // The button's name carries every reading, since a named button hides its children's names.
  return <button type="button" className="usage-meter" aria-label={`${t('usage.label')}: ${labels.join('; ')}`} onClick={onRefresh} disabled={!onRefresh}>{items}</button>;
}
