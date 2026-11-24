import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useT } from '../../i18n/useT';
import { useAppState, type TerminalSession } from '../../store/app-state';
import { getHistorySnapshot, prefetchHistory, subscribeHistory } from '../../lib/history-cache';
import { getRenamedSnapshot, setCustomName, subscribeRenamed } from '../../lib/renamed-sessions';
import { SessionContextMenu, type SessionCtxMenuState } from '../right/SessionContextMenu';
import { onTitleRename, openSessionRecord, takeTitleRename } from '../../lib/open-session-record';

/** Work's title bar: 「project / conversation」, and a ⌄ after the title that opens the same menu as right-clicking
 *  the conversation in the list (rename, pin, copy its id or resume command, reveal), with close in place of delete. */
export function WorkTitle({ tab }: { tab: TerminalSession }) {
  const t = useT();
  const { dispatch } = useAppState();
  const history = useSyncExternalStore(subscribeHistory, getHistorySnapshot, getHistorySnapshot);
  const renamed = useSyncExternalStore(subscribeRenamed, getRenamedSnapshot, getRenamedSnapshot);
  const [menu, setMenu] = useState<SessionCtxMenuState | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Escape (or anything that cancels) is followed by the field's blur as it goes: that blur must not save.
  const cancelled = useRef(false);
  const composedAt = useRef(0);
  // Work loads the history list only when it is opened; the title needs this conversation's record for rename and pin.
  useEffect(() => { prefetchHistory(); }, []);
  useEffect(() => { if (editing !== null) { input.current?.focus(); input.current?.select(); } }, [editing !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // The conversation as the list knows it (its saved record), or, until it has one, this open tab as a live one.
  const { saved, record } = openSessionRecord(tab, history.sessions);
  const key = `${saved.tool}:${saved.id}`;
  const folder = tab.folderPath?.split(/[\\/]/).filter(Boolean).pop();
  const name = (record ? renamed[key] : undefined) ?? tab.toolTitle ?? saved.name;
  // A rename asked for from the rail's menu: this title edits it once this conversation is the one shown.
  useEffect(() => {
    const start = () => { cancelled.current = false; setEditing(name ?? ''); };
    if (takeTitleRename(tab.id)) queueMicrotask(start);
    return onTitleRename(id => { if (id === tab.id && takeTitleRename(id)) start(); });
  }, [tab.id, name]);
  if (!folder && !name) return null;
  const finish = (save: boolean) => {
    if (save && !cancelled.current && editing !== null) {
      const value = editing.trim() || null;
      setCustomName(saved.tool, saved.id, value);
      // The tab, the rail and a phone show the open conversation by this name too.
      dispatch({ type: 'SET_PINNED_TITLE', id: tab.id, title: value ?? undefined });
    }
    cancelled.current = false;
    setEditing(null);
  };
  const toggleMenu = (event: React.MouseEvent<HTMLElement>) => { const r = event.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { session: saved, x: r.left, y: r.bottom + 4 }); };
  return <div className="titlebar-work-title">
    {editing !== null ? <>
      {folder && <span className="titlebar-work-folder">{folder}</span>}
      {folder && <span className="titlebar-work-slash" aria-hidden="true">/</span>}
      <input ref={input} className="titlebar-work-rename" value={editing} aria-label={t('menu.rename')} onChange={event => setEditing(event.target.value)}
        onCompositionEnd={() => { composedAt.current = performance.now(); }}
        onKeyDown={event => {
          // An input method's confirming Enter picks the candidate; it doesn't save (macOS WebKit sends it as keyCode 229 just after compositionend).
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || performance.now() - composedAt.current < 50) return;
          if (event.key === 'Enter') finish(true);
          else if (event.key === 'Escape') { cancelled.current = true; finish(false); }
        }} onBlur={() => finish(true)} />
    </> : <button type="button" className="titlebar-work-menu" aria-haspopup="menu" aria-expanded={!!menu} aria-label={`${[folder, name].filter(Boolean).join(' / ')} · ${t('titlebar.conversation_menu')}`}
      // The whole title opens the conversation's menu, not only its chevron. The open menu closes on any mousedown
      // outside it, and a double-click here must not zoom the window: the title handles both itself.
      onMouseDown={event => event.nativeEvent.stopImmediatePropagation()} onDoubleClick={event => event.stopPropagation()}
      onClick={toggleMenu}>
      {folder && <span className="titlebar-work-folder">{folder}</span>}
      {folder && name && <span className="titlebar-work-slash" aria-hidden="true">/</span>}
      {name && <span className="titlebar-work-name">{name}</span>}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>}
    {menu && <SessionContextMenu menu={menu} onClose={() => setMenu(null)} unsaved={!record}
      onRename={() => { cancelled.current = false; setEditing(name ?? ''); }}
      onDelete={() => {}}
      // An open conversation is closed, not deleted: the same as its tab's ×, history kept.
      onCloseConversation={() => window.dispatchEvent(new CustomEvent('coffee-close-tab', { detail: tab.id }))} />}
  </div>;
}
