// Remote mode shell: the desktop's own conversation views, laid out for a
// phone in portrait and as the desktop's side-by-side layout when wide.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import '../styles/global.css';
import './RemoteApp.css';
import { useAppDispatch, useAppState } from '../store/app-state';
import { ClaudeConversation } from '../components/center/ClaudeConversation';
import { loadToolInfo } from '../lib/tool-info';
import { connectRemote, forgetRemote, onRemoteEvent, onRemoteStatus, pairRemote, remoteComputerName, remoteRequest, remoteStatus } from './bridge';
import { parsePairingLink, RpcError } from './protocol';

interface RemoteSession { id: string; tool: string; kind: string | null; view: 'conversation' | 'terminal'; title: string; cwd: string; status: string | null }

const useStatus = () => useSyncExternalStore(onRemoteStatus, remoteStatus);
const WIDE = '(min-width: 900px)';
function useWide() {
  return useSyncExternalStore(listener => { const q = window.matchMedia(WIDE); q.addEventListener('change', listener); return () => q.removeEventListener('change', listener); }, () => window.matchMedia(WIDE).matches);
}
const folder = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
const TOOL_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi', dsh: 'DeepSeek Harness' };

export function RemoteApp() {
  const status = useStatus();
  useEffect(() => { void connectRemote(); }, []);
  if (status === 'unpaired') return <RemotePair />;
  return <RemoteWorkspace status={status} />;
}

function RemotePair() {
  const [link, setLink] = useState('');
  const [name, setName] = useState(() => /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : '浏览器');
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
    <h1>连接到你的电脑</h1>
    <p>在电脑上打开 Coffee CLI → 设置 → 手机，点“配对”，复制配对链接粘贴到这里。</p>
    <label>这台设备的名称<input value={name} maxLength={64} onChange={e => setName(e.target.value)} /></label>
    <label>配对链接<input value={link} placeholder="coffee://pair?…" autoCapitalize="none" autoCorrect="off" onChange={e => setLink(e.target.value)} /></label>
    <button type="button" disabled={waiting || !link.trim()} onClick={() => void submit()}>{waiting ? '请在电脑上点“允许”…' : '连接'}</button>
    {error && <p className="remote-error" role="alert">{error}</p>}
  </div>;
}

function RemoteWorkspace({ status }: { status: string }) {
  const wide = useWide();
  const { state } = useAppState();
  const dispatch = useAppDispatch();
  const [sessions, setSessions] = useState<RemoteSession[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setSessions((await remoteRequest<{ sessions: RemoteSession[] }>('session.list')).sessions); } catch { /* shown by the status bar */ }
  }, []);
  useEffect(() => {
    if (status !== 'connected') return;
    void loadToolInfo().catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => void load());
    const stop = onRemoteEvent(event => { if (event.event === 'session.changed') { clearTimeout(timer); timer = setTimeout(() => void load(), 300); } });
    return () => { stop(); clearTimeout(timer); };
  }, [status, load]);

  const open = (session: RemoteSession) => {
    // The conversation views report status and titles to their tab; give them one.
    if (!state.terminals.some(tab => tab.id === session.id)) dispatch({ type: 'ADD_TERMINAL', session: { id: session.id, tool: session.tool as never, claudeMode: 'conversation', folderPath: session.cwd || null } });
    setSelected(session.id);
  };
  const current = useMemo(() => sessions?.find(s => s.id === selected) ?? null, [sessions, selected]);
  const showList = wide || !current;

  return <div className={`remote-workspace${wide ? ' is-wide' : ''}`}>
    {status !== 'connected' && <div className="remote-banner">{status === 'revoked' ? <>这台设备已在电脑上被移除。<button type="button" onClick={forgetRemote}>重新配对</button></> : '正在连接电脑…'}</div>}
    {showList && <aside className="remote-sessions">
      <header><h1>会话</h1><span>{remoteComputerName()}</span></header>
      <ul>
        {(sessions ?? []).map(session => <li key={session.id}>
          <button type="button" className={session.id === selected ? 'active' : ''} onClick={() => open(session)}>
            <span className="remote-session-tool">{TOOL_NAMES[session.tool] ?? session.tool}{session.status ? <i data-status={session.status} /> : null}</span>
            <span className="remote-session-title">{session.title || folder(session.cwd) || session.tool}</span>
            <span className="remote-session-cwd">{folder(session.cwd)}</span>
          </button>
        </li>)}
        {sessions?.length === 0 && <li className="remote-empty">电脑上还没有打开的会话。</li>}
      </ul>
      <button type="button" className="remote-forget" onClick={forgetRemote}>断开并忘记这台电脑</button>
    </aside>}
    {current && <main className="remote-main">
      {!wide && <header className="remote-back"><button type="button" onClick={() => setSelected(null)} aria-label="返回">‹</button><span>{current.title || folder(current.cwd)}</span></header>}
      {current.tool === 'claude' && current.view === 'conversation'
        ? <ClaudeConversation key={current.id} sessionId={current.id} cwd={current.cwd || null} isActive isVisible />
        : <div className="remote-empty">这个会话类型下一步支持（目前先支持 Claude 对话）。</div>}
    </main>}
  </div>;
}
