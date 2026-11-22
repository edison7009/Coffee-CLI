// In a window controlling another computer (bridge.ts `CONTROL`), Tauri calls go to that computer.
// What must stay on this computer — answering this computer's own requests to the window — uses
// this computer's IPC object directly, as bridge.ts does for its connection. Like bridge.ts, this file
// is left out of vite.config.ts's routing, which would otherwise hand it the other computer's IPC.
import { CONTROL } from './bridge';

type LocalIpc = { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>; transformCallback(callback: (event: unknown) => void, once?: boolean): number };
const LOCAL = CONTROL ? (window.__TAURI_INTERNALS__ as unknown as LocalIpc) : null;

export function localInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return LOCAL ? (LOCAL.invoke(cmd, args) as Promise<T>) : Promise.reject(new Error('not a control window'));
}

/** Listen to an event this computer sends to the window. Returns the unlisten function. */
export function onLocalEvent<T>(event: string, handler: (payload: T) => void): () => void {
  if (!LOCAL) return () => {};
  let eventId: number | null = null, stopped = false;
  const unlisten = (id: number) => { void localInvoke('plugin:event|unlisten', { event, eventId: id }).catch(() => {}); };
  const callback = LOCAL.transformCallback(message => { if (!stopped) handler((message as { payload: T }).payload); });
  void localInvoke<number>('plugin:event|listen', { event, target: { kind: 'Any' }, handler: callback })
    .then(id => { eventId = id; if (stopped) unlisten(id); })
    .catch(error => console.error(`[local event ${event}]`, error));
  return () => { stopped = true; if (eventId !== null) unlisten(eventId); };
}
