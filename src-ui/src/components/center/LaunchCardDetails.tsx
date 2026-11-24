// Code's start page: what a tool's card shows and lets you set before it starts (方案一), drawn as EchoBird's model
// cards are — the model its own settings name, then the headline usage as a large number (what is left of the window
// that runs out first, or the balance) with its label beside it, and that window's bar along the card's bottom edge.
// The usage is the composer's own reading (lib/usage-quota.ts); the permission is the one the tool will start with.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/useT';
import type { I18nKey } from '../../i18n/en';
import { invoke } from '../../tauri';
import { compactCountdown, formatBalance, remainingPercent, useUsageQuota, visibleQuotas } from '../../lib/usage-quota';
import { LAUNCH_PERMISSIONS, launchPermission, setLaunchPermission, type LaunchTool } from '../../lib/launch-permission';

const PERIOD_KEYS = { fiveHour: 'usage.period.fiveHour', daily: 'usage.period.daily', weekly: 'usage.period.weekly', monthly: 'usage.period.monthly' } as const;
const tone = (remaining: number) => remaining > 30 ? 'healthy' : remaining > 10 ? 'low' : 'critical';

const models = new Map<string, Promise<string | null>>();
/** The model a tool's own settings name for this folder, read once per tool and folder. */
function useConfiguredModel(tool: string, folder: string | undefined) {
  const key = `${tool}\n${folder ?? ''}`;
  const [model, setModel] = useState<{ key: string; value: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    let job = models.get(key);
    if (!job) { job = invoke<string | null>('tool_configured_model', { tool, cwd: folder ?? null }).catch(() => null); models.set(key, job); }
    void job.then(value => { if (live) setModel({ key, value }); });
    return () => { live = false; };
  }, [key, tool, folder]);
  return model?.key === key ? model.value : null;
}

/** The card's model line, headline usage and bottom-edge bar; each part only when it is known. */
export function LaunchCardStats({ tool, folder }: { tool: string; folder?: string }) {
  const t = useT();
  const model = useConfiguredModel(tool, folder);
  const { quotas } = useUsageQuota(`launchpad:${tool}`, tool, folder, null);
  const [now, setNow] = useState(() => Date.now());
  const shown = visibleQuotas(quotas);
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
  const amount = !primary && balance ? formatBalance(balance) : undefined;
  return <>
    {model && <span className="launchpad-card-model">{model}</span>}
    {(primary || balance) && <span className="launchpad-card-usage" onClick={event => event.stopPropagation()}>
      <span className="launchpad-card-hero" data-tone={remaining === undefined ? undefined : tone(remaining)}>{remaining !== undefined ? `${remaining}%` : amount?.replace(/^[¥$]/, '')}</span>
      <span className="launchpad-card-hero-side">
        {primary ? <>
          <span>{[primary.period ? t(PERIOD_KEYS[primary.period]) : '', t('launchpad.left')].filter(Boolean).join(' ')}</span>
          {primary.resetAt && <b>{compactCountdown(primary.resetAt, now)}</b>}
        </> : balance && <>
          <span>{t(balance.spent ? 'usage.spent_label' : 'usage.balance_label')}</span>
          <b>{(balance.unit ?? (amount?.startsWith('¥') ? 'CNY' : amount?.startsWith('$') ? 'USD' : '')).toUpperCase()}</b>
        </>}
      </span>
    </span>}
    {remaining !== undefined && <span className="launchpad-card-edge" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} aria-label={t('usage.remaining', { percent: remaining })}>
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
    document.addEventListener('mousedown', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, [open]);
  const options = LAUNCH_PERMISSIONS[tool];
  const current = options.find(option => option.value === value);
  const pick = (next: string) => { setLaunchPermission(tool, next); setValue(next); setOpen(false); };
  return <>
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
  </>;
}
