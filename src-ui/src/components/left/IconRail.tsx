// 工作式's left edge: one narrow column of icons in place of the sidebar. Conversations open as a
// list beside it; everything else opens the same pages the sidebar opens in 代码式.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { createPortal } from 'react-dom';
import { getToolIcon } from '../center/CenterPanel';
import { getToolDisplayName } from '../../lib/tool-info';
import { getTabOrder, type TerminalSession } from '../../store/app-state';
import { HistoryBoard } from '../right/HistoryBoard';
import { RightPanel } from '../right/Compiler';
import { refreshHistory } from '../../lib/history-cache';
import { WebAccessStatus } from './WebAccessStatus';
import { getUnreadSessionReplies, sessionReplyKey, subscribeSessionReplies } from '../../lib/session-replies';
import './IconRail.css';

// Lucide strokes (license in /icons/LICENSE-lucide.txt).
const ICONS: Record<string, ReactNode> = {
  new: <><path d="M12 5v14M5 12h14" /></>,
  conversations: <><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  automations: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /><path d="M5 3 2 6" /><path d="m22 6-3-3" /></>,
  usage: <path d="M3 3v18h18M8 16v-5M13 16V5M18 16V9" />,
  changes: <><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><path d="M6 9v12" /></>,
  tools: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M14 17.5h7M17.5 14v7" /></>,
  devices: <><rect x="2" y="4" width="13" height="9" rx="2" /><rect x="9" y="11" width="13" height="9" rx="2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
};
const glyph = (name: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>;

/** A tip that opens to the right of the rail, level with what it names (not under the pointer). A tip
 *  with an action (close a conversation) stays while the pointer crosses over to it. */
type RailTip = { label: string; detail?: string; top: number; left: number; onClose?: () => void; closeLabel?: string };
function useRailTip() {
  const [tip, setTip] = useState<RailTip | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const cancelHide = () => window.clearTimeout(hideTimer.current);
  const hideSoon = () => { cancelHide(); hideTimer.current = window.setTimeout(() => setTip(null), 180); };
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener('scroll', hide, true); window.addEventListener('resize', hide); window.addEventListener('blur', hide);
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); window.removeEventListener('blur', hide); };
  }, [tip]);
  const show = (element: HTMLElement, label: string, detail?: string, close?: { onClose: () => void; label: string }) => {
    cancelHide();
    const rect = element.getBoundingClientRect();
    setTip({ label, detail, top: rect.top + rect.height / 2, left: rect.right + 8, onClose: close?.onClose, closeLabel: close?.label });
  };
  const tipFor = (label: string, detail?: string, close?: { onClose: () => void; label: string }) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(e.currentTarget, label, detail, close),
    onFocus: (e: React.FocusEvent<HTMLElement>) => show(e.currentTarget, label, detail, close),
    onMouseLeave: () => close ? hideSoon() : setTip(null), onBlur: () => close ? hideSoon() : setTip(null),
  });
  const node = tip && createPortal(<span className={`icon-rail-tip${tip.onClose ? ' has-action' : ''}`} role="tooltip" style={{ top: tip.top, left: tip.left }}
    onMouseEnter={tip.onClose ? cancelHide : undefined} onMouseLeave={tip.onClose ? hideSoon : undefined}>
    <span className="icon-rail-tip-text"><strong>{tip.label}</strong>{tip.detail && <small>{tip.detail}</small>}</span>
    {tip.onClose && <button type="button" className="icon-rail-tip-close" aria-label={tip.closeLabel} onClick={() => { const close = tip.onClose; setTip(null); close?.(); }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
    </button>}
  </span>, document.body);
  return { tipFor, tip: node, hide: () => setTip(null) };
}

/** One open conversation (Clear 方案 A): the first character of its title on a quiet tile, the tool's mark
 *  in the lower corner and its state in the upper one — a spinner while it works, a hollow blue ring when it
 *  waits for you, a blue dot for a reply you have not read. The full title (and close) is in the tip. */
function SessionButton({ session, active, unread, onPick, tipFor }: { session: TerminalSession; active: boolean; unread: boolean; onPick: () => void; tipFor: ReturnType<typeof useRailTip>['tipFor'] }) {
  const t = useT();
  const folder = session.folderPath?.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const title = session.toolTitle || (session.tool ? getToolDisplayName(session.tool) : t('explorer.new_session'));
  const letter = Array.from(title.trim())[0]?.toUpperCase() ?? '·';
  const state = session.agentStatus === 'working' ? 'working' : session.agentStatus === 'wait_input' ? 'waiting' : unread && !active ? 'unread' : '';
  return <button type="button" className="icon-rail-button icon-rail-session" aria-label={folder ? `${title} · ${folder}` : title} aria-current={active || undefined} onClick={onPick}
    {...tipFor(title, folder || undefined, { label: t('rail.close_tab'), onClose: () => window.dispatchEvent(new CustomEvent('coffee-close-tab', { detail: session.id })) })}>
    <span className="icon-rail-letter" aria-hidden="true">{letter}</span>
    <span className="icon-rail-tool-badge" aria-hidden="true">{getToolIcon(session.tool)}</span>
    {state && <span className={`icon-rail-state is-${state}`} aria-hidden="true"><i /></span>}
  </button>;
}

export function IconRail() {
  const { state, dispatch } = useAppState();
  const t = useT();
  const { tipFor, tip, hide } = useRailTip();
  // One side list at a time, opened by hovering its icon: the conversations, or the changes (修改记录).
  const [flyout, setFlyout] = useState<'conversations' | 'changes' | null>(null);
  const listOpen = flyout !== null;
  const list = useRef<HTMLDivElement>(null), toggle = useRef<HTMLButtonElement>(null), changesToggle = useRef<HTMLButtonElement>(null);
  // The list opens on hover and stays while the pointer is on the button or the list; leaving both closes it.
  const closeTimer = useRef<number | undefined>(undefined);
  const holdList = (which?: 'conversations' | 'changes') => { window.clearTimeout(closeTimer.current); if (which) setFlyout(which); };
  const releaseList = () => { window.clearTimeout(closeTimer.current); closeTimer.current = window.setTimeout(() => setFlyout(null), 220); };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // Picking a conversation (or anything that changes the page) puts the list away.
  useEffect(() => { setFlyout(null); }, [state.activeTerminalId, state.settingsOpen, state.usageOpen, state.automationsOpen, state.toolSettingsOpen]);
  useEffect(() => {
    if (!listOpen) return;
    if (flyout === 'conversations') refreshHistory();
    const outside = (e: PointerEvent) => { const target = e.target as Node; if (!list.current?.contains(target) && !toggle.current?.contains(target) && !changesToggle.current?.contains(target) && !(target as Element).closest?.('.ctx-menu, .settings-overlay, .folder-menu')) setFlyout(null); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { (flyout === 'changes' ? changesToggle : toggle).current?.focus(); setFlyout(null); } };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape); };
  }, [listOpen, flyout]);

  // A finished reply nobody has read yet (the same record the conversation list marks).
  const unread = useSyncExternalStore(subscribeSessionReplies, getUnreadSessionReplies, getUnreadSessionReplies);
  const button = (key: string, label: string, onClick: () => void, pressed: boolean, extra?: ReactNode) =>
    <button type="button" className="icon-rail-button" aria-label={label} aria-pressed={pressed} onClick={onClick} {...tipFor(label)}>{glyph(key)}{extra}</button>;
  // The open tabs, in tab order: 代码式's tab strip, as icons.
  const sessions = getTabOrder(state).map(id => state.terminals.find(session => session.id === id)).filter((session): session is TerminalSession => !!session?.tool);

  return <nav className="icon-rail" aria-label={t('rail.label')}>
    {/* Start something, or find something. */}
    {button('new', t('explorer.new_session'), () => window.dispatchEvent(new Event('coffee-new-session')), false)}
    <button ref={toggle} type="button" className="icon-rail-button" aria-label={t('rail.conversations')} aria-expanded={flyout === 'conversations'} aria-haspopup="dialog"
      onClick={() => setFlyout(open => open === 'conversations' ? null : 'conversations')} onMouseEnter={() => { hide(); holdList('conversations'); }} onMouseLeave={releaseList}>
      {glyph('search')}
    </button>
    {/* Changes open the same way, beside the rail: in Clear they belong with the conversation, not a right column. */}
    <button ref={changesToggle} type="button" className="icon-rail-button" aria-label={t('rail.changes')} aria-expanded={flyout === 'changes'} aria-haspopup="dialog"
      onClick={() => setFlyout(open => open === 'changes' ? null : 'changes')} onMouseEnter={() => { hide(); holdList('changes'); }} onMouseLeave={releaseList}>
      {glyph('changes')}
    </button>
    {/* What is open. */}
    {sessions.length > 0 && <span className="icon-rail-separator" aria-hidden="true" />}
    <div className="icon-rail-sessions" role="list" aria-label={t('rail.open_tabs')}>
      {sessions.map(session => <div role="listitem" key={session.id}><SessionButton session={session} active={session.id === state.activeTerminalId && !state.diffTabActive} tipFor={tipFor}
        unread={!!session.resumeToken && !!session.tool && unread.has(sessionReplyKey(session.tool, session.resumeToken))}
        onPick={() => dispatch({ type: 'SET_ACTIVE_TERMINAL', id: session.id })} /></div>)}
    </div>
    <span className="icon-rail-spacer" />
    {/* Everything else. */}
    {button('automations', t('automation.title'), () => dispatch({ type: 'SET_AUTOMATIONS_OPEN', open: !state.automationsOpen }), !!state.automationsOpen)}
    {button('usage', t('usage.title'), () => dispatch({ type: 'SET_USAGE_OPEN', open: !state.usageOpen }), !!state.usageOpen)}
    {button('tools', t('tools.title'), () => dispatch({ type: 'SET_TOOL_SETTINGS_OPEN', open: !state.toolSettingsOpen }), !!state.toolSettingsOpen)}
    {/* The sidebar's device menu, worn as an icon: its label stays for screen readers. */}
    <span className="icon-rail-button icon-rail-devices" {...tipFor(t('rail.devices'))}>{glyph('devices')}<WebAccessStatus /></span>
    {button('settings', t('settings.title'), () => dispatch({ type: 'TOGGLE_SETTINGS' }), !!state.settingsOpen)}
    {flyout === 'conversations' && <div ref={list} className="icon-rail-list" role="dialog" aria-label={t('rail.conversations')} onMouseEnter={() => holdList()} onMouseLeave={releaseList}>
      <div className="explorer-history-host"><HistoryBoard /></div>
    </div>}
    {flyout === 'changes' && <div ref={list} className="icon-rail-list icon-rail-changes" role="dialog" aria-label={t('rail.changes')} onMouseEnter={() => holdList()} onMouseLeave={releaseList}>
      <RightPanel />
    </div>}
    {tip}
  </nav>;
}
