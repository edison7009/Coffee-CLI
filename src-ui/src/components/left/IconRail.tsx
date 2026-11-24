// 工作式's left edge: one narrow column of icons in place of the sidebar. Conversations open as a
// list beside it; everything else opens the same pages the sidebar opens in 代码式.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { createPortal } from 'react-dom';
import { getToolIcon } from '../center/CenterPanel';
import { getToolDisplayName } from '../../lib/tool-info';
import { getTabOrder, type TerminalSession } from '../../store/app-state';
import { HistoryBoard } from '../right/HistoryBoard';
import { RightPanel } from '../right/Compiler';
import { getHistorySnapshot, prefetchHistory, refreshHistory, subscribeHistory } from '../../lib/history-cache';
import { openSessionRecord, requestTitleRename } from '../../lib/open-session-record';
import { SessionContextMenu } from '../right/SessionContextMenu';
import { WebAccessStatus } from './WebAccessStatus';
import { getUnreadSessionReplies, sessionReplyKey, subscribeSessionReplies } from '../../lib/session-replies';
import { useOrchestration } from '../../lib/orchestration';
import { tabFamilies, type TabChild } from '../../lib/tab-family';
import { NewSessionMenu } from './NewSessionMenu';
import { AppUpdateButton } from '../common/AppUpdate';
import './IconRail.css';

// Lucide strokes (license in /icons/LICENSE-lucide.txt).
const ICONS: Record<string, ReactNode> = {
  new: <><path d="M12 5v14M5 12h14" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  // Lucide message-square: the conversations list is a list of conversations, not a search.
  conversations: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
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
type RailTip = { label: string; detail?: string; top: number; left: number; kids?: TabChild[]; onPickKid?: (id: string) => void };
/** A conversation's sub-windows, listed in its tip: the tip stays open under the pointer so they can be picked. */
type TipExtras = { kids?: TabChild[]; onPickKid?: (id: string) => void };
function useRailTip() {
  const [tip, setTip] = useState<RailTip | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  // Centred on its button in whole pixels: a translateY(-50%) on an odd height put the text on a half pixel,
  // which WebKit draws soft.
  const tipRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = tipRef.current;
    if (!tip || !node) return;
    node.style.top = `${Math.round(Math.max(8, Math.min(tip.top - node.offsetHeight / 2, window.innerHeight - node.offsetHeight - 8)))}px`;
  }, [tip]);
  const cancelHide = () => window.clearTimeout(hideTimer.current);
  const hideSoon = () => { cancelHide(); hideTimer.current = window.setTimeout(() => setTip(null), 180); };
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener('scroll', hide, true); window.addEventListener('resize', hide); window.addEventListener('blur', hide);
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); window.removeEventListener('blur', hide); };
  }, [tip]);
  const show = (element: HTMLElement, label: string, detail?: string, close?: TipExtras) => {
    cancelHide();
    const rect = element.getBoundingClientRect();
    setTip({ label, detail, top: rect.top + rect.height / 2, left: rect.right + 8, kids: close?.kids, onPickKid: close?.onPickKid });
  };
  const tipFor = (label: string, detail?: string, close?: TipExtras) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(e.currentTarget, label, detail, close),
    onFocus: (e: React.FocusEvent<HTMLElement>) => show(e.currentTarget, label, detail, close),
    onMouseLeave: () => close?.kids?.length ? hideSoon() : setTip(null), onBlur: () => close?.kids?.length ? hideSoon() : setTip(null),
  });
  const node = tip && createPortal(<span ref={tipRef} className={`icon-rail-tip${tip.kids?.length ? ' has-action has-kids' : ''}`} role="tooltip" style={{ top: tip.top, left: Math.round(tip.left) }}
    onMouseEnter={tip.kids?.length ? cancelHide : undefined} onMouseLeave={tip.kids?.length ? hideSoon : undefined}>
    <span className="icon-rail-tip-head">
      <span className="icon-rail-tip-text"><strong>{tip.label}</strong>{tip.detail && <small>{tip.detail}</small>}</span>
    </span>
    {/* Its sub-windows, under the title: each with its state, a click switches to it. */}
    {!!tip.kids?.length && <span className="icon-rail-tip-kids">{tip.kids.map(kid => <button key={kid.id} type="button" className="icon-rail-tip-kid"
      onClick={() => { const pick = tip.onPickKid; setTip(null); pick?.(kid.id); }}>
      <span className="orchestration-status" data-state={kid.state} aria-hidden="true" />
      <span className="icon-rail-tip-kid-icon" aria-hidden="true">{getToolIcon(kid.tool)}</span>
      <span className="icon-rail-tip-kid-title">{kid.title || getToolDisplayName(kid.tool ?? '')}</span>
    </button>)}</span>}
  </span>, document.body);
  return { tipFor, tip: node, hide: () => setTip(null) };
}

/** One open conversation (Clear 方案 A): the first character of its title on a quiet tile, the tool's mark
 *  in the lower corner and its state in the upper one — a spinner while it works, a hollow blue ring when it
 *  waits for you, a blue dot for a reply you have not read. The full title (and close) is in the tip. */
function SessionButton({ session, active, unread, onPick, onMenu, tipFor, kids, onPickKid }: { session: TerminalSession; active: boolean; unread: boolean; onPick: () => void; onMenu: (x: number, y: number) => void; tipFor: ReturnType<typeof useRailTip>['tipFor']; kids?: TabChild[]; onPickKid: (id: string) => void }) {
  const t = useT();
  const folder = session.folderPath?.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const title = session.pinnedTitle || session.toolTitle || (session.tool ? getToolDisplayName(session.tool) : t('explorer.new_session'));
  const letter = Array.from(title.trim())[0]?.toUpperCase() ?? '·';
  const state = session.agentStatus === 'working' ? 'working' : session.agentStatus === 'wait_input' ? 'waiting' : unread && !active ? 'unread' : '';
  // Close sits on the icon's corner, where the pointer already is; the rest of the conversation's actions are on right-click.
  return <>
    <button type="button" className="icon-rail-button icon-rail-session" aria-label={folder ? `${title} · ${folder}` : title} aria-current={active || undefined} onClick={onPick}
      onContextMenu={event => { event.preventDefault(); onMenu(event.clientX, event.clientY); }}
      {...tipFor(title, folder || undefined, { kids, onPickKid })}>
      <span className="icon-rail-letter" aria-hidden="true">{letter}</span>
      <span className="icon-rail-tool-badge" aria-hidden="true">{getToolIcon(session.tool)}</span>
      {state && <span className={`icon-rail-state is-${state}`} aria-hidden="true"><i /></span>}
    </button>
    <button type="button" className="icon-rail-session-close" aria-label={`${t('rail.close_tab')} · ${title}`} onClick={() => window.dispatchEvent(new CustomEvent('coffee-close-tab', { detail: session.id }))}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
    </button>
  </>;
}

export function IconRail() {
  const { state, dispatch } = useAppState();
  const t = useT();
  const { tipFor, tip, hide } = useRailTip();
  // A conversation's right-click menu: the same as Work's title bar menu (rename, pin, copy, reveal), close last.
  const [sessionMenu, setSessionMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const history = useSyncExternalStore(subscribeHistory, getHistorySnapshot, getHistorySnapshot);
  useEffect(() => { if (sessionMenu) prefetchHistory(); }, [sessionMenu]);
  const menuTab = sessionMenu ? state.terminals.find(tab => tab.id === sessionMenu.id) : undefined;
  const menuRecord = menuTab && openSessionRecord(menuTab, history.sessions);
  // One side list at a time, opened by hovering its icon: the conversations, or the changes (修改记录).
  // 'new': the new-conversation menu (tools, then their folders) opened by hovering the + button.
  const [flyout, setFlyout] = useState<'conversations' | 'changes' | 'new' | null>(null);
  // A file opened from elsewhere (a changed file in the conversation) shows its diff where changes live here.
  const shownSelection = useRef(state.diffSelection);
  const [revealSelection, setRevealSelection] = useState(false);
  useEffect(() => {
    if (state.diffSelection === shownSelection.current) return;
    shownSelection.current = state.diffSelection;
    if (state.diffSelection && state.diffMode === 'overlay') { setRevealSelection(true); setFlyout('changes'); }
  }, [state.diffSelection, state.diffMode]);
  const newToggle = useRef<HTMLButtonElement>(null);
  // Opened from the keyboard (arrow on +): focus goes into the menu.
  const [newByKey, setNewByKey] = useState(false);
  useEffect(() => { if (flyout !== 'new') setNewByKey(false); }, [flyout]);
  const listOpen = flyout !== null;
  const list = useRef<HTMLDivElement>(null), toggle = useRef<HTMLButtonElement>(null), changesToggle = useRef<HTMLButtonElement>(null);
  // The list opens on hover and stays while the pointer is on the button or the list; leaving both closes it.
  const closeTimer = useRef<number | undefined>(undefined);
  const holdList = (which?: 'conversations' | 'changes' | 'new') => { window.clearTimeout(closeTimer.current); if (which) { if (which === 'changes' && flyout !== 'changes') setRevealSelection(false); setFlyout(which); } };
  const releaseList = () => { window.clearTimeout(closeTimer.current); closeTimer.current = window.setTimeout(() => setFlyout(null), 220); };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // Picking a conversation (or anything that changes the page) puts the list away.
  useEffect(() => { setFlyout(null); }, [state.activeTerminalId, state.settingsOpen, state.usageOpen, state.automationsOpen, state.toolSettingsOpen]);
  useEffect(() => {
    if (!listOpen) return;
    if (flyout === 'conversations') refreshHistory();
    const outside = (e: PointerEvent) => { const target = e.target as Node; if (!list.current?.contains(target) && !toggle.current?.contains(target) && !changesToggle.current?.contains(target) && !newToggle.current?.contains(target) && !(target as Element).closest?.('.ctx-menu, .settings-overlay, .folder-menu')) setFlyout(null); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { (flyout === 'changes' ? changesToggle : flyout === 'new' ? newToggle : toggle).current?.focus(); setFlyout(null); } };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape); };
  }, [listOpen, flyout]);

  // A finished reply nobody has read yet (the same record the conversation list marks).
  const unread = useSyncExternalStore(subscribeSessionReplies, getUnreadSessionReplies, getUnreadSessionReplies);
  const button = (key: string, label: string, onClick: () => void, pressed: boolean, extra?: ReactNode) =>
    <button type="button" className="icon-rail-button" aria-label={label} aria-pressed={pressed} onClick={onClick} {...tipFor(label)}>{glyph(key)}{extra}</button>;
  // The open tabs, in tab order: 代码式's tab strip, as icons.
  // Sub-windows are not tiles of their own: their parent's tip lists them.
  const orchestration = useOrchestration();
  const families = useMemo(() => tabFamilies(state.terminals, orchestration.tasks), [state.terminals, orchestration.tasks]);
  const sessions = getTabOrder(state).map(id => state.terminals.find(session => session.id === id)).filter((session): session is TerminalSession => !!session?.tool && !families.childIds.has(session.id));

  return <nav className="icon-rail" aria-label={t('rail.label')}>
    {/* Start something, or find something. */}
    {/* Click: the start page in the middle, as before. Hover: the tools and their folders, beside the rail. */}
    <button ref={newToggle} type="button" className="icon-rail-button icon-rail-start" aria-label={t('explorer.new_session')} aria-expanded={flyout === 'new'} aria-haspopup="menu"
      onClick={() => { setFlyout(null); window.dispatchEvent(new Event('coffee-new-session')); }} onMouseEnter={() => { hide(); holdList('new'); }} onMouseLeave={releaseList}
      onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); setNewByKey(true); holdList('new'); } }}>
      {glyph('new')}
    </button>
    <button ref={toggle} type="button" className="icon-rail-button" aria-label={t('rail.conversations')} aria-expanded={flyout === 'conversations'} aria-haspopup="dialog"
      onClick={() => setFlyout(open => open === 'conversations' ? null : 'conversations')} onMouseEnter={() => { hide(); holdList('conversations'); }} onMouseLeave={releaseList}>
      {glyph('conversations')}
    </button>
    {/* Changes open the same way, beside the rail: in Clear they belong with the conversation, not a right column. */}
    <button ref={changesToggle} type="button" className="icon-rail-button" aria-label={t('rail.changes')} aria-expanded={flyout === 'changes'} aria-haspopup="dialog"
      onClick={() => { setRevealSelection(false); setFlyout(open => open === 'changes' ? null : 'changes'); }} onMouseEnter={() => { hide(); holdList('changes'); }} onMouseLeave={releaseList}>
      {glyph('changes')}
    </button>
    {/* What is open. */}
    {sessions.length > 0 && <span className="icon-rail-separator" aria-hidden="true" />}
    <div className="icon-rail-sessions" role="list" aria-label={t('rail.open_tabs')}>
      {sessions.map(session => <div role="listitem" className="icon-rail-session-item" key={session.id}><SessionButton session={session} tipFor={tipFor}
        onMenu={(x, y) => { hide(); setSessionMenu({ id: session.id, x, y }); }}
        active={(session.id === state.activeTerminalId || !!families.children.get(session.id)?.some(kid => kid.id === state.activeTerminalId)) && !state.diffTabActive}
        kids={families.children.get(session.id)} onPickKid={id => dispatch({ type: 'SET_ACTIVE_TERMINAL', id })}
        unread={!!session.resumeToken && !!session.tool && unread.has(sessionReplyKey(session.tool, session.resumeToken))}
        onPick={() => dispatch({ type: 'SET_ACTIVE_TERMINAL', id: session.id })} /></div>)}
    </div>
    <span className="icon-rail-spacer" />
    {/* A newer Coffee CLI: the same update as Code's sidebar (download, then its notes before installing). */}
    <AppUpdateButton rail tip={label => tipFor(label)} />
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
    {flyout === 'new' && <div ref={list} className="icon-rail-list icon-rail-new" role="dialog" aria-label={t('explorer.new_session')} onMouseEnter={() => holdList()} onMouseLeave={releaseList}>
      <NewSessionMenu autoFocus={newByKey} onDone={() => setFlyout(null)} />
    </div>}
    {flyout === 'changes' && <div ref={list} className="icon-rail-list icon-rail-changes" role="dialog" aria-label={t('rail.changes')} onMouseEnter={() => holdList()} onMouseLeave={releaseList}>
      <RightPanel revealSelection={revealSelection} />
    </div>}
    {tip}
    {sessionMenu && menuTab && menuRecord && <SessionContextMenu menu={{ session: menuRecord.saved, x: sessionMenu.x, y: sessionMenu.y }} onClose={() => setSessionMenu(null)} unsaved={!menuRecord.record}
      onRename={() => { dispatch({ type: 'SET_ACTIVE_TERMINAL', id: menuTab.id }); requestTitleRename(menuTab.id); }}
      onDelete={() => {}}
      onCloseConversation={() => window.dispatchEvent(new CustomEvent('coffee-close-tab', { detail: menuTab.id }))} />}
  </nav>;
}
