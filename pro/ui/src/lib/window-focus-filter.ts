// Filters spurious blur→focus pairs caused by Tauri's `start_dragging` on
// Windows. When the OS enters its modal sizing/moving loop, focus briefly
// leaves the WebView and snaps back ~5ms later — firing a blur immediately
// followed by a focus. Naive listeners then re-run "user came back" logic
// (toggling background mode, rescanning installed CLIs) on every drag.
// Linux compositors don't generate this spurious pair, which is why the bug
// is Windows-only.
//
// Strategy: make every blur tentative for SETTLE_MS. If a focus arrives
// within that window, the blur is cancelled and no listeners fire. Real
// alt-tabs always take longer than SETTLE_MS, so they pass through.
// SETTLE_MS doubles as the worst-case delay before a real backgrounding
// is observed — 100 ms is invisible to the user but >>20× the spurious gap.

const SETTLE_MS = 100;

type Fn = () => void;
const fgListeners = new Set<Fn>();
const bgListeners = new Set<Fn>();

let pendingBlurTimer: ReturnType<typeof setTimeout> | null = null;
let state: 'foreground' | 'background' = 'foreground';
let installed = false;

function fireForeground() { for (const fn of fgListeners) fn(); }
function fireBackground() { for (const fn of bgListeners) fn(); }

function ensureInstalled() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('blur', () => {
    if (pendingBlurTimer) clearTimeout(pendingBlurTimer);
    pendingBlurTimer = setTimeout(() => {
      pendingBlurTimer = null;
      if (state === 'foreground') {
        state = 'background';
        fireBackground();
      }
    }, SETTLE_MS);
  });
  window.addEventListener('focus', () => {
    if (pendingBlurTimer) {
      // Spurious blur+focus pair — cancel without firing either side.
      clearTimeout(pendingBlurTimer);
      pendingBlurTimer = null;
      return;
    }
    if (state === 'background') {
      state = 'foreground';
      fireForeground();
    }
  });
}

export function onWindowForeground(fn: Fn): () => void {
  ensureInstalled();
  fgListeners.add(fn);
  return () => { fgListeners.delete(fn); };
}

export function onWindowBackground(fn: Fn): () => void {
  ensureInstalled();
  bgListeners.add(fn);
  return () => { bgListeners.delete(fn); };
}
