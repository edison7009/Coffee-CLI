// Code's start page: what a tool's card shows and lets you set before it starts (方案一), drawn as EchoBird's model
// cards are — at the foot the headline usage as a large number (what is left of the window that runs out first, or
// the balance) with its label beside it, every other reading on the right, and the headline window's bar along the
// card's bottom edge. The usage is the composer's own reading (lib/usage-quota.ts); the permission is the one the tool
// will start with.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/useT';
import type { I18nKey } from '../../i18n/en';
import { compactCountdown, formatBalance, PERIOD_KEYS, PERIOD_ORDER, remainingPercent, useUsageQuota, type Quota } from '../../lib/usage-quota';
import { LAUNCH_PERMISSIONS, launchPermission, setLaunchPermission, type LaunchTool } from '../../lib/launch-permission';

const tone = (remaining: number) => remaining > 30 ? 'healthy' : remaining > 10 ? 'low' : 'critical';

/** Usage windows nearest first, then balances: every reading, not only the composer's two. */
const ordered = (quotas: Quota[]) => [
  ...quotas.filter(q => q.balance === undefined).sort((a, b) => (a.period ? PERIOD_ORDER.indexOf(a.period) : 9) - (b.period ? PERIOD_ORDER.indexOf(b.period) : 9)),
  ...quotas.filter(q => q.balance !== undefined),
];
const unitOf = (quota: Quota) => (quota.unit ?? (formatBalance(quota).startsWith('$') ? 'USD' : 'CNY')).toUpperCase();

/** The card's headline usage, its other readings and its bottom-edge bar; nothing when there is no reading. */
export function LaunchCardStats({ tool, folder }: { tool: string; folder?: string }) {
  const t = useT();
  const { quotas } = useUsageQuota(`launchpad:${tool}`, tool, folder, null);
  const [now, setNow] = useState(() => Date.now());
  const shown = ordered(quotas);
  // The window that runs out first leads (a used-up longer window blocks the tool whatever the nearer one says);
  // without windows, the balance.
  const windows = shown.filter(quota => quota.balance === undefined);
  const primary = windows.find(quota => remainingPercent(quota) <= 0) ?? windows[0];
  const balance = shown.find(quota => quota.balance !== undefined);
  const ticking = !!primary?.resetAt;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [ticking]);
  const remaining = primary ? Math.round(remainingPercent(primary)) : undefined;
  const headline = primary ?? balance;
  const others = shown.filter(quota => quota !== headline);
  const name = (quota: Quota) => quota.balance !== undefined ? t(quota.spent ? 'usage.spent_label' : 'usage.balance_label') : quota.period ? t(PERIOD_KEYS[quota.period]) : t('launchpad.left');
  if (!headline) return null;
  return <>
    <span className="launchpad-card-usage" onClick={event => event.stopPropagation()}>
      <span className="launchpad-card-hero" data-tone={remaining === undefined ? undefined : tone(remaining)}>{remaining !== undefined ? `${remaining}%` : (headline.balance ?? 0).toFixed(2)}</span>
      <span className="launchpad-card-hero-side">
        {primary ? <>
          <span>{[primary.period ? t(PERIOD_KEYS[primary.period]) : '', t('launchpad.left')].filter(Boolean).join(' ')}</span>
          {primary.resetAt ? <b>{compactCountdown(primary.resetAt, now)}</b> : <b>&nbsp;</b>}
        </> : <>
          <span>{name(headline)}</span>
          <b>{unitOf(headline)}</b>
        </>}
      </span>
      {/* Every other reading, on the right: a window with its short bar, a balance with its amount. */}
      {others.length > 0 && <span className="launchpad-card-others">
        {others.map((quota, index) => quota.balance !== undefined
          ? <span key={index} className="launchpad-card-other-balance">{name(quota)} <b>{quota.balance.toFixed(2)}</b> {unitOf(quota)}</span>
          : <span key={index} className="launchpad-card-other">
            <span className="launchpad-card-other-name">{name(quota)}</span>
            <span className="launchpad-card-mini" aria-hidden="true"><i data-tone={tone(Math.round(remainingPercent(quota)))} style={{ width: `${Math.round(remainingPercent(quota))}%` }} /></span>
            <b data-tone={tone(Math.round(remainingPercent(quota)))}>{Math.round(remainingPercent(quota))}%</b>
          </span>)}
      </span>}
    </span>
    {remaining !== undefined && <span className="launchpad-card-edge" data-tone={tone(remaining)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} aria-label={t('usage.remaining', { percent: remaining })}>
      <i data-tone={tone(remaining)} style={{ width: `${remaining}%` }} />
    </span>}
  </>;
}

/** The permission the tool starts with: its own default until one is picked here. */
export function LaunchPermissionPicker({ tool, disabled }: { tool: LaunchTool; disabled?: boolean }) {
  const t = useT();
  const [value, setValue] = useState(() => launchPermission(tool));
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    setAt({ top: Math.round(r.bottom + 6), right: Math.round(window.innerWidth - r.right) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    // Placed once when opened: scrolling, resizing or leaving the window closes it rather than leave it adrift.
    const dismiss = () => setOpen(false);
    document.addEventListener('mousedown', close); document.addEventListener('keydown', key);
    window.addEventListener('scroll', dismiss, true); window.addEventListener('resize', dismiss); window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss);
    };
  }, [open]);
  const options = LAUNCH_PERMISSIONS[tool];
  const current = options.find(option => option.value === value);
  const pick = (next: string) => { setLaunchPermission(tool, next); setValue(next); setOpen(false); };
  // On a small group like EchoBird's card actions (refresh / edit / delete).
  return <span className="launchpad-card-actions">
    <button ref={button} type="button" className="launchpad-permission" disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      onClick={event => { event.stopPropagation(); setOpen(was => !was); }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /></svg>
      <span>{current ? t(current.labelKey as I18nKey) : t('launchpad.permission_default')}</span>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && at && createPortal(<div ref={menu} className="claude-control-menu launchpad-permission-menu" role="menu" style={{ top: at.top, right: at.right }} onClick={event => event.stopPropagation()}>
      <button type="button" role="menuitemradio" aria-checked={!value} className={!value ? 'is-selected' : ''} onClick={() => pick('')}>{t('launchpad.permission_default')}</button>
      {options.map(option => <button key={option.value} type="button" role="menuitemradio" aria-checked={value === option.value} className={value === option.value ? 'is-selected' : ''} onClick={() => pick(option.value)}>{t(option.labelKey as I18nKey)}</button>)}
    </div>, document.body)}
  </span>;
}
