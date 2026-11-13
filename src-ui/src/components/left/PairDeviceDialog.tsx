// "Connect a device" from the sidebar: the pairing QR code and link in a small window of its own,
// so connecting does not mean finding the right row in Settings.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { commands, type MobileRpcStatus } from '../../tauri';
import { useT } from '../../i18n/useT';
import { clipboardWrite } from '../../lib/clipboard';
import { webPairingUrl } from '../../lib/web-access';

interface Code { qr: string; url: string; expiresAt: number }

export function PairDeviceDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [code, setCode] = useState<Code | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  const known = useRef<Set<string> | null>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });

  // A fresh code each time the window opens (or the last one ran out).
  useEffect(() => {
    let live = true;
    setError(''); setCopied(false);
    void (async () => {
      try {
        const status = await commands.mobileRpcStatus();
        known.current ??= new Set(status.devices.map(device => device.publicKey));
        if (!status.host) throw new Error(t('settings.mobile.no_network'));
        const pairing = await commands.mobileRpcBeginPairing();
        const url = webPairingUrl(pairing);
        const qr = await QRCode.toDataURL(url, { width: 220, margin: 2, errorCorrectionLevel: 'M' });
        if (live) { setCode({ qr, url, expiresAt: pairing.expiresAt }); setNow(Date.now()); }
      } catch (e) { if (live) setError(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { live = false; };
  }, [attempt, t]);

  // Closing withdraws the code; a device that just paired closes the window.
  useEffect(() => {
    let stop: (() => void) | undefined, disposed = false;
    void import('@tauri-apps/api/event').then(({ listen }) => listen<MobileRpcStatus>('mobile-rpc-devices', ({ payload }) => {
      if (known.current && payload.devices.some(device => !known.current?.has(device.publicKey))) close.current();
    })).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current(); };
    window.addEventListener('keydown', key);
    return () => { disposed = true; stop?.(); window.removeEventListener('keydown', key); void commands.mobileRpcCancelPairing().catch(() => {}); };
  }, []);

  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code]);
  const seconds = code ? Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) : 0;
  const expired = !!code && seconds === 0;

  return createPortal(<div className="pair-device-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="pair-device" role="dialog" aria-modal="true" aria-label={t('sidebar.devices.add_title')}>
      <div className="pair-device-head">
        <span>{t('sidebar.devices.add_title')}</span>
        <button type="button" className="pair-device-close" aria-label={t('sidebar.devices.close')} onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <div className="pair-device-body">
        {error ? <p className="pair-device-error" role="alert">{error}</p>
          : !code ? <div className="pair-device-qr pair-device-qr-empty" />
          : <>
            <img className="pair-device-qr" src={code.qr} alt={t('settings.mobile.qr_alt')} width={220} height={220} data-expired={expired || undefined} />
            <p>{t('settings.mobile.scan')}</p>
            <p className="pair-device-hint">{expired ? t('sidebar.devices.expired') : t('settings.mobile.expires', { seconds: String(seconds) })}</p>
            <p className="pair-device-hint">{t('settings.mobile.confirm_hint')}</p>
            {expired
              ? <button type="button" className="pair-device-button" onClick={() => { setCode(null); setAttempt(value => value + 1); }}>{t('settings.mobile.pair.start')}</button>
              : <button type="button" className="pair-device-button" onClick={() => void clipboardWrite(code.url).then(() => setCopied(true), () => setCopied(false))}>{t(copied ? 'settings.mobile.copied' : 'settings.mobile.copy_link')}</button>}
          </>}
      </div>
    </div>
  </div>, document.body);
}
