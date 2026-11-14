// What closing the main window does on Windows and Linux (macOS hides it to the Dock).
// 'ask' asks when sessions are running and quits at once when none are.

import { useSyncExternalStore } from 'react';
import type { TerminalSession } from '../store/app-state';

export type CloseBehavior = 'ask' | 'keep' | 'quit';
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
