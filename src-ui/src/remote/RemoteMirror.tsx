// In the browser: the tab strip is the desktop's. Re-reads the desktop's tab list whenever it
// changes and shows tabs this browser asked the desktop to open (see SYNC_MIRROR_TABS).
import { useEffect } from 'react';
import { openedFromBrowser, useAppState, type ClaudeMode, type MirrorTab, type TerminalSession, type ToolType } from '../store/app-state';
import { onRemoteEvent, onRemoteStatus, remoteRequest, remoteStatus } from './bridge';

interface ListedSession {
  id: string; tool: ToolType; title: string; cwd: string;
  claudeMode?: ClaudeMode; codexMode?: ClaudeMode; opencodeMode?: ClaudeMode; piMode?: ClaudeMode;
  worktree?: TerminalSession['worktree']; parentId?: string;
}

export function RemoteMirror() {
  const { state, dispatch } = useAppState();

  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, running = false, again = false;
    const refresh = async () => {
      if (running) { again = true; return; }
      running = true;
      try {
        const { sessions } = await remoteRequest<{ sessions: ListedSession[] }>('session.list');
        if (disposed) return;
        const tabs: MirrorTab[] = sessions.map(({ id, tool, title, cwd, claudeMode, codexMode, opencodeMode, piMode, worktree, parentId }) =>
          ({ id, tool, title, cwd: cwd || null, claudeMode, codexMode, opencodeMode, piMode, worktree, parentId }));
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
