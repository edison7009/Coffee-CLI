import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { commands, type WindowControlState } from '../../tauri';
import { useT } from '../../i18n/useT';
import { canRequestControl, remoteHost, remoteWindowName, requestControl, type RemoteWindow } from '../../lib/remote-control';
import './ClaudeComposerControls.css';

const MONITOR = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="4" width="13" height="9" rx="2" /><rect x="9" y="11" width="13" height="9" rx="2" /></svg>;
const AUTO = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></svg>;
const CHECK = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>;

/**
 * The composer's remote control chip: leaves the choice of window to the AI, or keeps this
 * conversation working in one remote computer window. Only for a tab started with the window tools.
 */
export function RemoteControlPicker({ sessionId, state, onState }: { sessionId: string; state: WindowControlState; onState: (state: WindowControlState) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  // The open windows' addresses, for the line under each name (src/remote_window.rs).
  const [known, setKnown] = useState<RemoteWindow[]>([]);
  const anchor = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  useEffect(() => { setOpen(false); }, [sessionId]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    void Promise.resolve().then(() => commands.remoteWindowList()).then(list => { if (current) setKnown(list ?? []); }, () => {});
    return () => { current = false; };
  }, [open, state.windows]);
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
  const save = async (pick: string | null) => {
    setPending(true);
    try { onState(await commands.windowControlSetPick(sessionId, pick)); }
    catch (error) {
      console.warn('[remote control] pick not saved:', error);
      void commands.windowControlState(sessionId).then(onState, () => {});
    } finally { setPending(false); }
  };
  const prefix = t('remote_control.window_prefix');
  const nameOf = (window: { window: string; title: string }) => known.find(w => w.label === window.window)?.name || remoteWindowName(window.title, prefix);
  const picked = state.windows.find(window => window.window === state.pick);
  const name = picked ? nameOf(picked) : t('ai_remote.pick.auto');
  const options = [
    { window: null as string | null, text: t('ai_remote.pick.auto'), hint: t('ai_remote.pick.auto_hint') },
    ...state.windows.map(window => ({ window: window.window as string | null, text: nameOf(window), hint: remoteHost(known.find(w => w.label === window.window)?.origin ?? '') })),
  ];
  const current = picked?.window ?? null;
  return <>
    <button ref={anchor} type="button" className={`gambit-capability is-remote is-picker${picked ? ' is-tied' : ''}`} aria-haspopup="dialog" aria-expanded={open}
      aria-label={t('ai_remote.pick.prefix', { name })} onClick={() => setOpen(value => !value)}>
      {MONITOR}<span className="remote-pick-name">{name}</span>
    </button>
    {open && createPortal(<div className="claude-control-menu remote-pick-menu" ref={popup} role="dialog" aria-label={t('tools.tab.remote')} style={position} onMouseDown={e => e.stopPropagation()}>
      <p className="remote-pick-title">{t('ai_remote.pick.title')}</p>
      {options.map(option => <button key={option.window ?? 'auto'} type="button" role="menuitemradio" aria-label={option.text} aria-checked={current === option.window} disabled={pending} className={current === option.window ? 'is-selected' : ''} onClick={() => { void save(option.window); setOpen(false); }}>
        <span className="remote-pick-icon" aria-hidden="true">{option.window ? MONITOR : AUTO}{option.window && <i />}</span>
        <span className="remote-pick-text"><strong>{option.text}</strong>{option.hint && <small>{option.hint}</small>}</span>
        {current === option.window && <span className="remote-pick-check">{CHECK}</span>}
      </button>)}
      {!state.windows.length && <p className="remote-pick-empty">{t('ai_remote.pick.none')}</p>}
      {canRequestControl() && <>
        <div className="remote-pick-divider" aria-hidden="true" />
        <button type="button" className="remote-pick-control" onClick={() => { setOpen(false); requestControl(); }}><span className="remote-pick-plus" aria-hidden="true">+</span><span>{t('sidebar.devices.control')}</span></button>
      </>}
    </div>, document.body)}
  </>;
}

