// Sidebar status for Web access: on or off, and how many browsers are connected. Opens its settings.
import { useEffect, useState } from 'react';
import { useAppDispatch } from '../../store/app-state';
import { commands, isTauri, type MobileRpcStatus } from '../../tauri';
import { useT } from '../../i18n/useT';
import { REMOTE } from '../../remote/bridge';

export function WebAccessStatus() {
  const t = useT();
  const dispatch = useAppDispatch();
  const [status, setStatus] = useState<MobileRpcStatus | null>(null);
  useEffect(() => {
    if (!isTauri || REMOTE) return;
    let stop: (() => void) | undefined, disposed = false;
    void commands.mobileRpcStatus().then(next => { if (!disposed) setStatus(next); }).catch(() => {});
    void import('@tauri-apps/api/event').then(({ listen }) => listen<MobileRpcStatus>('mobile-rpc-devices', ({ payload }) => setStatus(payload)))
      .then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    // Connections come and go without a settings change; a slow refresh keeps the count honest.
    const timer = setInterval(() => { void commands.mobileRpcStatus().then(next => { if (!disposed) setStatus(next); }).catch(() => {}); }, 15_000);
    return () => { disposed = true; stop?.(); clearInterval(timer); };
  }, []);
  // A browser already is the Web side; the status belongs to the desktop.
  if (REMOTE || !status) return null;
  const connected = status.connected.length;
  const label = !status.enabled ? t('sidebar.web.off') : connected ? t('sidebar.web.connected', { count: String(connected) }) : t('sidebar.web.on');
  return <button type="button" className="sidebar-footer-status-button" data-on={status.enabled || undefined}
    aria-label={t('sidebar.web.open', { status: label })} onClick={() => dispatch({ type: 'SET_SETTINGS_OPEN', open: true, section: 'mobile' })}>
    <i aria-hidden="true" />{label}
  </button>;
}
