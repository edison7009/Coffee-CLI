import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { commands, type WindowControlState } from '../../tauri';
import { useT } from '../../i18n/useT';
import './ClaudeComposerControls.css';

/**
 * The composer's remote control chip: leaves the choice of window to the AI, or keeps this
 * conversation working in one remote computer window. Only for a tab started with the window tools.
 */
export function RemoteControlPicker({ sessionId, state, onState }: { sessionId: string; state: WindowControlState; onState: (state: WindowControlState) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const anchor = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  useEffect(() => { setOpen(false); }, [sessionId]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(240, window.innerWidth - 16);
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
  const picked = state.windows.find(window => window.window === state.pick);
  const options = [{ window: null as string | null, text: t('ai_remote.pick.auto') }, ...state.windows.map(window => ({ window: window.window as string | null, text: window.title }))];
  const current = picked?.window ?? null;
  return <>
    <button ref={anchor} type="button" className="gambit-capability is-remote is-picker" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {t('ai_remote.pick.prefix', { name: picked?.title ?? t('ai_remote.pick.auto') })}
    </button>
    {open && createPortal(<div className="claude-control-menu orchestration-pick-menu" ref={popup} role="dialog" aria-label={t('tools.tab.remote')} style={position} onMouseDown={e => e.stopPropagation()}>
      {options.map(option => <button key={option.window ?? 'auto'} type="button" role="menuitemradio" aria-checked={current === option.window} disabled={pending} className={current === option.window ? 'is-selected' : ''} onClick={() => { void save(option.window); setOpen(false); }}>
        <span>{option.text}</span>
        <span className="orchestration-pick-check" aria-hidden="true">{current === option.window ? '✓' : ''}</span>
      </button>)}
      {!state.windows.length && <p className="remote-pick-empty">{t('ai_remote.pick.none')}</p>}
    </div>, document.body)}
  </>;
}
