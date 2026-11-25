// OpenCode's wordmark and its interactive burst, ported from the OpenCode 1.x TUI logo
// (`packages/tui/src/component/logo.tsx`). The terminal draws the mark with block characters in
// cells two "pixels" tall; every formula below works in those cell coordinates unchanged, and the
// renderer paints each cell as a top and a bottom half. Press and hold charges a glow that traces the
// pressed letter; releasing sends a ring through the whole mark.

export type Rgb = [number, number, number];
export interface LogoPalette { muted: Rgb; text: Rgb; primary: Rgb; background: Rgb }

export const LOGO = {
  left: ['                   ', '█▀▀█ █▀▀█ █▀▀█ █▀▀▄', '█__█ █__█ █^^^ █__█', '▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀~~▀'],
  right: ['             ▄     ', '█▀▀▀ █▀▀█ █▀▀█ █▀▀█', '█___ █__█ █__█ █^^^', '▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀'],
};

// Shadow markers: _ = full shadow cell; ^ = letter top, shadow bottom; ~ = shadow top only; , = shadow bottom only.
const GAP = 1;
const WIDTH = 0.76;
const GAIN = 2.3;
const FLASH = 2.15;
const TRAIL = 0.28;
const SWELL = 0.24;
const WIDE = 1.85;
const DRIFT = 1.45;
const EXPAND = 1.62;
export const LIFE = 1020;
export const CHARGE = 3000;
const HOLD = 90;
const SINK = 40;
const ARC = 2.2;
const FORK = 1.2;
const DIM = 1.04;
const KICK = 0.86;
const LAG = 60;
const SUCK = 0.34;
const SHIMMER_IN = 60;
const SHIMMER_OUT = 2.8;
const TRACE = 0.033;
const TAIL = 1.8;
const TRACE_IN = 200;
export const GLOW_OUT = 1600;
const PEAK: Rgb = [1, 1, 1];

interface Ring { x: number; y: number; at: number; force: number; kick: number }
export interface Hold { x: number; y: number; at: number; glyph: number | undefined }
interface Release { x: number; y: number; at: number; glyph: number | undefined; level: number; rise: number }
interface Glow { glyph: number; at: number; force: number }
interface Frame { t: number; list: Ring[]; hold: Hold | undefined; release: Release | undefined; glow: Glow | undefined; spark: number }
export interface BurstState { rings: Ring[]; hold?: Hold; release?: Release; glow?: Glow }

const NEAR = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const;
interface Trace { glyph: number; i: number; l: number }

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp(t);
function ease(t: number) { const p = clamp(t); return p * p * (3 - 2 * p); }
function push(t: number) { const p = clamp(t); return ease(p * p); }
function ramp(t: number, start: number, end: number) {
  if (end <= start) return ease(t >= end ? 1 : 0);
  return ease((t - start) / (end - start));
}
export function tint(base: Rgb, overlay: Rgb, alpha: number): Rgb {
  return [base[0] + (overlay[0] - base[0]) * alpha, base[1] + (overlay[1] - base[1]) * alpha, base[2] + (overlay[2] - base[2]) * alpha];
}
function glow(base: Rgb, palette: LogoPalette, n: number): Rgb {
  const mid = tint(base, palette.primary, 0.84);
  const top = tint(palette.primary, PEAK, 0.96);
  if (n <= 1) return tint(base, mid, Math.min(1, Math.sqrt(Math.max(0, n)) * 1.14));
  return tint(mid, top, Math.min(1, 1 - Math.exp(-2.4 * (n - 1))));
}
export function shade(base: Rgb, palette: LogoPalette, n: number): Rgb {
  if (n >= 0) return glow(base, palette, n);
  return tint(base, palette.background, Math.min(0.82, -n * 0.64));
}
const ghost = (n: number, scale: number) => n < 0 ? n : n * scale;
function noise(x: number, y: number, t: number) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + t * 0.043) * 43758.5453;
  return n - Math.floor(n);
}
const lit = (char: string) => char !== ' ' && char !== '_' && char !== '~' && char !== ',';
const key = (x: number, y: number) => `${x},${y}`;

/** Orders a glyph's cells into a path that walks its outline, so the trace runs around the letter. */
function route(list: { x: number; y: number }[]) {
  const left = new Map(list.map(item => [key(item.x, item.y), item]));
  const path: { x: number; y: number }[] = [];
  let cur: { x: number; y: number } | undefined = [...left.values()].sort((a, b) => a.y - b.y || a.x - b.x)[0];
  let dir = { x: 1, y: 0 };
  while (cur) {
    const at: { x: number; y: number } = cur;
    path.push(at);
    left.delete(key(at.x, at.y));
    if (!left.size) return path;
    const next = NEAR.map(([dx, dy]) => left.get(key(at.x + dx, at.y + dy)))
      .filter((item): item is { x: number; y: number } => !!item)
      .sort((a, b) => {
        const ax = a.x - at.x, ay = a.y - at.y, bx = b.x - at.x, by = b.y - at.y;
        const adot = ax * dir.x + ay * dir.y, bdot = bx * dir.x + by * dir.y;
        if (adot !== bdot) return bdot - adot;
        return Math.abs(ax) + Math.abs(ay) - (Math.abs(bx) + Math.abs(by));
      })[0];
    if (!next) {
      cur = [...left.values()].sort((a, b) => ((a.x - at.x) ** 2 + (a.y - at.y) ** 2) - ((b.x - at.x) ** 2 + (b.y - at.y) ** 2))[0];
      dir = { x: 1, y: 0 };
      continue;
    }
    dir = { x: next.x - at.x, y: next.y - at.y };
    cur = next;
  }
  return path;
}

/** Splits the mark into connected glyphs (letters), each with an outline path and a center. */
function mapGlyphs(full: string[]) {
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < full.length; y++) for (let x = 0; x < full[y].length; x++) if (lit(full[y][x])) cells.push({ x, y });
  const all = new Map(cells.map(item => [key(item.x, item.y), item]));
  const seen = new Set<string>(), glyph = new Map<string, number>(), trace = new Map<string, Trace>(), center = new Map<number, { x: number; y: number }>();
  let id = 0;
  for (const item of cells) {
    const start = key(item.x, item.y);
    if (seen.has(start)) continue;
    const stack = [item], part: { x: number; y: number }[] = [];
    seen.add(start);
    while (stack.length) {
      const cur = stack.pop()!;
      part.push(cur);
      glyph.set(key(cur.x, cur.y), id);
      for (const [dx, dy] of NEAR) {
        const next = all.get(key(cur.x + dx, cur.y + dy));
        if (!next || seen.has(key(next.x, next.y))) continue;
        seen.add(key(next.x, next.y));
        stack.push(next);
      }
    }
    route(part).forEach((cell, i, path) => trace.set(key(cell.x, cell.y), { glyph: id, i, l: path.length }));
    center.set(id, { x: part.reduce((sum, c) => sum + c.x, 0) / part.length + 0.5, y: (part.reduce((sum, c) => sum + c.y, 0) / part.length) * 2 + 1 });
    id++;
  }
  return { glyph, trace, center };
}

export const LEFT = LOGO.left[0].length;
export const FULL = LOGO.left.map((line, i) => line + ' '.repeat(GAP) + LOGO.right[i]);
const SPAN = Math.hypot(FULL[0].length, FULL.length * 2) * 0.94;
const MAP = mapGlyphs(FULL);

function shimmer(x: number, y: number, frame: Frame) {
  return frame.list.reduce((best, item) => {
    const age = frame.t - item.at;
    if (age < SHIMMER_IN || age > LIFE) return best;
    const dist = Math.hypot(x + 0.5 - item.x, y * 2 + 1 - item.y);
    const p = age / LIFE;
    const lag = SPAN * (1 - (1 - p) ** EXPAND) - dist;
    if (lag < 0.18 || lag > SHIMMER_OUT) return best;
    const band = Math.exp(-(((lag - 1.05) / 0.68) ** 2));
    const wobble = 0.5 + 0.5 * Math.sin(frame.t * 0.035 + x * 0.9 + y * 1.7);
    return Math.max(best, band * wobble * (1 - p) ** 1.45);
  }, 0);
}
function remain(x: number, y: number, item: Release, t: number) {
  const age = t - item.at;
  if (age < 0 || age > LIFE) return 0;
  const p = age / LIFE;
  const dist = Math.hypot(x + 0.5 - item.x - 0.5, y * 2 + 1 - item.y * 2 - 1);
  const r = SPAN * (1 - (1 - p) ** EXPAND);
  if (dist > r) return 1;
  return clamp((r - dist) / 1.35 < 1 ? 1 - (r - dist) / 1.35 : 0);
}
function wave(x: number, y: number, frame: Frame, live: boolean) {
  return frame.list.reduce((sum, item) => {
    const age = frame.t - item.at;
    if (age < 0 || age > LIFE) return sum;
    const p = age / LIFE;
    const dist = Math.hypot(x + 0.5 - item.x, y * 2 + 1 - item.y);
    const r = SPAN * (1 - (1 - p) ** EXPAND);
    const fade = (1 - p) ** 1.32;
    const j = 1.02 + noise(x + item.x * 0.7, y + item.y * 0.7, item.at * 0.002 + age * 0.06) * 0.52;
    const edge = Math.exp(-(((dist - r) / WIDTH) ** 2)) * GAIN * fade * item.force * j;
    const swell = Math.exp(-(((dist - Math.max(0, r - DRIFT)) / WIDE) ** 2)) * SWELL * fade * item.force;
    const trail = dist < r ? Math.exp(-(r - dist) / 2.4) * TRAIL * fade * item.force * lerp(0.92, 1.22, j) : 0;
    const flash = Math.exp(-(dist * dist) / 3.2) * FLASH * item.force * Math.max(0, 1 - age / 140) * lerp(0.95, 1.18, j);
    const kick = Math.exp(-(dist * dist) / 2) * item.kick * Math.max(0, 1 - age / 100);
    const suck = Math.exp(-(((dist - 1.25) / 0.75) ** 2)) * item.kick * SUCK * Math.max(0, 1 - age / 110);
    const wake = live && dist < r ? Math.exp(-(r - dist) / 1.25) * 0.32 * fade : 0;
    return sum + edge + swell + trail + flash + wake - kick - suck;
  }, 0);
}
function field(x: number, y: number, frame: Frame) {
  const held = frame.hold, rest = frame.release, item = held ?? rest;
  if (!item) return 0;
  const rise = held ? ramp(frame.t - held.at, HOLD, CHARGE) : rest!.rise;
  const level = held ? push(rise) : rest!.level;
  const body = rise, storm = level * level;
  const sink = held ? ramp(frame.t - held.at, SINK, CHARGE) : rest!.rise;
  const dx = x + 0.5 - item.x - 0.5, dy = y * 2 + 1 - item.y * 2 - 1;
  const dist = Math.hypot(dx, dy), angle = Math.atan2(dy, dx);
  const spin = frame.t * lerp(0.008, 0.018, storm);
  const dim = lerp(0, DIM, sink) * lerp(0.99, 1.01, 0.5 + 0.5 * Math.sin(frame.t * 0.014));
  const core = Math.exp(-(dist * dist) / Math.max(0.22, lerp(0.22, 3.2, body))) * lerp(0.42, 2.45, body);
  const shell = Math.exp(-(((dist - lerp(0.16, 2.05, body)) / Math.max(0.18, lerp(0.18, 0.82, body))) ** 2)) * lerp(0.1, 0.95, body);
  const ember = Math.exp(-(((dist - lerp(0.45, 2.65, body)) / Math.max(0.14, lerp(0.14, 0.62, body))) ** 2)) * lerp(0.02, 0.78, body);
  const arc = Math.max(0, Math.cos(angle * 3 - spin + frame.spark * 2.2)) ** 8;
  const seam = Math.max(0, Math.cos(angle * 5 + spin * 1.55)) ** 12;
  const ring = Math.exp(-(((dist - lerp(1.05, 3, level)) / 0.48) ** 2)) * arc * lerp(0.03, 0.5 + ARC, storm);
  const fork = Math.exp(-(((dist - (1.55 + storm * 2.1)) / 0.36) ** 2)) * seam * storm * FORK;
  const spark = Math.max(0, noise(x, y, frame.t) - lerp(0.94, 0.66, storm)) * lerp(0, 5.4, storm);
  const glitch = spark * Math.exp(-dist / Math.max(1.2, 3.1 - storm));
  const crack = Math.max(0, Math.cos((dx - dy) * 1.6 + spin * 2.1)) ** 18;
  const lash = crack * Math.exp(-(((dist - (1.95 + storm * 2)) / 0.28) ** 2)) * storm * 1.1;
  const flicker = Math.max(0, noise(item.x * 3.1, item.y * 2.7, frame.t * 1.7) - 0.72) * Math.exp(-(dist * dist) / 0.15) * lerp(0.08, 0.42, body);
  const fade = frame.release && !frame.hold ? remain(x, y, frame.release, frame.t) : 1;
  return (core + shell + ember + ring + fork + glitch + lash + flicker - dim) * fade;
}
function pick(x: number, y: number, frame: Frame) {
  const held = frame.hold, rest = frame.release, item = held ?? rest;
  if (!item) return 0;
  const rise = held ? ramp(frame.t - held.at, HOLD, CHARGE) : rest!.rise;
  const dist = Math.hypot(x + 0.5 - item.x - 0.5, y * 2 + 1 - item.y * 2 - 1);
  const fade = frame.release && !frame.hold ? remain(x, y, frame.release, frame.t) : 1;
  return Math.exp(-(dist * dist) / 1.7) * lerp(0.2, 0.96, rise) * fade;
}
/** The glyph under a cell, or one touching it (shadow cells belong to the nearest letter). */
export function selectGlyph(x: number, y: number) {
  const direct = MAP.glyph.get(key(x, y));
  if (direct !== undefined) return direct;
  return NEAR.map(([dx, dy]) => MAP.glyph.get(key(x + dx, y + dy))).find((item): item is number => item !== undefined);
}
function trace(x: number, y: number, frame: Frame) {
  const held = frame.hold, rest = frame.release, item = held ?? rest;
  if (!item || item.glyph === undefined) return 0;
  const step = MAP.trace.get(key(x, y));
  if (!step || step.glyph !== item.glyph || step.l < 2) return 0;
  const age = frame.t - item.at;
  const rise = held ? ramp(age, HOLD, CHARGE) : rest!.rise;
  const appear = held ? ramp(age, 0, TRACE_IN) : 1;
  const head = (age * lerp(TRACE * 0.48, TRACE * 0.88, rise)) % step.l;
  const dist = Math.min(Math.abs(step.i - head), step.l - Math.abs(step.i - head));
  const tail = (head - TAIL + step.l) % step.l;
  const lag = Math.min(Math.abs(step.i - tail), step.l - Math.abs(step.i - tail));
  const fade = frame.release && !frame.hold ? remain(x, y, frame.release, frame.t) : 1;
  const core = Math.exp(-((dist / 1.05) ** 2)) * lerp(0.8, 2.35, rise);
  const halo = Math.exp(-((dist / 1.85) ** 2)) * lerp(0.08, 0.34, rise);
  const trail = Math.exp(-((lag / 1.45) ** 2)) * lerp(0.04, 0.42, rise);
  return (core + halo + trail) * appear * fade;
}
function bloom(x: number, y: number, frame: Frame) {
  const item = frame.glow;
  if (!item || MAP.glyph.get(key(x, y)) !== item.glyph) return 0;
  const age = frame.t - item.at;
  if (age < 0 || age > GLOW_OUT) return 0;
  const p = age / GLOW_OUT;
  const center = MAP.center.get(item.glyph)!;
  const bias = Math.exp(-((Math.hypot(x + 0.5 - center.x, y * 2 + 1 - center.y) / 2.8) ** 2));
  return lerp(item.force, item.force * 0.18, p) * lerp(0.72, 1.1, bias) * (1 - p) ** 2;
}

/** Whether a cell is part of the mark, shadows included. */
export const hit = (x: number, y: number) => { const char = FULL[y]?.[x]; return char !== undefined && char !== ' '; };

export function press(state: BurstState, x: number, y: number, t: number): BurstState {
  const next = state.hold ? burst(state, t) : { ...state, release: undefined };
  return { ...next, hold: { x, y, at: t, glyph: selectGlyph(x, y) } };
}
/** Releases the charge: a ring sized by how long it was held, and a flash on the held letter. */
export function burst(state: BurstState, t: number): BurstState {
  const item = state.hold;
  if (!item) return state;
  const rise = ramp(t - item.at, HOLD, CHARGE), level = push(rise);
  return {
    hold: undefined,
    release: { x: item.x, y: item.y, at: t, glyph: item.glyph, level, rise },
    glow: item.glyph !== undefined ? { glyph: item.glyph, at: t, force: lerp(0.18, 1.5, rise * level) } : state.glow,
    rings: [...state.rings, { x: item.x + 0.5, y: item.y * 2 + 1, at: t, force: lerp(0.82, 2.55, level), kick: lerp(0.32, 0.32 + KICK, level) }],
  };
}
/** Advances time: a full charge bursts by itself; finished rings and flashes are dropped. */
export function settle(state: BurstState, t: number): BurstState {
  let next = state.hold && t - state.hold.at >= CHARGE ? burst(state, t) : state;
  const rings = next.rings.filter(item => t - item.at < LIFE);
  next = { ...next, rings, release: rings.length ? next.release : undefined, glow: next.glow && t - next.glow.at < GLOW_OUT ? next.glow : undefined };
  return next;
}
export const animating = (state: BurstState) => !!(state.rings.length || state.hold || state.release || state.glow);

export type CellPaint = { top?: Rgb; bottom?: Rgb };
/** Colors of every cell at time `t`: the top and bottom half of each terminal cell. */
export function paint(state: BurstState, t: number, palette: LogoPalette): CellPaint[][] {
  const frame: Frame = { t, list: state.rings, hold: state.hold, release: state.release, glow: state.glow, spark: state.hold ? noise(state.hold.x, state.hold.y, t) : 0 };
  const dusk: Frame = { ...frame, t: t - LAG, spark: state.hold ? noise(state.hold.x, state.hold.y, t - LAG) : 0 };
  const still = !animating(state);
  return FULL.map((line, y) => Array.from(line).map((char, x): CellPaint => {
    if (char === ' ') return {};
    const ink = x < LEFT ? palette.muted : palette.text;
    const shadow = tint(palette.background, ink, 0.25);
    if (still) {
      if (char === '_') return { top: shadow, bottom: shadow };
      if (char === '^') return { top: ink, bottom: shadow };
      if (char === '~') return { top: shadow };
      if (char === ',') return { bottom: shadow };
      if (char === '▀') return { top: ink };
      if (char === '▄') return { bottom: ink };
      return { top: ink, bottom: ink };
    }
    const h = field(x, y, frame), charLit = lit(char);
    const n = wave(x, y, frame, charLit) + h, s = wave(x, y, dusk, false) + h;
    const p = charLit ? pick(x, y, frame) : 0, e = charLit ? trace(x, y, frame) : 0, b = charLit ? bloom(x, y, frame) : 0;
    const q = shimmer(x, y, frame);
    const letter = shade(ink, palette, n + p + e + b);
    if (char === '_') { const color = shade(shadow, palette, ghost(s, 0.24) + ghost(q, 0.06)); return { top: color, bottom: color }; }
    if (char === '^') return { top: letter, bottom: shade(shadow, palette, ghost(s, 0.18) + ghost(q, 0.05) + ghost(b, 0.08)) };
    if (char === '~') return { top: shade(shadow, palette, ghost(s, 0.22) + ghost(q, 0.05)) };
    if (char === ',') return { bottom: shade(shadow, palette, ghost(s, 0.22) + ghost(q, 0.05)) };
    if (char === '▀') return { top: letter };
    if (char === '▄') return { bottom: letter };
    return { top: letter, bottom: letter };
  }));
}
