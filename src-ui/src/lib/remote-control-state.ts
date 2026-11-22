import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { commands, type WindowControlState } from '../tauri';

/** What a tab's remote control chip shows (src/window_control.rs); null while unknown or for other tabs. */
export function useRemoteControlState(sessionId: string, active: boolean): [WindowControlState | null, (state: WindowControlState) => void] {
  // Kept with the tab it belongs to, so switching tabs never shows the previous tab's choice.
  const [stored, setStored] = useState<{ session: string; value: WindowControlState } | null>(null);
  useEffect(() => {
    if (!active) return;
    let current = true;
    const refresh = () => { void commands.windowControlState(sessionId).then(value => { if (current) setStored({ session: sessionId, value }); }, () => {}); };
    refresh();
    // A window opening or closing changes the choices, and a closed window's pick is dropped; the
    // setting or this tab's window changing (src/window_control.rs) changes what the chip shows.
    const stops = ['remote-windows-changed', 'window-control-changed'].map(event => listen(event, refresh));
    return () => { current = false; for (const stop of stops) void stop.then(unlisten => unlisten()); };
  }, [sessionId, active]);
  const set = useCallback((value: WindowControlState) => setStored({ session: sessionId, value }), [sessionId]);
  return [active && stored?.session === sessionId ? stored.value : null, set];
}
