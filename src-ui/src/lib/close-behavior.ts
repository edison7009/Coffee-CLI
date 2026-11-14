// What closing the main window does. 'ask' asks when sessions are running and quits at once when none are;
// 'keep' keeps Coffee CLI running in the notification area (Windows), the menu bar (macOS) or minimized (Linux).

import { useSyncExternalStore } from 'react';
import { IS_MACOS, IS_WINDOWS } from './platform';
import type { TerminalSession } from '../store/app-state';

export type CloseBehavior = 'ask' | 'keep' | 'quit';

/** How this platform names keeping Coffee CLI running without a window. */
export const KEEP_RUNNING_LABEL = IS_WINDOWS ? 'app_close.keep_tray' : IS_MACOS ? 'app_close.keep_menubar' : 'app_close.keep_minimize';
const KEY = 'cc-close-behavior';
const listeners = new Set<() => void>();

export function getCloseBehavior(): CloseBehavior {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'keep' || value === 'quit' ? value : 'ask';
  } catch { return 'ask'; }
}

export function setCloseBehavior(value: CloseBehavior) {
  try { if (value === 'ask') localStorage.removeItem(KEY); else localStorage.setItem(KEY, value); } catch { /* the choice lasts this run only */ }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useCloseBehavior(): CloseBehavior {
  return useSyncExternalStore(subscribe, getCloseBehavior, () => 'ask');
}

/** Every tab with a tool started in it; launcher tabs and browser mirrors run nothing here. */
export function runningSessions(terminals: TerminalSession[]): TerminalSession[] {
  return terminals.filter(session => session.tool && !session.mirror);
}
