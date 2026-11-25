// The phone app's system bars (mobile/, Android). Its page runs under the status bar and
// navigation bar, and the WebView does not report their size through env(safe-area-inset-*), so
// the app hands it over (SystemBars.kt) and the page keeps clear of them through --safe-*
// (global.css). The keyboard is not one of them: it shrinks the WebView, as in a phone browser.
// The bar icons follow the page: dark icons on a light theme, light on a dark one.

interface SystemBars {
  /** `{"top":…,"right":…,"bottom":…,"left":…}` in CSS pixels. */
  insets(): string;
  setLightBackground(light: boolean): void;
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

function applyInsets(bars: SystemBars) {
  let insets: Record<string, unknown>;
  try { insets = JSON.parse(bars.insets()); } catch { return; }
  const style = document.documentElement.style;
  for (const side of SIDES) {
    const value = Number(insets[side]);
    if (Number.isFinite(value) && value >= 0) style.setProperty(`--safe-${side}`, `${value}px`);
  }
}

/** Relative luminance of a computed `rgb(…)` color, or null when it cannot be read. */
export function luminance(color: string): number | null {
  const parts = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!parts || parts.length < 3 || parts.some(n => !Number.isFinite(n))) return null;
  const [r, g, b] = parts.map(n => { const c = n / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function followSystemBars() {
  const bars = (window as unknown as { CoffeeSystemBars?: SystemBars }).CoffeeSystemBars;
  if (!bars) return;
  applyInsets(bars);
  window.addEventListener('coffee-system-bars', () => applyInsets(bars));

  let light: boolean | null = null;
  let queued = false;
  const update = () => {
    queued = false;
    const value = luminance(getComputedStyle(document.body).backgroundColor);
    if (value === null) return;
    const next = value > 0.5;
    if (next !== light) { light = next; bars.setLightBackground(next); }
  };
  // Read again once a theme's background transition has settled; a burst of changes reads once.
  let settle = 0;
  const schedule = () => {
    if (!queued) { queued = true; requestAnimationFrame(update); }
    clearTimeout(settle);
    settle = window.setTimeout(update, 500);
  };
  // Theme, light/dark and layout change the page background. Not `style`: the UI writes layout
  // variables there constantly (the composer dock while it is dragged).
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-mode', 'data-layout'] });
  if (document.body) schedule(); else window.addEventListener('DOMContentLoaded', schedule, { once: true });
}
