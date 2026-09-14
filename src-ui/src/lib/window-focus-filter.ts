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

// rAF-starvation watchdog: blur/focus only fires on KEYBOARD-focus changes.
// A window that stays focused-but-fully-occluded (covered by another app,
// then revealed by closing/minimizing the covering window) never blurs — yet
// Chromium's occlusion tracking pauses its rAF the whole time, and WebView2
// may reclaim canvas backing stores while occluded. On reveal there is no
// focus event, so a stale/ghosted frame persists until the user clicks in.
// Detect the reveal by the gap itself: a frame arriving > RAF_GAP_MS after
// the previous one means the compositor starved us and every canvas is
// suspect. Also covers OS sleep/resume. Long main-thread jank can false-fire
// — subscribers must treat this as an idempotent "repaint if cheap" hint.
const RAF_GAP_MS = 1000;

type Fn = () => void;
const fgListeners = new Set<Fn>();
const bgListeners = new Set<Fn>();
const resumeListeners = new Set<Fn>();

let pendingBlurTimer: ReturnType<typeof setTimeout> | null = null;
let state: 'foreground' | 'background' = 'foreground';
let installed = false;
let lastFrameAt = 0;

function rafWatchdog(t: number) {
  if (lastFrameAt && t - lastFrameAt > RAF_GAP_MS) {
    for (const fn of resumeListeners) fn();
  }
  lastFrameAt = t;
  requestAnimationFrame(rafWatchdog);
}

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
  requestAnimationFrame(rafWatchdog);
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

// Fires when rAF resumes after a long starvation gap (occluded-window reveal
// without a focus change, OS sleep/resume). Distinct from onWindowForeground:
// foreground subscribers do "user came back" work (rescanning CLIs, polling),
// which must NOT run on a mere compositor resume.
export function onRenderResume(fn: Fn): () => void {
  ensureInstalled();
  resumeListeners.add(fn);
  return () => { resumeListeners.delete(fn); };
}
