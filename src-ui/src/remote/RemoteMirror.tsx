// In the browser: keeps the tab strip in step with the desktop's terminal tabs, so the
// browser shows the same terminals the desktop has open (see SYNC_MIRROR_TABS).
import { useEffect, useRef } from 'react';
import { useAppState, type MirrorTab, type ToolType } from '../store/app-state';
import { onRemoteEvent, onRemoteStatus, remoteRequest, remoteStatus } from './bridge';

interface ListedSession { id: string; tool: ToolType; view: 'terminal' | 'conversation'; title: string; cwd: string }

export function RemoteMirror() {
  const { state, dispatch } = useAppState();
  // Desktop terminals closed here stay closed here, until the desktop closes them too.
  const dismissed = useRef(new Set<string>());
  const listed = useRef(new Set<string>());
  const shown = useRef(new Set<string>());

  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined, running = false, again = false;
    const refresh = async () => {
      if (running) { again = true; return; }
      running = true;
      try {
        const { sessions } = await remoteRequest<{ sessions: ListedSession[] }>('session.list');
        if (disposed) return;
        const terminals = sessions.filter(session => session.view === 'terminal');
        listed.current = new Set(terminals.map(session => session.id));
        for (const id of [...dismissed.current]) if (!listed.current.has(id)) dismissed.current.delete(id);
        const tabs: MirrorTab[] = terminals.filter(session => !dismissed.current.has(session.id))
          .map(session => ({ id: session.id, tool: session.tool, cwd: session.cwd || null, title: session.title }));
        dispatch({ type: 'SYNC_MIRROR_TABS', tabs });
      } catch { /* Offline: the next connection refreshes. */ }
      finally {
        running = false;
        if (again && !disposed) { again = false; void refresh(); }
      }
    };
    const soon = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 150); };
    if (remoteStatus() === 'connected') void refresh();
    const stopStatus = onRemoteStatus(status => { if (status === 'connected') void refresh(); });
    const stopEvents = onRemoteEvent(event => { if (event.event === 'session.changed') soon(); });
    return () => { disposed = true; clearTimeout(timer); stopStatus(); stopEvents(); };
  }, [dispatch]);

  // A mirror tab that disappears while the desktop still lists it was closed in the browser.
  useEffect(() => {
    const now = new Set(state.terminals.filter(tab => tab.mirror).map(tab => tab.id));
    for (const id of shown.current) if (!now.has(id) && listed.current.has(id)) dismissed.current.add(id);
    shown.current = now;
  }, [state.terminals]);
  return null;
}
