// explorer-drag.ts — pointer-based drag for left Explorer items.
//
// We can't use HTML5 dragstart for intra-app drags: Tauri v2's WebView2
// drag-drop capture (enabled by default for OS file drops) intercepts the
// dragstart pipeline on Windows, so `draggable={true}` + onDragStart
// silently fails. Mouse events still flow normally, so we run our own
// drag tracker that mimics the same UX: threshold-to-start, ghost element
// following the cursor, drop handed off to routeFileDrop.

import { routeFileDrop, formatPathsForInsert } from './file-drop';

const START_THRESHOLD_PX = 5;

interface DragSession {
  path: string;
  startX: number;
  startY: number;
  started: boolean;
  ghost: HTMLDivElement | null;
}

let active: DragSession | null = null;

function makeGhost(label: string): HTMLDivElement {
  const el = document.createElement('div');
  el.textContent = label;
  el.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'pointer-events:none',
    'z-index:99999',
    'padding:4px 10px',
    'background:var(--bg-1, #2a2a2a)',
    'color:var(--text-1, #e8e8e8)',
    'border:1px solid var(--accent, #6aa)',
    'border-radius:6px',
    'font:12px var(--font, system-ui)',
    'box-shadow:0 4px 12px rgba(0,0,0,0.35)',
    'opacity:0.92',
    'max-width:240px',
    'overflow:hidden',
    'text-overflow:ellipsis',
    'white-space:nowrap',
    'transform:translate(8px, 8px)',
  ].join(';');
  document.body.appendChild(el);
  return el;
}

function moveGhost(s: DragSession, x: number, y: number) {
  if (s.ghost) s.ghost.style.transform = `translate(${x + 8}px, ${y + 8}px)`;
}

function cleanup() {
  if (!active) return;
  active.ghost?.remove();
  active = null;
  document.body.style.cursor = '';
  document.removeEventListener('mousemove', onMove, true);
  document.removeEventListener('mouseup', onUp, true);
  document.removeEventListener('keydown', onKey, true);
}

function onMove(e: MouseEvent) {
  const s = active;
  if (!s) return;
  if (!s.started) {
    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;
    if (dx * dx + dy * dy < START_THRESHOLD_PX * START_THRESHOLD_PX) return;
    s.started = true;
    const label = basename(s.path);
    s.ghost = makeGhost(label);
    document.body.style.cursor = 'copy';
  }
  moveGhost(s, e.clientX, e.clientY);
}

function onUp(e: MouseEvent) {
  const s = active;
  if (!s) return;
  if (s.started) {
    routeFileDrop([s.path], { x: e.clientX, y: e.clientY });
    // Swallow the click that fires after a same-target mousedown→mouseup
    // pair, so a drag that ends back on the original folder header doesn't
    // also toggle it open/closed. One-shot, capture-phase, with a tick
    // safety net if the click never lands.
    const swallow = (ce: MouseEvent) => {
      ce.stopImmediatePropagation();
      ce.preventDefault();
      document.removeEventListener('click', swallow, true);
    };
    document.addEventListener('click', swallow, true);
    setTimeout(() => document.removeEventListener('click', swallow, true), 50);
  }
  cleanup();
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') cleanup();
}

function basename(p: string): string {
  const m = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return m[m.length - 1] || p;
}

/** Begin a drag from an Explorer node. Call from onMouseDown — left button
 *  only, not while renaming. The session activates only after the cursor
 *  moves past START_THRESHOLD_PX, so a plain click stays a click. */
export function beginExplorerDrag(path: string, e: React.MouseEvent) {
  if (e.button !== 0) return;
  cleanup();
  active = { path, startX: e.clientX, startY: e.clientY, started: false, ghost: null };
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseup', onUp, true);
  document.addEventListener('keydown', onKey, true);
}

// Re-export for convenience so call sites don't need a second import.
export { formatPathsForInsert };
