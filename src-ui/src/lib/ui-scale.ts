import { useSyncExternalStore } from 'react';
import { IS_MACOS } from './platform';

const STORAGE_KEY = 'cc-ui-scale';
export const UI_SCALE_CHANGED = 'cc-ui-scale-changed';
let snapshot = { percent: 100, requestedPercent: null as number | null, pending: false, failed: false };
const listeners = new Set<() => void>();
let applying: Promise<void> | undefined;
let queued: { percent: number; persist: boolean } | undefined;

function publish(update: Partial<typeof snapshot>) {
  snapshot = { ...snapshot, ...update };
  listeners.forEach(listener => listener());
}

function savedScale(): number {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isInteger(value) && value >= 70 && value <= 150 && value % 10 === 0) return value;
  } catch { /* Unavailable storage must not prevent startup. */ }
  return 100;
}

export function setUiScale(percent: number, persist = true): Promise<void> {
  if (!Number.isFinite(percent)) return Promise.resolve();
  percent = Math.max(70, Math.min(150, Math.round(percent / 10) * 10));
  queued = { percent, persist };
  publish({ requestedPercent: percent, pending: true, failed: false });
  applying ??= (async () => {
    while (queued) {
      const request = queued;
      queued = undefined;
      try {
        if ('__TAURI_INTERNALS__' in window) {
          const { getCurrentWebview } = await import('@tauri-apps/api/webview');
          await getCurrentWebview().setZoom(request.percent / 100);
        } else {
          await Promise.resolve();
        }
        publish({ percent: request.percent, failed: false });
        // CSS reads this to keep the macOS titlebar at 100% beside the native traffic lights.
        document.documentElement.style.setProperty('--ui-scale', String(request.percent / 100));
        window.dispatchEvent(new Event(UI_SCALE_CHANGED));
        // Rapid pointer movement replaces the queued value; don't replay or save stale steps.
        if (request.persist && !queued) localStorage.setItem(STORAGE_KEY, String(request.percent));
      } catch {
        publish({ failed: true });
      }
    }
    publish({ requestedPercent: null, pending: false });
  })().finally(() => { applying = undefined; });
  return applying;
}

/** CSS px per screen-space px inside the titlebar (counter-zoomed on macOS). */
export function titlebarPxPerClientPx(): number {
  return IS_MACOS ? snapshot.percent / 100 : 1;
}

export function initializeUiScale(): Promise<void> {
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY || event.key === null) void setUiScale(savedScale(), false);
  });
  return setUiScale(savedScale(), false);
}

export function useUiScale() {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => snapshot);
}
