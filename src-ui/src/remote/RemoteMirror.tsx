// In the browser: the tab strip and the settings are the desktop's. Re-reads the desktop's tab list whenever it
// changes and shows tabs this browser asked the desktop to open (see SYNC_MIRROR_TABS).
import { useEffect } from 'react';
import { DRAFT_QUIET_MS, openedFromBrowser, typingDraft, useAppState, type AgentStatus, type ClaudeMode, type MirroredSettings, type MirrorTab, type TerminalSession, type ToolType } from '../store/app-state';
import { mirrorTarget } from '../lib/session-mirror';
import { followDesktopNotices } from '../lib/notify-sound';
import { useT } from '../i18n/useT';
import { onRemoteEvent, onRemoteStatus, remoteRequest, remoteStatus } from './bridge';

interface ListedSession {
  id: string; tool: ToolType; title: string; cwd: string;
  claudeMode?: ClaudeMode; codexMode?: ClaudeMode; opencodeMode?: ClaudeMode; piMode?: ClaudeMode;
  worktree?: TerminalSession['worktree']; parentId?: string; status?: AgentStatus | null;
}

export function RemoteMirror() {
  const { state, dispatch } = useAppState();
  const t = useT();
  const waitTitle = t('remote.notify.wait'), doneTitle = t('remote.notify.done');
  // The desktop's completion and approval chimes, with a page title mark while this tab is in the background.
  useEffect(() => followDesktopNotices(waitTitle, doneTitle), [waitTitle, doneTitle]);

  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, running = false, again = false;
    const refresh = async () => {
      if (running) { again = true; return; }
      running = true;
      try {
        const { sessions } = await remoteRequest<{ sessions: ListedSession[] }>('session.list');
        if (disposed) return;
        const tabs: MirrorTab[] = sessions.map(({ id, tool, title, cwd, claudeMode, codexMode, opencodeMode, piMode, worktree, parentId, status }) =>
          ({ id, tool, title, cwd: cwd || null, claudeMode, codexMode, opencodeMode, piMode, worktree, parentId, status: status ?? undefined }));
        dispatch({ type: 'SYNC_MIRROR_TABS', tabs });
      } catch { /* Offline: the next connection refreshes. */ }
      finally {
        running = false;
        if (again && !disposed) { again = false; void refresh(); }
      }
    };
    const soon = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 100); };
    if (remoteStatus() === 'connected') void refresh();
    const stopStatus = onRemoteStatus(status => { if (status === 'connected') void refresh(); });
    const stopEvents = onRemoteEvent(event => { if (event.event === 'session.changed') soon(); });
    return () => { disposed = true; clearTimeout(timer); stopStatus(); stopEvents(); };
  }, [dispatch]);

  // The desktop's settings: theme, language, fonts, wallpaper and the rest look exactly as there.
  useEffect(() => mirrorTarget('app', 'settings', settings => dispatch({ type: 'MIRROR_SETTINGS', settings: settings as Partial<MirroredSettings> })), [dispatch]);

  // Drafts typed on the desktop; a composer someone is typing in here keeps its words until they pause.
  useEffect(() => {
    let latest: Record<string, string> = {}, timer: ReturnType<typeof setTimeout> | undefined;
    const apply = () => {
      clearTimeout(timer); timer = undefined;
      const entries = Object.entries(latest);
      dispatch({ type: 'MIRROR_DRAFTS', drafts: Object.fromEntries(entries.filter(([id]) => !typingDraft(id))) });
      // Held back while typing here: offered again once the typing pauses.
      if (entries.some(([id]) => typingDraft(id))) timer = setTimeout(apply, DRAFT_QUIET_MS);
    };
    const stop = mirrorTarget('app', 'drafts', drafts => { latest = drafts as Record<string, string>; apply(); });
    return () => { clearTimeout(timer); stop(); };
  }, [dispatch]);

  // A tab opened from here is shown as soon as the desktop has it.
  useEffect(() => {
    for (const id of openedFromBrowser) {
      if (!state.terminals.some(tab => tab.id === id && tab.mirror)) continue;
      openedFromBrowser.delete(id);
      if (state.activeTerminalId !== id) dispatch({ type: 'SET_ACTIVE_TERMINAL', id });
    }
  }, [state.terminals, state.activeTerminalId, dispatch]);
  return null;
}
