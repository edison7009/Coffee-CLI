// One app-wide toast: a short note at the top center of the window ("Link
// copied", "Draft from a shared link"). A newer toast replaces the current one.
import { useSyncExternalStore } from 'react';

export interface Toast { id: number; text: string }

let current: Toast | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

export function showToast(text: string, ms = 2200) {
  current = { id: ++seq, text };
  emit();
  clearTimeout(timer);
  timer = setTimeout(() => { current = null; emit(); }, ms);
}

export function useToast(): Toast | null {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
  );
}
