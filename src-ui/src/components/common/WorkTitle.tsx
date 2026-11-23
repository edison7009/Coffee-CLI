import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useT } from '../../i18n/useT';
import type { TerminalSession } from '../../store/app-state';
import type { SavedSession } from '../../tauri';
import { getHistorySnapshot, subscribeHistory } from '../../lib/history-cache';
import { getRenamedSnapshot, setCustomName, subscribeRenamed } from '../../lib/renamed-sessions';
import { SessionContextMenu, type SessionCtxMenuState } from '../right/SessionContextMenu';

/** Work's title bar: 「project / conversation」, and a ⌄ after the title that opens the same menu as right-clicking
 *  the conversation in the list (rename, pin, copy its id or resume command, reveal), with close in place of delete. */
export function WorkTitle({ tab }: { tab: TerminalSession }) {
  const t = useT();
  const history = useSyncExternalStore(subscribeHistory, getHistorySnapshot, getHistorySnapshot);
  const renamed = useSyncExternalStore(subscribeRenamed, getRenamedSnapshot, getRenamedSnapshot);
  const [menu, setMenu] = useState<SessionCtxMenuState | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing !== null) input.current?.select(); }, [editing !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // The conversation as the list knows it (its saved record), or this open tab as a live one.
  const saved: SavedSession = history.sessions.find(item => item.tool === tab.tool && !!tab.resumeToken && item.session_token === tab.resumeToken)
    ?? { id: `live:${tab.id}`, name: tab.toolTitle ?? '', tool: tab.tool ?? '', cwd: tab.folderPath ?? '', session_token: tab.resumeToken ?? null, saved_at: new Date().toISOString() };
  const key = `${saved.tool}:${saved.id}`;
  const folder = tab.folderPath?.split(/[\\/]/).filter(Boolean).pop();
  const name = renamed[key] ?? tab.pinnedTitle ?? tab.toolTitle ?? saved.name;
  if (!folder && !name) return null;
  const finish = (save: boolean) => { if (save && editing !== null) setCustomName(saved.tool, saved.id, editing.trim() || null); setEditing(null); };
  return <div className="titlebar-work-title">
    {folder && <span className="titlebar-work-folder">{folder}</span>}
    {folder && name && <span className="titlebar-work-slash" aria-hidden="true">/</span>}
    {editing !== null
      ? <input ref={input} className="titlebar-work-rename" value={editing} aria-label={t('menu.rename')} onChange={event => setEditing(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') finish(true); else if (event.key === 'Escape') finish(false); }} onBlur={() => finish(true)} />
      : name && <span className="titlebar-work-name">{name}</span>}
    {editing === null && <button type="button" className="titlebar-work-menu" aria-haspopup="menu" aria-expanded={!!menu} aria-label={t('titlebar.conversation_menu')}
      onClick={event => { const r = event.currentTarget.getBoundingClientRect(); setMenu(menu ? null : { session: saved, x: r.left, y: r.bottom + 4 }); }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>}
    {menu && <SessionContextMenu menu={menu} onClose={() => setMenu(null)}
      onRename={() => setEditing(name ?? '')}
      onDelete={() => {}}
      // An open conversation is closed, not deleted: the same as its tab's ×, history kept.
      onCloseConversation={() => window.dispatchEvent(new CustomEvent('coffee-close-tab', { detail: tab.id }))} />}
  </div>;
}
