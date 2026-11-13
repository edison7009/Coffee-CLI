// Settings → Mobile: allow phones on this network, pair one with a QR code, and remove paired phones.
import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { commands, isTauri, type MobileRpcAddress, type MobileRpcFirewall, type MobileRpcPairing, type MobileRpcStatus } from '../../tauri';
import { ThemedSelect } from './ThemedSelect';
import { useT } from '../../i18n/useT';
import { clipboardWrite } from '../../lib/clipboard';
import { webPairingUrl } from '../../lib/web-access';

interface Pairing extends MobileRpcPairing { qr: string; webUrl: string }

const AUTO = 'auto';

export function MobileSettings() {
  const t = useT();
  const [status, setStatus] = useState<MobileRpcStatus | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [firewall, setFirewall] = useState<MobileRpcFirewall['state'] | null>(null);
  const pairedBefore = useRef<Set<string>>(new Set());
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  const refresh = useCallback(async () => {
    if (!isTauri) return;
    try { const next = await commands.mobileRpcStatus(); if (live.current) setStatus(next); } catch (e) { if (live.current) setError(String(e)); }
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    void refresh();
    let stop: (() => void) | undefined, disposed = false;
    void import('@tauri-apps/api/event').then(({ listen }) => listen<MobileRpcStatus>('mobile-rpc-devices', ({ payload }) => setStatus(payload)))
      .then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    // Connection dots change without a device event; a slow poll keeps them honest.
    const timer = setInterval(() => void refresh(), 5000);
    return () => { disposed = true; stop?.(); clearInterval(timer); };
  }, [refresh]);

  // A phone that just paired closes the QR code.
  useEffect(() => {
    if (pairing && status?.devices.some(device => !pairedBefore.current.has(device.publicKey))) setPairing(null);
  }, [status, pairing]);

  // Countdown, and the code is dropped once it expires.
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= pairing.expiresAt) setPairing(null);
    }, 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  // Leaving the page withdraws an open pairing code.
  useEffect(() => () => { if (isTauri) void commands.mobileRpcCancelPairing().catch(() => {}); }, []);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); } catch (e) { if (live.current) setError(String(e)); }
    finally { if (live.current) setBusy(false); }
  };

  const toggle = () => run(async () => {
    const next = await commands.mobileRpcSetEnabled(!status?.enabled);
    setStatus(next);
    if (!next.enabled) setPairing(null);
  });

  const showPairing = async () => {
    const next = await commands.mobileRpcBeginPairing();
    // A camera opens this straight in the browser, already carrying the pairing link.
    const webUrl = webPairingUrl(next);
    const qr = await QRCode.toDataURL(webUrl, { width: 264, margin: 2, errorCorrectionLevel: 'M' });
    pairedBefore.current = new Set(status?.devices.map(device => device.publicKey));
    setNow(Date.now());
    setCopied(false);
    setPairing({ ...next, qr, webUrl });
  };
  const beginPairing = () => run(showPairing);

  // Opened from the sidebar's "pair a device": show the code once the server is listening.
  const cancelPairing = () => run(async () => { await commands.mobileRpcCancelPairing(); setPairing(null); });
  const revoke = (publicKey: string) => run(async () => { setStatus(await commands.mobileRpcRevokeDevice(publicKey)); });

  const enabled = !!status?.enabled;

  // Firewall: only meaningful while listening; slow on Windows, so checked on its own.
  useEffect(() => {
    if (!isTauri || !enabled) { setFirewall(null); return; }
    let current = true;
    void commands.mobileRpcFirewallStatus().then(result => { if (current) setFirewall(result.state); }, () => {});
    return () => { current = false; };
  }, [enabled]);
  const allowFirewall = () => run(async () => { setFirewall((await commands.mobileRpcFirewallAllow()).state); });

  const addresses = status?.addresses ?? [];
  // The address already shows above; the network is named by kind, with its address only when two share a kind.
  const networkName = (item: MobileRpcAddress) => item.kind === 'other' ? item.interface : t(`settings.mobile.net.${item.kind}`);
  const addressLabel = (item: MobileRpcAddress) => addresses.filter(other => networkName(other) === networkName(item)).length > 1
    ? t('settings.mobile.net.other', { name: networkName(item), address: item.address })
    : networkName(item);
  const automatic = addresses[0];
  const chooseAddress = (value: string) => run(async () => {
    setStatus(await commands.mobileRpcSetAddress(value === AUTO ? null : value));
    // A code already on screen points at the old address; show a fresh one in its place.
    if (pairing) await showPairing();
  });
  const connected = new Set(status?.connected ?? []);
  const seconds = pairing ? Math.max(0, Math.ceil((pairing.expiresAt - now) / 1000)) : 0;

  return (
    <>
      <div className="settings-sound-list">
        <div className="settings-sound-item">
          <div className="settings-sound-row">
            <div className="settings-sound-title">{t('settings.mobile.enabled')}<div className="settings-choice-hint">{t('settings.mobile.enabled.sub')}</div></div>
            <button type="button" role="switch" className="settings-switch" aria-checked={enabled} aria-label={t('settings.mobile.enabled')} disabled={busy || !status} onClick={() => void toggle()}><span /></button>
          </div>
        </div>
        {enabled && firewall === 'blocked' && <div className="settings-sound-item"><div className="settings-sound-row settings-mobile-firewall" role="alert">
          <div className="settings-sound-title">{t('settings.mobile.firewall.blocked')}<div className="settings-choice-hint">{t('settings.mobile.firewall.blocked.sub')}</div></div>
          <button type="button" className="settings-voice-scan" disabled={busy} onClick={() => void allowFirewall()}>{t('settings.mobile.firewall.allow')}</button>
        </div></div>}
        {enabled && firewall === 'public_network' && <div className="settings-sound-item"><div className="settings-sound-row settings-mobile-firewall" role="alert">
          <div className="settings-sound-title">{t('settings.mobile.firewall.public')}<div className="settings-choice-hint">{t('settings.mobile.firewall.public.sub')}</div></div>
        </div></div>}
        <div className="settings-sound-item settings-voice-controls" aria-disabled={!enabled}>
          {pairing
            // One card: the code, the one address (click to copy the link) and the network it uses.
            ? <div className="settings-mobile-pairing">
              <img className="settings-mobile-qr" src={pairing.qr} alt={t('settings.mobile.qr_alt')} width={132} height={132} />
              <div className="settings-mobile-pairing-text">
                <div className="settings-sound-title">{t('settings.mobile.pair.active')}</div>
                <button type="button" className="settings-mobile-link" onClick={() => void clipboardWrite(pairing.webUrl).then(() => setCopied(true), () => setCopied(false))}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{copied ? <path d="M5 12l5 5L20 7" /> : <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>}</svg>
                  <span>{copied ? t('settings.mobile.copied') : `http://${pairing.host}:${pairing.port}`}</span>
                </button>
                <div className="settings-mobile-meta">
                  <span>{t('settings.mobile.expires', { time: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` })} · {t('settings.mobile.confirm_hint')}</span>
                  {addresses.length > 1 && <ThemedSelect className="settings-mobile-net" align="start" menuWidth={240} label={t('settings.mobile.net')} disabled={busy}
                    value={status?.preferredAddress && addresses.some(a => a.address === status.preferredAddress) ? status.preferredAddress : AUTO}
                    options={[{ value: AUTO, label: t('settings.mobile.net.auto', { name: automatic ? addressLabel(automatic) : '' }) }, ...addresses.map(a => ({ value: a.address, label: addressLabel(a) }))]}
                    onChange={value => void chooseAddress(value)} />}
                </div>
              </div>
              <button type="button" className="settings-voice-scan" disabled={busy} onClick={() => void cancelPairing()}>{t('settings.mobile.pair.cancel')}</button>
            </div>
            : <div className="settings-sound-row">
              <div className="settings-sound-title">{t('settings.mobile.pair')}<div className="settings-choice-hint">{t(enabled ? 'settings.mobile.pair.hint' : 'settings.mobile.pair.sub')}</div></div>
              <button type="button" className="settings-voice-scan" disabled={!enabled || busy || !status?.host} onClick={() => void beginPairing()}>{t('settings.mobile.pair.start')}</button>
            </div>}
          {enabled && !status?.host && <div className="settings-sound-failed" role="alert">{t('settings.mobile.no_network')}</div>}
        </div>
      </div>

      <section className="settings-voice-channels">
        <div className="settings-sound-row">
          <div className="settings-sound-title">{t('settings.mobile.devices')}</div>
        </div>
        {status?.devices.length
          ? <div className="settings-sound-list settings-mobile-devices">
            {status.devices.map(device => <div className="settings-sound-item" key={device.publicKey}>
              <div className="settings-sound-row">
                <span className={`settings-mobile-dot${connected.has(device.publicKey) ? ' is-connected' : ''}`} aria-hidden="true" />
                <div className="settings-sound-title">{device.name}<div className="settings-choice-hint">
                  {connected.has(device.publicKey) ? t('settings.mobile.connected') : t('settings.mobile.paired_at', { date: new Date(device.pairedAt).toLocaleDateString() })}
                </div></div>
                <button type="button" className="settings-voice-scan" disabled={busy} onClick={() => void revoke(device.publicKey)}>{t('settings.mobile.remove')}</button>
              </div>
            </div>)}
          </div>
          : <div className="settings-choice-hint settings-mobile-empty">{t('settings.mobile.devices.empty')}</div>}
        {error && <div className="settings-sound-failed" role="alert">{error}</div>}
      </section>
    </>
  );
}
