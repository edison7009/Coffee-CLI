import { useEffect, useRef } from 'react';
import { FULL, animating, burst, hit, paint, press, settle, type BurstState, type LogoPalette, type Rgb } from '../../lib/opencode-logo';
import './OpenCodeConversation.css';

// One terminal cell: OpenCode's mark is drawn in cells twice as tall as wide.
const CELL_W = 7, CELL_H = 14;
const COLS = FULL[0].length, ROWS = FULL.length;
// Solid letter cells the showcase presses, so every burst starts inside a letter.
const LETTER_CELLS = FULL.flatMap((line, y) => Array.from(line).flatMap((char, x) => char === '█' ? [{ x, y }] : []));
const between = (min: number, max: number) => min + Math.random() * (max - min);

let probe: CanvasRenderingContext2D | null | undefined;
/** Resolves any CSS color (variables, color-mix, named colors) to RGB through the canvas. */
function rgb(css: string, fallback: Rgb): Rgb {
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!probe || !css.trim()) return fallback;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000'; probe.fillStyle = css.trim();
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return a < 128 ? fallback : [r / 255, g / 255, b / 255];
}
function palette(element: HTMLElement): LogoPalette {
  const style = getComputedStyle(element);
  const light = document.documentElement.dataset.mode === 'light' || document.body.dataset.mode === 'light';
  const background = rgb(style.getPropertyValue('--bg-terminal'), light ? [1, 1, 1] : [0.08, 0.08, 0.08]);
  const text = rgb(style.getPropertyValue('--text-1'), light ? [0.1, 0.1, 0.1] : [0.93, 0.93, 0.93]);
  return { text, muted: rgb(style.getPropertyValue('--text-3'), text), primary: rgb(style.getPropertyValue('--accent'), text), background };
}
const css = ([r, g, b]: Rgb) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;

/** OpenCode's wordmark on the welcome screen. It shows its burst by itself: a letter charges, then releases a ring,
 * with a pause between. Pressing and holding a letter plays it by hand; the showcase resumes afterwards. */
export function OpenCodeWelcomeLogo({ isActive, autoplay = true }: { isActive: boolean; autoplay?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const automatic = useRef(false);
  const live = useRef({ isActive, autoplay });
  live.current = { isActive, autoplay };
  const state = useRef<BurstState>({ rings: [] });
  const frame = useRef(0);
  const colors = useRef<LogoPalette | null>(null);

  const draw = (t = performance.now()) => {
    const node = canvas.current, context = node?.getContext('2d');
    if (!node || !context) return;
    const scale = window.devicePixelRatio || 1;
    if (node.width !== COLS * CELL_W * scale) { node.width = COLS * CELL_W * scale; node.height = ROWS * CELL_H * scale; }
    colors.current ??= palette(node);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, COLS * CELL_W, ROWS * CELL_H);
    paint(state.current, t, colors.current).forEach((line, y) => line.forEach((cell, x) => {
      if (cell.top) { context.fillStyle = css(cell.top); context.fillRect(x * CELL_W, y * CELL_H, CELL_W, CELL_H / 2); }
      if (cell.bottom) { context.fillStyle = css(cell.bottom); context.fillRect(x * CELL_W, y * CELL_H + CELL_H / 2, CELL_W, CELL_H / 2); }
    }));
  };
  const loop = () => {
    const t = performance.now();
    state.current = settle(state.current, t);
    draw(t);
    frame.current = animating(state.current) ? requestAnimationFrame(loop) : 0;
    // Between bursts nothing is drawn; the next one is only a timer.
    if (!frame.current) schedule(between(1800, 3200));
  };
  const start = () => { if (!frame.current) frame.current = requestAnimationFrame(loop); };
  const motion = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const allowed = () => live.current.isActive && live.current.autoplay && !document.hidden && motion();
  const schedule = (delay: number) => {
    clearTimeout(timer.current);
    if (allowed()) timer.current = setTimeout(showcase, delay);
  };
  /** Charges a random letter for a varied time, then releases it. */
  const showcase = () => {
    if (!allowed() || state.current.hold || animating(state.current)) return;
    const { x, y } = LETTER_CELLS[Math.floor(Math.random() * LETTER_CELLS.length)];
    state.current = press(state.current, x, y, performance.now());
    automatic.current = true;
    start();
    timer.current = setTimeout(() => {
      if (!automatic.current || !state.current.hold) return;
      automatic.current = false;
      state.current = burst(state.current, performance.now());
      start();
    }, between(900, 1800));
  };
  /** Hidden, minimized or reduced-motion: stop at once and show the still mark. */
  const rest = () => {
    clearTimeout(timer.current); automatic.current = false;
    cancelAnimationFrame(frame.current); frame.current = 0;
    state.current = { rings: [] };
    draw();
  };

  useEffect(() => {
    draw();
    // Theme and mode switches repaint the still mark in the new colors.
    const repaint = () => { colors.current = null; if (!frame.current) draw(); };
    const observer = new MutationObserver(repaint);
    for (const node of [document.documentElement, document.body]) observer.observe(node, { attributes: true });
    return () => { observer.disconnect(); clearTimeout(timer.current); cancelAnimationFrame(frame.current); frame.current = 0; };
  }, []);
  useEffect(() => {
    if (!isActive || !autoplay) { rest(); return; }
    schedule(700);
    const visibility = () => { if (document.hidden) rest(); else schedule(700); };
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const preference = () => { if (reduced.matches) rest(); else schedule(700); };
    document.addEventListener('visibilitychange', visibility);
    reduced.addEventListener('change', preference);
    return () => { clearTimeout(timer.current); document.removeEventListener('visibilitychange', visibility); reduced.removeEventListener('change', preference); };
  }, [isActive, autoplay]);

  const cell = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: Math.floor((event.clientX - box.left) / (box.width / COLS)), y: Math.floor((event.clientY - box.top) / (box.height / ROWS)) };
  };
  const down = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || !motion()) return;
    const { x, y } = cell(event);
    if (!hit(x, y)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // The person takes over: the showcase waits until their burst has faded.
    clearTimeout(timer.current); automatic.current = false;
    state.current = press(state.current, x, y, performance.now());
    start();
  };
  const up = () => {
    if (!state.current.hold || automatic.current) return;
    state.current = burst(state.current, performance.now());
    start();
  };
  return <span className="opencode-welcome-icon" aria-hidden="true">
    <canvas ref={canvas} className="opencode-welcome-logo" style={{ width: COLS * CELL_W, height: ROWS * CELL_H }} onPointerDown={down} onPointerMove={event => { const { x, y } = cell(event); event.currentTarget.style.cursor = hit(x, y) ? 'pointer' : ''; }} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} />
  </span>;
}
