// Settings → Mobile: allow phones on this network, pair one with a QR code, and remove paired phones.
import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { commands, isTauri, type MobileRpcPairing, type MobileRpcStatus } from '../../tauri';
import { useT } from '../../i18n/useT';

interface Pairing extends MobileRpcPairing { qr: string }

export function MobileSettings() {
  const t = useT();
  const [status, setStatus] = useState<MobileRpcStatus | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
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

  const beginPairing = () => run(async () => {
    const next = await commands.mobileRpcBeginPairing();
    const qr = await QRCode.toDataURL(next.uri, { width: 220, margin: 2, errorCorrectionLevel: 'M' });
    pairedBefore.current = new Set(status?.devices.map(device => device.publicKey));
    setNow(Date.now());
    setPairing({ ...next, qr });
  });

  const cancelPairing = () => run(async () => { await commands.mobileRpcCancelPairing(); setPairing(null); });
  const revoke = (publicKey: string) => run(async () => { setStatus(await commands.mobileRpcRevokeDevice(publicKey)); });

  const enabled = !!status?.enabled;
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
        <div className="settings-sound-item settings-voice-controls" aria-disabled={!enabled}>
          <div className="settings-sound-row">
            <div className="settings-sound-title">{t('settings.mobile.pair')}<div className="settings-choice-hint">{enabled && status?.host ? t('settings.mobile.address', { address: `${status.host}:${status.port}` }) : t('settings.mobile.pair.sub')}</div></div>
            {pairing
              ? <button type="button" className="settings-voice-scan" disabled={busy} onClick={() => void cancelPairing()}>{t('settings.mobile.pair.cancel')}</button>
              : <button type="button" className="settings-voice-scan" disabled={!enabled || busy || !status?.host} onClick={() => void beginPairing()}>{t('settings.mobile.pair.start')}</button>}
          </div>
          {enabled && !status?.host && <div className="settings-sound-failed" role="alert">{t('settings.mobile.no_network')}</div>}
          {pairing && <div className="settings-mobile-pairing">
            <img className="settings-mobile-qr" src={pairing.qr} alt={t('settings.mobile.qr_alt')} width={220} height={220} />
            <div className="settings-mobile-pairing-text">
              <p>{t('settings.mobile.scan')}</p>
              <p className="settings-choice-hint">{t('settings.mobile.expires', { seconds: String(seconds) })}</p>
              <p className="settings-choice-hint">{t('settings.mobile.confirm_hint')}</p>
            </div>
          </div>}
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
