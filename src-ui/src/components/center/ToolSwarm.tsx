import { useEffect, useRef, useState } from 'react';
import CLAUDE_SVG from '../../icons-inline/claude.svg?raw';
import CODEX_SVG from '../../icons-inline/codex.svg?raw';
import DSH_SVG from '../../icons-inline/deepseek-color.svg?raw';
import OPENCODE_SVG from '../../icons-inline/opencode-mark.svg?raw';
import PI_SVG from '../../icons-inline/pi.svg?raw';
import './ToolSwarm.css';

/** The welcome animation every conversation tool shares: a star nebula rolls in
 *  place, gathers into the tool's icon, holds, then shrinks into the next nebula
 *  form (star ball, globe, ringed planet, torus) and gathers again. Nothing flies
 *  in from the edges. Ported from the Playmand README demo (demos/src/bin/icons.rs). */
export type SwarmTool = 'claude' | 'codex' | 'dsh' | 'opencode' | 'pi';

// `null` colour = a one-colour mark drawn in the text colour, so it reads in light and dark themes.
const ICONS: Record<SwarmTool, { svg: string; color: string | null }> = {
  claude: { svg: CLAUDE_SVG, color: '#D97757' },
  codex: { svg: CODEX_SVG, color: null },
  dsh: { svg: DSH_SVG, color: null },
  opencode: { svg: OPENCODE_SVG, color: null },
  pi: { svg: PI_SVG, color: null },
};
// DeepSeek and Pi keep their own colours from the SVG; Codex and OpenCode follow the theme text colour.
const OWN_COLOURS = new Set<SwarmTool>(['dsh', 'pi']);

const SIZE = 168; // CSS px, square canvas
const ICON = 84; // icon box inside it
const NEBULA_R = 60;
const SEGMENT = 4200; // ms: nebula → icon → next nebula
const FORMS = 4;
const COUNT = 1500; // most stars any icon gets
const MIN_STARS = 700; // thin marks repeat pixels up to this many
const TAU = Math.PI * 2;

interface Star { tx: number; ty: number; color: string | null; s: [number, number, number]; rand: number; shimmer: number; size: number }

const smooth = (x: number) => { const v = Math.min(1, Math.max(0, x)); return v * v * (3 - 2 * v); };
/** 0 in the nebula, 1 in the icon; zero at both ends of a segment so segments chain seamlessly. */
const assembled = (u: number, stagger: number) => smooth((u - 0.16 - stagger) / 0.26) * (1 - smooth((u - 0.74 - stagger * 0.4) / 0.14));

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
const AXIS = (() => { const v = [0.85, 0.45, 0.28]; const l = Math.hypot(...v); return v.map(x => x / l) as [number, number, number]; })();

let seed = 0x2545f491;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };

const cache = new Map<SwarmTool, Promise<Star[]>>();
/** Sample the icon's filled pixels into star targets (centred, y down), with each pixel's colour. */
function sample(tool: SwarmTool): Promise<Star[]> {
  const hit = cache.get(tool);
  if (hit) return hit;
  const job = new Promise<Star[]>((resolve, reject) => {
    const res = 64;
    const svg = ICONS[tool].svg.replace(/<\?xml[^>]*>|<!--[\s\S]*?-->/g, '')
      .replace(/<svg\b([^>]*)>/, (_m, attrs: string) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, '')} width="${res}" height="${res}" color="#000">`);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = res;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) { reject(new Error('no 2d context')); return; }
      ctx.drawImage(img, 0, 0, res, res);
      const data = ctx.getImageData(0, 0, res, res).data;
      const pixels: Array<[number, number, string]> = [];
      for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
        const i = (y * res + x) * 4;
        if (data[i + 3] > 140) pixels.push([x, y, `rgb(${data[i]},${data[i + 1]},${data[i + 2]})`]);
      }
      // Every filled pixel gets one star, so the icon lands crisp; a sparse icon repeats pixels, a dense one is thinned evenly.
      const own = OWN_COLOURS.has(tool);
      const picks = pixels.length > COUNT ? pixels.filter((_, i) => i % Math.ceil(pixels.length / COUNT) === 0) : pixels;
      const stars: Star[] = [];
      for (let n = 0; n < Math.max(picks.length, MIN_STARS) && picks.length; n++) {
        const [x, y, color] = picks[n % picks.length];
        const extra = n >= picks.length;
        stars.push({
          tx: ((x + 0.5 + (extra ? rnd() - 0.5 : 0)) / res - 0.5) * ICON, ty: ((y + 0.5 + (extra ? rnd() - 0.5 : 0)) / res - 0.5) * ICON,
          color: own ? color : ICONS[tool].color, s: [rnd(), rnd(), rnd()], rand: rnd(), shimmer: rnd() * TAU, size: 1.1 + rnd() * 0.5,
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
    canvas.width = canvas.height = Math.round(SIZE * dpr);
    // Start part-way into a segment so the first frame is already a nebula, not an empty canvas.
    const origin = performance.now() - SEGMENT * 0.05;
    const draw = (now: number) => {
      const text = getComputedStyle(canvas).color;
      const light = document.documentElement.getAttribute('data-mode') === 'light' || canvas.closest('[data-mode="light"]') !== null;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.globalCompositeOperation = light ? 'source-over' : 'lighter';
      const t = running ? now - origin : SEGMENT * 0.55; // paused: the icon, fully formed
      const segment = Math.floor(t / SEGMENT);
      const u = (t % SEGMENT) / SEGMENT;
      const roll = TAU * 0.6 * t / SEGMENT;
      for (const p of stars) {
        const form = (segment + (u < 0.62 ? 0 : 1)) % FORMS;
        const star = rotate(nebula(form, p.s), AXIS, roll);
        const depth = Math.max(-1, Math.min(1, star[2] / NEBULA_R));
        const w = assembled(u, p.rand * 0.12);
        // A gentle swirl on the way in (the demo's vortex), so stars curve into place instead of sliding straight.
        const kx = star[0] * Math.cos(1.9) - star[1] * Math.sin(1.9); const ky = star[0] * Math.sin(1.9) + star[1] * Math.cos(1.9);
        const gx = p.tx + Math.cos(TAU * t / 3000 + p.shimmer) * 0.5; const gy = p.ty + Math.sin(TAU * t / 3000 + p.shimmer) * 0.5;
        const m = 1 - w;
        const x = star[0] * m * m + kx * 0.5 * 2 * m * w + gx * w * w;
        const y = star[1] * m * m + ky * 0.5 * 2 * m * w + gy * w * w;
        const size = p.size * ((0.7 + 0.3 * depth) * (1 - w) + w);
        ctx.globalAlpha = (0.45 + 0.3 * depth) * (1 - w) + 0.92 * w;
        ctx.fillStyle = p.color ?? text;
        ctx.fillRect(SIZE / 2 + x - size / 2, SIZE / 2 + y - size / 2, size, size);
      }
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
