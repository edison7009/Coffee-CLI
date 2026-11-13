// Web 端 shell: pair once, then the full desktop UI, connected to the desktop.
import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import '../styles/global.css';
import './RemoteApp.css';
import { loadToolInfo } from '../lib/tool-info';
import { connectRemote, forgetRemote, onRemoteStatus, pairRemote, remoteComputerName, remoteStatus, takePairingLinkFromAddress } from './bridge';
import { parsePairingLink, RpcError } from './protocol';

const App = lazy(() => import('../App').then(m => ({ default: m.App })));
const useStatus = () => useSyncExternalStore(onRemoteStatus, remoteStatus);
// Read before anything renders, so the link leaves the address bar at once.
const linkFromAddress = takePairingLinkFromAddress();

export function RemoteApp() {
  const status = useStatus();
  const [ready, setReady] = useState(false);
  useEffect(() => { void connectRemote(); }, []);
  // Tool names come from the desktop; load them before the UI's first render.
  useEffect(() => {
    if (status !== 'connected' || ready) return;
    void loadToolInfo().catch(() => {}).finally(() => setReady(true));
  }, [status, ready]);

  if (status === 'unpaired') return <RemotePair initialLink={linkFromAddress ?? ''} />;
  if (!ready) return <div className="remote-pair"><p>{status === 'revoked' ? '这台设备已在电脑上被移除。' : '正在连接电脑…'}</p>{status === 'revoked' && <button type="button" onClick={forgetRemote}>重新配对</button>}</div>;
  return <>
    {status !== 'connected' && <div className="remote-banner">{status === 'revoked' ? <>这台设备已在电脑上被移除。<button type="button" onClick={forgetRemote}>重新配对</button></> : `与 ${remoteComputerName() || '电脑'} 的连接已断开，正在重连…`}</div>}
    <Suspense fallback={null}><App /></Suspense>
  </>;
}

function RemotePair({ initialLink }: { initialLink: string }) {
  const [link, setLink] = useState(initialLink);
  const [name, setName] = useState(() => /iPad/.test(navigator.userAgent) ? 'iPad' : /iPhone/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : /Mac/.test(navigator.platform) ? 'Mac 浏览器' : '浏览器');
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    let parsed;
    try { parsed = parsePairingLink(link); } catch { setError('这不是 Coffee CLI 的配对链接。'); return; }
    setWaiting(true);
    try { await pairRemote(parsed, name.trim() || '浏览器'); }
    catch (e) { setError(e instanceof RpcError && e.code === 'unauthorized' ? '电脑拒绝了连接：配对码可能已过期或被拒绝，请在电脑上重新生成。' : '连不上电脑。请确认在同一个网络，且 Coffee CLI 已打开。'); }
    finally { setWaiting(false); }
  };
  return <div className="remote-pair">
    <h1>连接到 Coffee CLI</h1>
    <p>{initialLink ? '确认这台设备的名称，点“连接”，然后在电脑上点“允许”。' : '在电脑上打开 Coffee CLI → 设置 → Web 端，点“配对”，打开或粘贴配对链接。'}</p>
    <label>这台设备的名称<input value={name} maxLength={64} onChange={e => setName(e.target.value)} /></label>
    {!initialLink && <label>配对链接<input value={link} placeholder="coffee://pair?…" autoCapitalize="none" autoCorrect="off" onChange={e => setLink(e.target.value)} /></label>}
    <button type="button" disabled={waiting || !link.trim()} onClick={() => void submit()}>{waiting ? '请在电脑上点“允许”…' : '连接'}</button>
    {error && <p className="remote-error" role="alert">{error}</p>}
  </div>;
}
