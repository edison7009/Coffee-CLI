import { useEffect, useRef, useState } from 'react';
import CLAUDE_SVG from '../../icons-inline/claude.svg?raw';
import CODEX_SVG from '../../icons-inline/codex.svg?raw';
import DSH_SVG from '../../icons-inline/deepseek-color.svg?raw';
import OPENCODE_SVG from '../../icons-inline/opencode-mark.svg?raw';
import PI_SVG from '../../icons-inline/pi.svg?raw';
import './ToolSwarm.css';

/** The welcome animation every conversation tool shares, reproduced from the Playmand README header
 *  (Playmand/repo/demos/src/bin/icons.rs, recorded with Bevy): a 3D star nebula rolls in place, spirals
 *  into the tool's icon, holds, then releases into the next nebula form (star ball, globe, ringed planet,
 *  torus). Nothing flies in from the edges.
 *
 *  Everything is measured in the demo's own units and scaled to the canvas, so proportions match:
 *  the icon fits a 300-unit box, the nebula has a 125-unit radius, stars are round dots of radius
 *  1.6, 2.1 or 2.7, and there are 1,800 of them. Colour follows the demo's render pipeline: each star
 *  is the base colour times 1.6–2.86 (HDR, brighter than white), tonemapped back to the screen, then a
 *  bloom pass adds a soft glow of the base colour around and between the stars. */
export type SwarmTool = 'claude' | 'codex' | 'dsh' | 'opencode' | 'pi';

// `null` = a one-colour mark in the theme's text colour (light on dark, dark on light).
const ICONS: Record<SwarmTool, { svg: string; color: string | null; own?: boolean }> = {
  claude: { svg: CLAUDE_SVG, color: '#D97757' },
  codex: { svg: CODEX_SVG, color: null },
  dsh: { svg: DSH_SVG, color: null, own: true },
  opencode: { svg: OPENCODE_SVG, color: null },
  pi: { svg: PI_SVG, color: null, own: true },
};

// ── The demo's numbers (icons.rs), in its units ──
const BOX = 300; // icon box (sample_icons.py)
const NEBULA_R = 125;
const DOTS = [1.6, 2.1, 2.7];
const COUNT = 1800;
const PALETTE = Array.from({ length: 8 }, (_, i) => 1.6 + i * 0.18);
const SEGMENT_S = 4; // seconds per nebula → icon → next nebula, recorded at 20 fps…
const PLAYBACK = 1.25; // …and encoded at 25 fps for the README, so it plays 1.25× faster
const MAX_STAGGER = 0.12;
// Canvas: the icon box plus room for the nebula's roll and the glow, as in the demo's frame.
const SIZE = 210; // CSS px
const SCALE = SIZE / 360; // demo units → CSS px (300-unit icon in a 360-unit frame)
const SEGMENT = (SEGMENT_S / PLAYBACK) * 1000; // ms on screen
const FORMS = 4;
// Bloom passes on the dark theme: [blur radius as a share of the icon box, strength].
const BLOOM: Array<[number, number]> = [[0.012, 0.2], [0.05, 0.26], [0.14, 0.62]];
const TAU = Math.PI * 2;

interface Star { tx: number; ty: number; base: [number, number, number]; s: [number, number, number]; rand: number; shimmer: number; dot: number; k: number }

const smooth = (x: number) => { const v = Math.min(1, Math.max(0, x)); return v * v * (3 - 2 * v); };
/** icons.rs `assembled`: 0 in the nebula, 1 in the icon, zero at both ends of a segment. */
const assembled = (u: number, stagger: number, flight: number) => smooth((u - 0.18 - stagger) / flight) * (1 - smooth((u - 0.76 - stagger * 0.4) / 0.12));

/** icons.rs `nebula_point`, y up. */
function nebula(form: number, [a, b, c]: [number, number, number]): [number, number, number] {
  const r = NEBULA_R;
  const sphere = (u: number, v: number): [number, number, number] => { const z = 2 * u - 1; const t = TAU * v; const ring = Math.sqrt(Math.max(0, 1 - z * z)); return [ring * Math.cos(t), z, ring * Math.sin(t)]; };
  if (form === 0) { const p = sphere(a, b); const k = r * c ** 0.6; return [p[0] * k, p[1] * k, p[2] * k]; }
  if (form === 1) {
    const [lat0, lon0] = c < 0.55 ? [(Math.floor(a * 7) + 0.5) / 7 - 0.5, b] : [a - 0.5, Math.floor(b * 8) / 8];
    const lat = lat0 * Math.PI; const lon = lon0 * TAU;
    return [Math.cos(lat) * Math.cos(lon) * r, Math.sin(lat) * r, Math.cos(lat) * Math.sin(lon) * r];
  }
  if (form === 2) {
    if (c < 0.55) { const p = sphere(a, b); return [p[0] * r * 0.62, p[1] * r * 0.62, p[2] * r * 0.62]; }
    // A flat ring tilted 0.45 rad about x.
    const t = TAU * b; const rr = r * (0.95 + 0.45 * a); const x = rr * Math.cos(t); const z = rr * Math.sin(t);
    return [x, -z * Math.sin(0.45), z * Math.cos(0.45)];
  }
  const t = TAU * a; const p = TAU * b; const major = r * 0.72; const minor = r * 0.3;
  return [(major + minor * Math.cos(p)) * Math.cos(t), minor * Math.sin(p), (major + minor * Math.cos(p)) * Math.sin(t)];
}

/** Rodrigues rotation of v around a unit axis. */
function rotate(v: [number, number, number], k: [number, number, number], angle: number): [number, number, number] {
  const c = Math.cos(angle); const s = Math.sin(angle); const d = (k[0] * v[0] + k[1] * v[1] + k[2] * v[2]) * (1 - c);
  return [v[0] * c + (k[1] * v[2] - k[2] * v[1]) * s + k[0] * d, v[1] * c + (k[2] * v[0] - k[0] * v[2]) * s + k[1] * d, v[2] * c + (k[0] * v[1] - k[1] * v[0]) * s + k[2] * d];
}
// The left icon's roll axis in the demo: (0.85, 0.45, 0.28), normalised.
const AXIS = (() => { const v = [0.85, 0.45, 0.28]; const l = Math.hypot(...v); return v.map(x => x / l) as [number, number, number]; })();

// ── Colour: the demo's HDR star colours through a filmic tonemap ──
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
/** Base colour (0–1 sRGB) times k, as Bevy's `Color::srgb(base * k)`, tonemapped to a CSS colour.
 *  Fitted to the README frame (least squares on Claude's star colours, rgb(225,160,130) at k 1.6 to
 *  rgb(255,215,190) at k 2.86, with ChatGPT's brightest stars reaching white). */
function tonemap([r, g, b]: [number, number, number], k: number) {
  const lin = [r * k, g * k, b * k].map(c => toLinear(Math.min(c, 4)));
  const mapped = lin.map(c => 1 - Math.exp(-0.7 * c));
  const luma = 0.2126 * mapped[0] + 0.7152 * mapped[1] + 0.0722 * mapped[2];
  const desat = 0.06; // the fit gives 0.1; a little less keeps Claude a touch more orange
  const out = mapped.map(c => Math.min(1, c + (luma - c) * desat));
  return `rgb(${out.map(c => Math.round(toSrgb(c) * 255)).join(',')})`;
}

let seed = 0x2545f491;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const parseRgb = (css: string): [number, number, number] => { const m = css.match(/[\d.]+/g) ?? ['0', '0', '0']; return [Number(m[0]) / 255, Number(m[1]) / 255, Number(m[2]) / 255]; };
const hexRgb = (hex: string): [number, number, number] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
const css = (c: [number, number, number]) => `rgb(${c.map(v => Math.round(v * 255)).join(',')})`;
/** Bevy blooms in linear light, which keeps the glow saturated (the README's gaps read rgb(87,24,0)).
 *  Canvas blends in sRGB, so the glow is fed the base colour's linear values, brightest channel at 1. */
const glowColour = (c: [number, number, number]) => { const lin = c.map(toLinear); const top = Math.max(...lin, 1e-6); return css(lin.map(v => v / top) as [number, number, number]); };

const cache = new Map<SwarmTool, Promise<Star[]>>();
/** sample_icons.py: points picked uniformly inside the shape with a fixed seed, centred, fitted to the
 *  300-unit box, y up. Icons with their own colours keep each pixel's colour. */
function sample(tool: SwarmTool): Promise<Star[]> {
  const hit = cache.get(tool);
  if (hit) return hit;
  const job = new Promise<Star[]>((resolve, reject) => {
    const res = 240;
    const svg = ICONS[tool].svg.replace(/<\?xml[^>]*>|<!--[\s\S]*?-->/g, '')
      .replace(/<svg\b([^>]*)>/, (_m, attrs: string) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, '')} width="${res}" height="${res}" color="#000">`);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = res;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) { reject(new Error('no 2d context')); return; }
      ctx.drawImage(img, 0, 0, res, res);
      const data = ctx.getImageData(0, 0, res, res).data;
      const inside: Array<[number, number, [number, number, number]]> = [];
      let x0 = res, x1 = 0, y0 = res, y1 = 0;
      for (let y = 0; y < res; y += 2) for (let x = 0; x < res; x += 2) {
        const i = (y * res + x) * 4;
        if (data[i + 3] < 128) continue;
        inside.push([x, y, [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255]]);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      if (!inside.length) { resolve([]); return; }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, scale = BOX / Math.max(x1 - x0, y1 - y0, 1);
      // Fisher–Yates with the fixed seed: a sample without replacement, repeated only if the shape is tiny.
      const order = inside.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      const fixed = ICONS[tool].color ? hexRgb(ICONS[tool].color) : null;
      const stars: Star[] = [];
      for (let n = 0; n < COUNT; n++) {
        const [x, y, colour] = inside[order[n % order.length]];
        stars.push({
          tx: (x + rnd() * 2 - cx) * scale, ty: (cy - y - rnd() * 2) * scale,
          base: ICONS[tool].own ? colour : fixed ?? [1, 1, 1],
          s: [rnd(), rnd(), rnd()], rand: rnd(), shimmer: rnd() * TAU,
          dot: DOTS[Math.floor(rnd() * 3) % 3], k: PALETTE[Math.floor(rnd() * 8) % 8],
        });
      }
      resolve(stars);
    };
    img.onerror = () => reject(new Error(`cannot load ${tool} icon`));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  cache.set(tool, job);
  return job;
}

function useMotionAllowed() {
  const [allowed, setAllowed] = useState(() => !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setAllowed(!document.hidden && !motion.matches);
    motion.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    return () => { motion.removeEventListener('change', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  return allowed;
}

export function ToolSwarm({ tool, isActive }: { tool: SwarmTool; isActive: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const motionAllowed = useMotionAllowed();
  const running = isActive && motionAllowed;
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0; let stars: Star[] = []; let cancelled = false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(SIZE * dpr);
    canvas.width = canvas.height = px;
    // Two offscreen layers: the stars as seen, and their base colour that feeds the bloom.
    const starLayer = document.createElement('canvas'); starLayer.width = starLayer.height = px;
    const glowLayer = document.createElement('canvas'); glowLayer.width = glowLayer.height = px;
    const sctx = starLayer.getContext('2d'); const gctx = glowLayer.getContext('2d');
    const edge = ctx.createRadialGradient(px / 2, px / 2, px * 0.36, px / 2, px / 2, px * 0.5);
    edge.addColorStop(0, '#000'); edge.addColorStop(1, 'rgba(0,0,0,0)');
    let palette = new Map<string, string>();
    let paletteKey = '';
    // Start just after a segment begins so the first frame is a nebula, not an empty canvas.
    const origin = performance.now() - SEGMENT * 0.02;
    const draw = (now: number) => {
      if (!sctx || !gctx) return;
      const text = getComputedStyle(canvas).color;
      const light = document.documentElement.getAttribute('data-mode') === 'light' || canvas.closest('[data-mode="light"]') !== null;
      const key = `${text}|${light}`;
      if (key !== paletteKey) { palette = new Map(); paletteKey = key; }
      const mono = parseRgb(text);
      const t = running ? (now - origin) / SEGMENT : 0.6; // in segments; paused shows the formed icon
      const segment = Math.floor(t);
      const u = t - segment;
      const roll = TAU * t; // ROLL_TURNS 4 per 4-segment loop
      const form = (segment + (u < 0.64 ? 0 : 1)) % FORMS;
      const k = SCALE * dpr;
      const c = px / 2;
      const ca = Math.cos(1.9), sa = Math.sin(1.9);
      for (const l of [sctx, gctx]) { l.setTransform(1, 0, 0, 1, 0, 0); l.clearRect(0, 0, px, px); }
      for (const p of stars) {
        const star = rotate(nebula(form, p.s), AXIS, roll);
        const depth = Math.max(-1, Math.min(1, star[2] / NEBULA_R));
        const goalX = p.tx + Math.cos(TAU * t + p.shimmer) * 1.2;
        const goalY = p.ty + Math.sin(TAU * t + p.shimmer) * 1.2;
        // Vortex: a quadratic Bézier through the nebula point turned 1.9 rad, at half length.
        const w = assembled(u, p.rand * MAX_STAGGER, 0.25);
        const kx = (star[0] * ca - star[1] * sa) * 0.5, ky = (star[0] * sa + star[1] * ca) * 0.5;
        const m = 1 - w;
        const x = star[0] * m * m + kx * 2 * m * w + goalX * w * w;
        const y = star[1] * m * m + ky * 2 * m * w + goalY * w * w;
        // Near stars look bigger in the nebula; all settle to 1.15× in the icon.
        const nebulaScale = 0.8 + 0.4 * depth;
        const r = p.dot * (nebulaScale + (1.15 - nebulaScale) * w) * k;
        const base = ICONS[tool].color || ICONS[tool].own ? p.base : mono;
        const id = `${base.join(',')}|${p.k}`;
        let fill = palette.get(id);
        if (!fill) {
          // On the light theme there is nothing to glow against: stars keep their own colour.
          fill = light ? css(base) : tonemap(base, p.k);
          palette.set(id, fill);
        }
        const sx = c + x * k, sy = c - y * k;
        sctx.fillStyle = fill; sctx.beginPath(); sctx.arc(sx, sy, r, 0, TAU); sctx.fill();
        gctx.fillStyle = glowColour(base); gctx.beginPath(); gctx.arc(sx, sy, r, 0, TAU); gctx.fill();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, px, px);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
      // Bloom: the base colour, blurred at a tight, a middle and a wide radius. The tight pass fills the
      // gaps between stars with deep colour; the wide pass is the halo around the icon.
      ctx.globalCompositeOperation = light ? 'source-over' : 'lighter';
      // An engine without canvas filters (older WebKitGTK) would stack the glow unblurred and overexpose the
      // stars: it gets the stars alone.
      const bloom: Array<[number, number]> = !('filter' in ctx) ? [] : light ? [[0.03, 0.12]] : BLOOM;
      for (const [radius, alpha] of bloom) {
        ctx.filter = `blur(${Math.max(1, Math.round(radius * BOX * k))}px)`;
        ctx.globalAlpha = alpha;
        ctx.drawImage(glowLayer, 0, 0);
      }
      ctx.filter = 'none'; ctx.globalAlpha = 1;
      // The wide glow reaches past the canvas; fade it out before the edge so no square shows.
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = edge;
      ctx.fillRect(0, 0, px, px);
      ctx.globalCompositeOperation = 'source-over';
      // Stars go on top: bloom only adds a little to a star that is already this bright (the README's
      // stars stay peach, not white), so it shows in the gaps and around the icon.
      ctx.drawImage(starLayer, 0, 0);
      if (running) raf = requestAnimationFrame(draw);
    };
    sample(tool).then(list => { if (cancelled) return; stars = list; raf = requestAnimationFrame(draw); }).catch(() => undefined);
    // A still icon redraws once when the theme flips, so a one-colour mark follows the new text colour.
    const themes = new MutationObserver(() => { if (!running && stars.length) { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); } });
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode', 'data-theme', 'style'] });
    return () => { cancelled = true; cancelAnimationFrame(raf); themes.disconnect(); };
  }, [tool, running]);
  return <canvas ref={ref} className="tool-swarm" data-tool={tool} data-paused={!running || undefined} aria-hidden="true" />;
}
