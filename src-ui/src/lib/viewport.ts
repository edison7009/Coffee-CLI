// Width classes shared by every layout rule, and whether the UI runs as a web page.
//
// One source of truth: `initViewport()` writes the current class to
// `<html data-width="xs|s|m|l">`, and stylesheets select on that attribute
// instead of repeating pixel media queries.
//
//   xs  < 600        phone, portrait
//   s   600 – 899    tablet portrait, foldable
//   m   900 – 1199   default desktop window, tablet landscape
//   l   ≥ 1200       large desktop window
import { isTauri } from '../tauri';
import { REMOTE } from '../remote/bridge';

export type WidthClass = 'xs' | 's' | 'm' | 'l';
export const BREAKPOINTS = { s: 600, m: 900, l: 1200 } as const;

/** Not inside the desktop app's own window: a browser, or the remote UI on a phone. */
export const IS_WEB = !isTauri || REMOTE;

export function widthClassFor(width: number): WidthClass {
  return width >= BREAKPOINTS.l ? 'l' : width >= BREAKPOINTS.m ? 'm' : width >= BREAKPOINTS.s ? 's' : 'xs';
}

let current: WidthClass = typeof window === 'undefined' ? 'l' : widthClassFor(window.innerWidth);

// Evaluate the queries fresh, so the class always agrees with the CSS: inside
// a change event `innerWidth` can still hold the old width, and a long-lived
// MediaQueryList can keep a stale `matches` under device emulation.
const matches = (px: number) => window.matchMedia(`(min-width: ${px}px)`).matches;
function measure(): WidthClass {
  return matches(BREAKPOINTS.l) ? 'l' : matches(BREAKPOINTS.m) ? 'm' : matches(BREAKPOINTS.s) ? 's' : 'xs';
}

function update() {
  const next = measure();
  if (next === current) return;
  current = next;
  document.documentElement.dataset.width = next;
}

let started = false;
/** Call once before the first render. */
export function initViewport() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const root = document.documentElement;
  current = measure();
  root.dataset.width = current;
  if (IS_WEB) root.classList.add('is-web');
  // Boundary queries fire only when a class changes; `resize` is a fallback for
  // engines that skip them (update() is a no-op while the class stays the same).
  for (const px of Object.values(BREAKPOINTS)) window.matchMedia(`(min-width: ${px}px)`).addEventListener('change', update);
  window.addEventListener('resize', update);
}
