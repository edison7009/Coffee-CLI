import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { commands, type WindowControlState } from '../../tauri';
import { useT } from '../../i18n/useT';
import { receiveOrchestration, useOrchestration } from '../../lib/orchestration';
import { canRequestControl, remoteHost, remoteWindowName, requestControl, type RemoteWindow } from '../../lib/remote-control';
import './ClaudeComposerControls.css';

const NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', dsh: 'DeepSeek Harness', pi: 'Pi', antigravity: 'Antigravity' };
const name = (tool: string) => NAMES[tool] ?? tool;
/** `codex` here, `codex@Studio` on another computer: the tool's name, and the computer for the second. */
const helperName = (helper: string) => { const [tool, computer] = helper.split('@'); return computer ? `${name(tool)} · ${computer}` : name(tool); };

const MONITOR = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="4" width="13" height="9" rx="2" /><rect x="9" y="11" width="13" height="9" rx="2" /></svg>;
const AUTO = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></svg>;
const LAPTOP = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="2" /><path d="M2 19h20" /></svg>;
const CHECK = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>;

/**
 * The composer's one collaboration chip. A conversation hands work to helpers: a tool on this computer, or one on
 * another computer whose window is open (`tool@computer`). Helpers come from coordination (src/orchestration.rs);
 * the computer this conversation operates directly, when it may, from Remote Control (src/window_control.rs).
 */
export function CollaborationPicker({ sessionId, coordinator, remote, onRemote }: { sessionId: string; coordinator: boolean; remote?: WindowControlState; onRemote?: (state: WindowControlState) => void }) {
  const t = useT();
  const { agents = [], picks = {}, remote: computers = [] } = useOrchestration();
  // Helpers on other computers only for a conversation that may operate remote windows (`remote`), as the backend offers them.
  const connected = computers.flatMap(computer => computer.agents.map(tool => `${tool}@${computer.computer}`));
  const remoteHelpers = remote ? connected : [];
  // A pick naming only helpers that are gone counts as automatic, the same as the backend; one on a computer that is
  // still here stays shown even where it may not be used, as the backend then offers no helper rather than every one.
  const pick = (picks[sessionId] ?? []).filter(tool => agents.includes(tool) || connected.includes(tool));
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  // The open windows' addresses, for the line under each computer's name (src/remote_window.rs).
  const [known, setKnown] = useState<RemoteWindow[]>([]);
  const anchor = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  useEffect(() => { setOpen(false); }, [sessionId]);
  useEffect(() => {
    if (!open || !remote) return;
    let current = true;
    void Promise.resolve().then(() => commands.remoteWindowList()).then(list => { if (current) setKnown(list ?? []); }, () => {});
    return () => { current = false; };
  }, [open, remote]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(272, window.innerWidth - 16);
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), bottom: window.innerHeight - rect.top + 6, width, maxHeight: Math.max(0, rect.top - 14) });
    };
    update(); window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => { if (!anchor.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); anchor.current?.focus(); } };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape); };
  }, [open]);
  const saveHelper = async (tools: string[]) => {
    setPending(true);
    try { receiveOrchestration(await commands.orchestrationSetPick(sessionId, tools)); }
    catch (error) { console.warn('[collaboration] helper not saved:', error); }
    finally { setPending(false); }
  };
  const saveWindow = async (window: string | null) => {
    if (!onRemote) return;
    setPending(true);
    try { onRemote(await commands.windowControlSetPick(sessionId, window)); }
    catch (error) {
      console.warn('[collaboration] window not saved:', error);
      void commands.windowControlState(sessionId).then(onRemote, () => {});
    } finally { setPending(false); }
  };

  const helper = pick.length === 1 ? pick[0] : null;
  const prefix = t('remote_control.window_prefix');
  const nameOf = (window: { window: string; title: string }) => known.find(w => w.label === window.window)?.name || remoteWindowName(window.title, prefix);
  const tied = remote?.windows.find(window => window.window === remote.pick);
  const parts = [coordinator ? (pick.length ? pick.map(helperName).join('、') : t('ai_remote.pick.auto')) : null, tied ? nameOf(tied) : null].filter(Boolean);
  const label = t('collab.prefix', { name: parts.join(' · ') || t('ai_remote.pick.auto') });
  const row = (key: string, selected: boolean, icon: React.ReactNode, text: string, hint: string, onClick: () => void, online = false) =>
    <button key={key} type="button" role="menuitemradio" aria-label={text} aria-checked={selected} disabled={pending} className={selected ? 'is-selected' : ''} onClick={() => { onClick(); setOpen(false); }}>
      <span className="remote-pick-icon" aria-hidden="true">{icon}{online && <i />}</span>
      <span className="remote-pick-text"><strong>{text}</strong>{hint && <small>{hint}</small>}</span>
      {selected && <span className="remote-pick-check">{CHECK}</span>}
    </button>;

  return <>
    <button ref={anchor} type="button" className={`gambit-capability is-orchestration is-picker${remote ? ' is-remote' : ''}${tied || pick.length ? ' is-tied' : ''}`} aria-haspopup="dialog" aria-expanded={open}
      aria-label={label} onClick={() => setOpen(value => !value)}>
      <span className="remote-pick-name">{label}</span>
    </button>
    {open && createPortal(<div className="claude-control-menu remote-pick-menu" ref={popup} role="dialog" aria-label={t('collab.helpers')} style={position} onMouseDown={e => e.stopPropagation()}>
      {coordinator && <>
        <p className="remote-pick-title">{t('collab.helpers')}</p>
        {row('auto', !helper, AUTO, t('ai_remote.pick.auto'), t('collab.auto_hint'), () => { void saveHelper([]); })}
        {agents.map(tool => row(tool, helper === tool, LAPTOP, name(tool), t('collab.this_computer'), () => { void saveHelper([tool]); }))}
        {remoteHelpers.map(tool => row(tool, helper === tool, MONITOR, name(tool.split('@')[0]), tool.split('@')[1] ?? '', () => { void saveHelper([tool]); }, true))}
      </>}
      {remote && <>
        {coordinator && <div className="remote-pick-divider" aria-hidden="true" />}
        <p className="remote-pick-title">{t('ai_remote.pick.title')}</p>
        {row('window-auto', !tied, AUTO, t('ai_remote.pick.auto'), t('ai_remote.pick.auto_hint'), () => { void saveWindow(null); })}
        {remote.windows.map(window => row(`window-${window.window}`, tied?.window === window.window, MONITOR, nameOf(window), remoteHost(known.find(w => w.label === window.window)?.origin ?? ''), () => { void saveWindow(window.window); }, true))}
        {!remote.windows.length && <p className="remote-pick-empty">{t('ai_remote.pick.none')}</p>}
      </>}
      {canRequestControl() && <>
        <div className="remote-pick-divider" aria-hidden="true" />
        <button type="button" className="remote-pick-control" onClick={() => { setOpen(false); requestControl(); }}><span className="remote-pick-plus" aria-hidden="true">+</span><span>{t('sidebar.devices.control')}</span></button>
      </>}
    </div>, document.body)}
  </>;
}
