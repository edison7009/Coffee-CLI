// Sidebar device status: computers this one controls (each in a window of its own, see
// src/remote_window.rs), recent ones to reopen, and devices connected to this computer.
// The menu always opens; sections without anything in them are left out.
// No addresses or network terms here; Settings keeps those for whoever needs them.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppDispatch } from '../../store/app-state';
import { commands, isTauri, type MobileRpcDevice, type MobileRpcStatus } from '../../tauri';
import { useT } from '../../i18n/useT';
import { REMOTE } from '../../remote/bridge';
import { controlAddress, forgetRemote, loadRecentRemotes, onControlRequest, originOf, recentAddress, rememberRemote, remoteHost, type RecentRemote, type RemoteWindow } from '../../lib/remote-control';

const CLOSE_ICON = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>;

export function WebAccessStatus() {
  const t = useT();
  const dispatch = useAppDispatch();
  const [status, setStatus] = useState<MobileRpcStatus | null>(null);
  const [remotes, setRemotes] = useState<RemoteWindow[]>([]);
  const [recent, setRecent] = useState<RecentRemote[]>(() => loadRecentRemotes());
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // The composer's remote chip asks for the same dialog (lib/remote-control.ts requestControl).
  useEffect(() => onControlRequest(() => { setError(''); setAsking(true); }), []);

  useEffect(() => {
    if (!isTauri || REMOTE) return;
    let disposed = false;
    const stops: (() => void)[] = [];
    const refresh = () => { void commands.mobileRpcStatus().then(next => { if (!disposed) setStatus(next); }).catch(() => {}); };
    // A remote window that learned its computer's name updates the recent list too.
    const showRemotes = (value: RemoteWindow[] | null) => {
      if (disposed) return;
      // Anything but a list (an older backend, a test double) reads as no windows.
      const list = Array.isArray(value) ? value : [];
      setRemotes(list);
      for (const win of list) if (win.origin && win.name) setRecent(rememberRemote(win.origin, win.name));
    };
    refresh();
    void commands.remoteWindowList().then(showRemotes).catch(() => {});
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const handles = await Promise.all([
        listen<MobileRpcStatus>('mobile-rpc-devices', ({ payload }) => setStatus(payload)),
        listen<RemoteWindow[] | null>('remote-windows-changed', ({ payload }) => showRemotes(payload)),
      ]);
      if (disposed) handles.forEach(stop => stop()); else stops.push(...handles);
    });
    // Connections come and go without a settings change; a slow refresh keeps the list honest.
    const timer = setInterval(refresh, 15_000);
    return () => { disposed = true; stops.forEach(stop => stop()); clearInterval(timer); };
  }, []);

  const devices: MobileRpcDevice[] = status?.enabled ? status.devices.filter(device => status.connected.includes(device.publicKey)) : [];
  const connected = devices.length > 0;
  const openOrigins = new Set(remotes.map(win => win.origin));
  const closedRecent = recent.filter(item => !openOrigins.has(item.origin));

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
    try { setStatus(await commands.mobileRpcSetEnabled(false)); } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  /** Opens (or brings forward) the window for a computer, remembering it for next time. */
  const control = async (address: string) => {
    const opened = await commands.remoteWindowOpen(address, t('remote_control.window_prefix'));
    setRecent(rememberRemote(opened.origin || originOf(address), opened.name));
    setOpen(false);
  };
  const kind = (device: MobileRpcDevice) => t(device.platform === 'web' ? 'sidebar.devices.web' : 'sidebar.devices.mobile');
  const label = remotes.length === 1 ? t('sidebar.devices.controlling', { name: remotes[0].name })
    : remotes.length > 1 ? t('sidebar.devices.controlling_count', { count: String(remotes.length) })
    : connected ? t('sidebar.devices.count', { count: String(devices.length) }) : t('sidebar.devices.none');
  const on = remotes.length > 0 || connected;

  const rect = open ? button.current?.getBoundingClientRect() : undefined;
  return <>
    <button ref={button} type="button" className="sidebar-footer-status-button" data-on={on || undefined}
      aria-haspopup="menu" aria-expanded={open}
      onClick={() => { setError(''); setOpen(value => !value); }}>
      <i aria-hidden="true" />
      <span className="sidebar-web-label">{label}</span>
      <svg className="sidebar-web-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && rect && createPortal(<div ref={menu} className="ctx-menu sidebar-web-menu" role="menu" aria-label={label}
      style={{ position: 'fixed', left: rect.left, bottom: window.innerHeight - rect.top + 6 }}>
      {/* What you are controlling comes first, then the way to control another, then the rest. */}
      {remotes.length > 0 && <>
        <div className="sidebar-web-section">{t('sidebar.devices.section_controlling')}</div>
        {remotes.map(win => <div key={win.label} className="sidebar-web-remote">
          <button type="button" role="menuitem" className="ctx-menu-item sidebar-web-remote-name" data-live
            onClick={() => { setOpen(false); void commands.remoteWindowFocus(win.label).catch(() => {}); }}>
            <i aria-hidden="true" /><span>{win.name}</span>{remoteHost(win.origin) && <small className="sidebar-web-remote-host">{remoteHost(win.origin)}</small>}
          </button>
          <button type="button" className="sidebar-web-remote-x" aria-label={t('sidebar.devices.close_remote', { name: win.name })}
            onClick={() => void commands.remoteWindowClose(win.label).catch(() => {})}>{CLOSE_ICON}</button>
        </div>)}
      </>}
      <button type="button" role="menuitem" className="ctx-menu-item" onClick={() => { setOpen(false); setAsking(true); }}>{t('sidebar.devices.control')}</button>

      {closedRecent.length > 0 && <>
        <div className="ctx-menu-divider" />
        <div className="sidebar-web-section">{t('sidebar.devices.section_recent')}</div>
        {closedRecent.map(item => <div key={item.origin} className="sidebar-web-remote">
          <button type="button" role="menuitem" className="ctx-menu-item sidebar-web-remote-name"
            onClick={() => void control(recentAddress(item.origin)).catch(e => setError(String(e)))}>
            <i aria-hidden="true" /><span>{item.title}</span>
          </button>
          <button type="button" className="sidebar-web-remote-x" aria-label={t('sidebar.devices.forget_remote', { name: item.title })}
            onClick={() => setRecent(forgetRemote(item.origin))}>{CLOSE_ICON}</button>
        </div>)}
      </>}

      {connected && <>
        <div className="ctx-menu-divider" />
        <div className="sidebar-web-section">{t('sidebar.devices.section_connected')}</div>
        {devices.map(device => <div key={device.publicKey} className="sidebar-web-device" role="menuitem" aria-disabled="true">
          <i aria-hidden="true" /><span className="sidebar-web-device-kind">{kind(device)}</span><span className="sidebar-web-device-name">{device.name}</span>
        </div>)}
        <button type="button" role="menuitem" className="ctx-menu-item" disabled={busy} onClick={() => void disconnectAll()}>{t('sidebar.devices.disconnect')}</button>
      </>}

      <div className="ctx-menu-divider" />
      {/* Not out yet: shown greyed so people know a phone app is coming. */}
      <button type="button" role="menuitem" className="ctx-menu-item" aria-disabled="true" disabled>{t('sidebar.devices.mobile_app')}</button>
      <button type="button" role="menuitem" className="ctx-menu-item" onClick={() => settings()}>{t('sidebar.devices.settings')}</button>
      {error && <div className="sidebar-web-error" role="alert">{error}</div>}
    </div>, document.body)}
    {asking && <ControlDialog onClose={() => setAsking(false)} onOpen={control} />}
  </>;
}

/** Paste the other computer's address (or pairing link) to control it from a window of its own. */
function ControlDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (address: string) => Promise<void> }) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState(false);
  useEffect(() => { ref.current?.showModal(); input.current?.focus(); }, []);
  const submit = async () => {
    const address = controlAddress(value);
    if (!address) { setError(t('remote_control.invalid')); return; }
    setWaiting(true); setError('');
    try { await onOpen(address); onClose(); }
    catch (e) { setError(String(e)); }
    finally { setWaiting(false); }
  };
  return <dialog ref={ref} className="tool-config-modal remote-control-dialog" aria-labelledby="remote-control-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="tool-config-header"><span id="remote-control-title">{t('remote_control.title')}</span>
      <button type="button" className="tool-config-close close-button" aria-label={t('remote_control.cancel')} onClick={onClose}>×</button></div>
    <form className="tool-config-body" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p className="remote-control-hint">{t('remote_control.hint')}</p>
      <input ref={input} className="remote-control-input" value={value} placeholder={t('remote_control.placeholder')}
        spellCheck={false} autoCapitalize="none" autoCorrect="off" aria-invalid={!!error || undefined}
        onChange={event => { setValue(event.target.value); setError(''); }} />
      {error && <p className="remote-control-error" role="alert">{error}</p>}
      <div className="tool-config-buttons">
        <button type="button" className="tool-config-btn tool-config-btn-subtle" onClick={onClose}>{t('remote_control.cancel')}</button>
        <button type="submit" className="tool-config-btn tool-config-btn-primary" disabled={waiting || !value.trim()}>{t('remote_control.open')}</button>
      </div>
    </form>
  </dialog>;
}
