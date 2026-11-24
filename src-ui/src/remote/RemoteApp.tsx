// Web 端 shell: pair once, then the full desktop UI, connected to the desktop.
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import '../styles/global.css';
import './RemoteApp.css';
import { loadToolInfo } from '../lib/tool-info';
import { followDesktopStorage } from '../lib/storage-mirror';
import { CAN_SCAN, connectRemote, CONTROL, pairingLinkIn, scanQrCode, controlPairLink, forgetRemote, loadRemotePairing, installWebFileDrop, localVersion, onRemoteStatus, pairRemote, remoteComputerName, remoteHello, remoteStatus, setControlName, takePairingLinkFromAddress } from './bridge';
import { showToast } from '../lib/toast';
import { olderThan } from '../lib/remote-control';
import { routeFileDrop } from '../lib/file-drop';
import { parsePairingLink, RpcError } from './protocol';

const App = lazy(() => import('../App').then(m => ({ default: m.App })));
const useStatus = () => useSyncExternalStore(onRemoteStatus, remoteStatus);
// Read before anything renders, so the link leaves the address bar at once.
const linkFromAddress = takePairingLinkFromAddress() ?? controlPairLink();
// Files dropped from this device are uploaded, then reach the same drop targets (composer, terminal) as desktop drops.
installWebFileDrop(routeFileDrop);

export function RemoteApp() {
  const status = useStatus();
  const [ready, setReady] = useState(false);
  useEffect(() => { void connectRemote(); }, []);
  // Tool names and the desktop's saved records (recent folders, launch modes…) arrive before the UI's
  // first render, so it opens showing what the desktop shows. A slow desktop does not hold it back long.
  useEffect(() => {
    if (status !== 'connected' || ready) return;
    const storage = Promise.race([followDesktopStorage(), new Promise(resolve => setTimeout(resolve, 4000))]);
    void Promise.all([loadToolInfo().catch(() => {}), storage]).finally(() => setReady(true));
  }, [status, ready]);

  // A Coffee CLI window controlling this computer: named after it, and told when it runs an older version
  // (this window's UI is newer, so some of its features may not be there).
  // The name comes from the computer each time it connects, so a renamed computer shows its new name;
  // the version notice is shown once per window, not on every reconnect.
  const warned = useRef(false);
  useEffect(() => {
    if (!CONTROL || status !== 'connected') return;
    const name = remoteHello()?.computerName || remoteComputerName();
    setControlName(name);
    if (warned.current) return;
    warned.current = true;
    const theirs = remoteHello()?.desktopVersion ?? '';
    void localVersion().then(ours => {
      if (theirs && olderThan(theirs, ours)) showToast(`${name || '对方电脑'} 是 v${theirs}，比本机旧，部分新功能可能用不了，建议升级。`, 8000);
    }).catch(() => {});
  }, [status]);

  // Pairing keeps its form up while it waits, so a refusal or an unreachable computer is explained there.
  if (status === 'unpaired' || (status === 'connecting' && !loadRemotePairing())) return <RemotePair initialLink={linkFromAddress ?? ''} />;
  if (status === 'unsupported') return <div className="remote-pair remote-pair-status"><p>{remoteHello()?.computerName || '对方电脑'} 上的 Coffee CLI 版本太旧（{remoteHello()?.desktopVersion ? `v${remoteHello()?.desktopVersion}` : '未知版本'}），不支持被操控。请把它升级到 v4.0.2 或更新的版本。</p></div>;
  if (!ready) return <div className="remote-pair remote-pair-status"><p>{status === 'revoked' ? '这台设备已在电脑上被移除。' : '正在连接电脑…'}</p>{status === 'revoked' && <button type="button" onClick={forgetRemote}>重新配对</button>}</div>;
  return <>
    {/* Covers the whole page, so it never sits on the title bar; the desktop UI comes back once connected. */}
    {status !== 'connected' && <div className="remote-banner" role="alertdialog" aria-live="polite">
      <div className="remote-banner-card">
        {status === 'revoked'
          ? <><p>这台设备已在电脑上被移除。</p><button type="button" onClick={forgetRemote}>重新配对</button></>
          : <><span className="remote-banner-spinner" aria-hidden="true" /><p>与 {remoteComputerName() || '电脑'} 的连接已断开</p><p className="remote-banner-sub">正在重连…</p></>}
      </div>
    </div>}
    <Suspense fallback={null}><App /></Suspense>
  </>;
}

function RemotePair({ initialLink }: { initialLink: string }) {
  const [link, setLink] = useState(initialLink);
  // The phone app is a control window too, so the device comes first: a phone is named as a phone.
  const [name, setName] = useState(() => /iPad/.test(navigator.userAgent) ? 'iPad' : /iPhone/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : CONTROL ? 'Coffee CLI 客户端' : /Mac/.test(navigator.platform) ? 'Mac 浏览器' : '浏览器');
  const [waiting, setWaiting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const submit = async (text = link) => {
    setError('');
    let parsed;
    try { parsed = parsePairingLink(pairingLinkIn(text)); } catch { setError('这不是 Coffee CLI 的配对链接。'); return; }
    setWaiting(true);
    try { await pairRemote(parsed, name.trim() || '浏览器'); }
    catch (e) { setError(e instanceof RpcError && e.code === 'unauthorized' ? '电脑拒绝了连接：配对码可能已过期或被拒绝，请在电脑上重新生成。' : '连不上电脑。请确认在同一个网络，且 Coffee CLI 已打开。'); }
    finally { setWaiting(false); }
  };
  const scan = async () => {
    setError('');
    let text: string | null;
    setScanning(true);
    try { text = await scanQrCode(); }
    catch (e) { setError(String(e).includes('camera_denied') ? '没有相机权限。请在系统设置里允许 Coffee CLI 使用相机，或者粘贴配对链接。' : '打不开相机，请粘贴配对链接。'); return; }
    finally { setScanning(false); }
    if (!text) return;
    setLink(pairingLinkIn(text));
    await submit(text);
  };
  return <div className="remote-pair">
    <h1>连接到 Coffee CLI</h1>
    <p>{initialLink ? '确认这台设备的名称，点“连接”，然后在电脑上点“允许”。' : CAN_SCAN ? '在电脑上打开 Coffee CLI → 设置 → 设备连接，点“配对”，然后扫描屏幕上的二维码，或者粘贴配对链接。' : '在电脑上打开 Coffee CLI → 设置 → 设备连接，点“配对”，打开或粘贴配对链接。'}</p>
    <label>这台设备的名称<input value={name} maxLength={64} onChange={e => setName(e.target.value)} /></label>
    {!initialLink && <label>配对链接<input value={link} placeholder="coffeecli://pair?…" autoCapitalize="none" autoCorrect="off" onChange={e => setLink(e.target.value)} /></label>}
    {/* In the phone app: scan the code on the computer's screen, and connecting starts at once. */}
    {CAN_SCAN && !initialLink && <button type="button" disabled={waiting || scanning} onClick={() => void scan()}>扫码连接</button>}
    <button type="button" className={CAN_SCAN && !initialLink ? 'remote-pair-secondary' : undefined} disabled={waiting || !link.trim()} onClick={() => void submit()}>{waiting ? '请在电脑上点“允许”…' : '连接'}</button>
    {error && <p className="remote-error" role="alert">{error}</p>}
  </div>;
}
