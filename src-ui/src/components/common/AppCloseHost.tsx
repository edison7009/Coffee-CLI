import { useEffect, useMemo, useRef, useState } from 'react';
import { commands, isTauri } from '../../tauri';
import { useT } from '../../i18n/useT';
import { useAppState, type TerminalSession } from '../../store/app-state';
import { KEEP_RUNNING_LABEL, getCloseBehavior, runningSessions, setCloseBehavior } from '../../lib/close-behavior';
import { getToolDisplayName } from '../../lib/tool-info';
import { homeShortPath } from '../../lib/home-short-path';
import { IS_MACOS, IS_WINDOWS } from '../../lib/platform';
import './AppCloseHost.css';

const LISTED = 3;

/** Answers the main window's close requests and keeps the tray / menu bar menu current. */
export function AppCloseHost() {
  const t = useT(), { state, dispatch } = useAppState();
  const [home, setHome] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const running = useMemo(() => runningSessions(state.terminals), [state.terminals]);
  const runningRef = useRef(running), openRef = useRef(open);
  useEffect(() => { runningRef.current = running; openRef.current = open; }, [running, open]);

  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    import('@tauri-apps/api/path').then(path => path.homeDir()).then(dir => { if (alive) setHome(dir); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const label = (session: TerminalSession) => {
    const name = session.tool === 'terminal' ? t('tool.terminal') : getToolDisplayName(session.tool ?? '');
    return session.folderPath ? `${name} · ${homeShortPath(session.folderPath, home)}` : name;
  };

  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void)[] = [], cancelled = false;
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const handles = await Promise.all([
        listen<number>('main-window-close-requested', event => {
          void commands.appCloseAck(event.payload).catch(() => {});
          if (openRef.current) return;
          const behavior = getCloseBehavior();
          if (behavior === 'keep') void commands.appKeepRunning().catch(() => commands.appQuit());
          else if (behavior === 'quit' || runningRef.current.length === 0) void commands.appQuit();
          else setOpen(true);
        }),
        listen<string>('tray-focus-tab', event => dispatch({ type: 'SET_ACTIVE_TERMINAL', id: event.payload })),
      ]);
      if (cancelled) handles.forEach(stop => stop()); else unlisten = handles;
    }).catch(() => {});
    return () => { cancelled = true; unlisten.forEach(stop => stop()); };
  }, [dispatch]);

  // The tray menu lists the running tabs; debounced so a burst of tab changes sends one update.
  const trayKey = JSON.stringify([t('tray.open'), t('tray.quit'), running.filter(session => !session.isHidden).map(session => [session.id, label(session)])]);
  useEffect(() => {
    if (!isTauri || !(IS_WINDOWS || IS_MACOS)) return;
    const timer = setTimeout(() => {
      const [openLabel, quitLabel, sessions] = JSON.parse(trayKey) as [string, string, [string, string][]];
      void commands.appTrayMenu({ open: openLabel, quit: quitLabel, sessions: sessions.map(([id, text]) => ({ id, label: text })) }).catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [trayKey]);

  if (!open) return null;
  return <AppCloseDialog sessions={running} label={label} onClose={() => setOpen(false)} />;
}

function AppCloseDialog({ sessions, label, onClose }: { sessions: TerminalSession[]; label: (session: TerminalSession) => string; onClose: () => void }) {
  const t = useT(), ref = useRef<HTMLDialogElement>(null), keep = useRef<HTMLButtonElement>(null);
  const [remember, setRemember] = useState(false);
  // showModal focuses the first control (×); the choice that loses nothing takes focus instead.
  useEffect(() => { ref.current?.showModal(); keep.current?.focus(); }, []);
  const listed = sessions.slice(0, LISTED), more = sessions.length - listed.length;
  const choose = (behavior: 'keep' | 'quit') => {
    if (remember) setCloseBehavior(behavior);
    onClose();
    if (behavior === 'keep') void commands.appKeepRunning().catch(() => {});
    else void commands.appQuit();
  };
  return <dialog ref={ref} className="tool-config-modal app-close-dialog" aria-labelledby="app-close-title" aria-describedby="app-close-description" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="tool-config-header"><span id="app-close-title">{t('app_close.title')}</span><button type="button" className="tool-config-close close-button" aria-label={t('app_close.cancel')} onClick={onClose}>×</button></div>
    <div className="tool-config-body">
      <p id="app-close-description">{t('app_close.running', { count: sessions.length })}</p>
      <ul className="app-close-list">
        {listed.map(session => <li key={session.id} className={session.agentStatus === 'working' ? 'is-working' : undefined}>
          <span className="app-close-name"><bdi>{label(session)}</bdi></span>
          {session.agentStatus === 'working' && <span className="app-close-status">{t('app_close.working')}</span>}
        </li>)}
        {more > 0 && <li className="app-close-more">{t('app_close.more', { count: more })}</li>}
      </ul>
      <label className="app-close-remember"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />{t('app_close.remember')}</label>
    </div>
    <div className="tool-config-buttons">
      <button type="button" className="tool-config-btn tool-config-btn-subtle" onClick={onClose}>{t('app_close.cancel')}</button>
      <button type="button" ref={keep} className="tool-config-btn tool-config-btn-subtle" onClick={() => choose('keep')}>{t(KEEP_RUNNING_LABEL)}</button>
      <button type="button" className="tool-config-btn tool-config-btn-primary" onClick={() => choose('quit')}>{t('app_close.quit')}</button>
    </div>
  </dialog>;
}
