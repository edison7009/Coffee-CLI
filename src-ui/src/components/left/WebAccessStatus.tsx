// Sidebar status for other devices using this computer: nothing to show until one connects,
// then a list of who is connected (browser or phone, by name) and the everyday actions.
// No addresses or network terms here; Settings keeps those for whoever needs them.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppDispatch } from '../../store/app-state';
import { commands, isTauri, type MobileRpcDevice, type MobileRpcStatus } from '../../tauri';
import { useT } from '../../i18n/useT';
import { REMOTE } from '../../remote/bridge';
import { PairDeviceDialog } from './PairDeviceDialog';

export function WebAccessStatus() {
  const t = useT();
  const dispatch = useAppDispatch();
  const [status, setStatus] = useState<MobileRpcStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isTauri || REMOTE) return;
    let stop: (() => void) | undefined, disposed = false;
    const refresh = () => { void commands.mobileRpcStatus().then(next => { if (!disposed) setStatus(next); }).catch(() => {}); };
    refresh();
    void import('@tauri-apps/api/event').then(({ listen }) => listen<MobileRpcStatus>('mobile-rpc-devices', ({ payload }) => setStatus(payload)))
      .then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    // Connections come and go without a settings change; a slow refresh keeps the list honest.
    const timer = setInterval(refresh, 15_000);
    return () => { disposed = true; stop?.(); clearInterval(timer); };
  }, []);

  const devices: MobileRpcDevice[] = status?.enabled ? status.devices.filter(device => status.connected.includes(device.publicKey)) : [];
  const connected = devices.length > 0;
  // The last device leaving closes the list.
  if (open && !connected) setOpen(false);

  // Click elsewhere or Escape closes the list.
  useEffect(() => {
    if (!open) return;
    const down = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); };
  }, [open]);

  // A browser already is the other device; the status belongs to the desktop.
  if (REMOTE || !status) return null;

  const settings = () => {
    setOpen(false);
    dispatch({ type: 'SET_SETTINGS_OPEN', open: true, section: 'mobile' });
  };
  const disconnectAll = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { setStatus(await commands.mobileRpcSetEnabled(false)); setOpen(false); } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const kind = (device: MobileRpcDevice) => t(device.platform === 'web' ? 'sidebar.devices.web' : 'sidebar.devices.mobile');
  const label = connected ? t('sidebar.devices.count', { count: String(devices.length) }) : t('sidebar.devices.none');

  const rect = open ? button.current?.getBoundingClientRect() : undefined;
  return <>
    <button ref={button} type="button" className="sidebar-footer-status-button" data-on={connected || undefined}
      aria-haspopup={connected ? 'menu' : undefined} aria-expanded={connected ? open : undefined}
      onClick={() => { setError(''); if (connected) setOpen(value => !value); else settings(); }}>
      <i aria-hidden="true" />
      <span className="sidebar-web-label">{label}</span>
      {connected && <svg className="sidebar-web-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6" /></svg>}
    </button>
    {open && rect && createPortal(<div ref={menu} className="ctx-menu sidebar-web-menu" role="menu" aria-label={label}
      style={{ position: 'fixed', left: rect.left, bottom: window.innerHeight - rect.top + 6, width: Math.max(rect.width, 240) }}>
      {/* The mobile app is not out yet; the entry shows where it will live. */}
      <button type="button" role="menuitem" className="ctx-menu-item" aria-disabled="true" disabled>{t('sidebar.devices.mobile_app')}</button>
      <div className="ctx-menu-divider" />
      {devices.map(device => <div key={device.publicKey} className="sidebar-web-device" role="menuitem" aria-disabled="true">
        <i aria-hidden="true" /><span className="sidebar-web-device-kind">{kind(device)}</span><span className="sidebar-web-device-name">{device.name}</span>
      </div>)}
      <div className="ctx-menu-divider" />
      <button type="button" role="menuitem" className="ctx-menu-item" onClick={() => { setOpen(false); setPairing(true); }}>{t('sidebar.devices.add')}</button>
      <div className="ctx-menu-divider" />
      <button type="button" role="menuitem" className="ctx-menu-item" onClick={() => settings()}>{t('sidebar.devices.settings')}</button>
      <button type="button" role="menuitem" className="ctx-menu-item" disabled={busy} onClick={() => void disconnectAll()}>{t('sidebar.devices.disconnect')}</button>
      {error && <div className="sidebar-web-error" role="alert">{error}</div>}
    </div>, document.body)}
    {pairing && <PairDeviceDialog onClose={() => setPairing(false)} />}
  </>;
}
