// use-data-attr.ts — Tiny hook that subscribes a component to changes of
// a single attribute on `document.documentElement` (the harness `<html>`
// where Coffee CLI parks `data-theme` / `data-mode` / `data-shape` per App.tsx).
// MutationObserver-based so any code path that flips the attribute (theme
// switcher, settings dialog, system-color watcher) re-renders us cleanly
// without manual broadcast plumbing.

import { useCallback, useSyncExternalStore } from 'react';

export function useDataAttr(name: string): string | null {
  const subscribe = useCallback((onStoreChange: () => void) => {
    if (typeof document === 'undefined') return () => undefined;
    const el = document.documentElement;
    const obs = new MutationObserver(onStoreChange);
    obs.observe(el, { attributes: true, attributeFilter: [name] });
    return () => obs.disconnect();
  }, [name]);
  const getSnapshot = useCallback(
    () => typeof document === 'undefined' ? null : document.documentElement.getAttribute(name),
    [name],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
