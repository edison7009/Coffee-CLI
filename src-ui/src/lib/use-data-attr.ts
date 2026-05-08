// use-data-attr.ts — Tiny hook that subscribes a component to changes of
// a single attribute on `document.documentElement` (the harness `<html>`
// where Coffee CLI parks `data-theme` and `data-shape` per App.tsx).
// MutationObserver-based so any code path that flips the attribute (theme
// switcher, settings dialog, system-color watcher) re-renders us cleanly
// without manual broadcast plumbing.

import { useEffect, useState } from 'react';

export function useDataAttr(name: string): string | null {
  const [val, setVal] = useState<string | null>(() =>
    typeof document === 'undefined' ? null : document.documentElement.getAttribute(name),
  );
  useEffect(() => {
    const el = document.documentElement;
    setVal(el.getAttribute(name));
    const obs = new MutationObserver(() => setVal(el.getAttribute(name)));
    obs.observe(el, { attributes: true, attributeFilter: [name] });
    return () => obs.disconnect();
  }, [name]);
  return val;
}
