// src-ui/src/lib/latency-rig.ts
//
// Always-on input/output latency diagnostic. Ports Zed's input-latency
// methodology (reference/zed/crates/input_latency_ui + gpui window.rs
// `input-latency-histogram`) to our WebView2 + React + xterm.js stack.
// See reference/notes/01 + 02.
//
// ALWAYS-ON (active in ALL builds incl. release): the user dogfoods the
// release build (can't easily switch to dev mid-session), so the rig must
// be measurable on any build — incl. a release installer on another
// machine. Cost is near-zero: ~3 performance.now() calls + bounded
// ring-buffer writes per terminal event (events arrive at most every ~8ms
// due to Rust-side batching in src/terminal.rs), plus four 20k-sample
// Float64 ring buffers (~640 KB). No telemetry — dumps are local only
// (clipboard + console.log).
//
// Two paths, each Zed-shaped (latency distribution + per-frame coalesce):
//   INPUT  : keydown (attachCustomKeyEventHandler, TierTerminal.tsx:680)
//            → next requestAnimationFrame   [= Zed's dispatch_event → present]
//   OUTPUT : onOutput (Tauri 'tier-terminal-output', TierTerminal.tsx:855)
//            → term.onRender                 [real render-done, better than rAF]
//
// Worst-case first-input semantics (gpui window.rs:1161 get_or_insert): per
// frame, only the FIRST event's timestamp is retained; subsequent events
// just bump the coalesce count. A "frame" = one rAF (input) / one onRender
// (output).
//
// Dump: Ctrl/Cmd+Shift+L (or window.__coffeeLatency.dump() in devtools).
// Output goes to the CLIPBOARD (visible in release builds without devtools)
// + console.log (devtools, for dev). Dumps auto-reset, so consecutive dumps
// show delta-since-last (Zed's delta semantics) — run a scenario, dump,
// change code, re-run, dump, compare.
//
// v1 omits mid-draw-dropped + render-ms-per-frame (see notes/02 TODO).

import { clipboardWrite } from './clipboard';

// ── fps-aligned buckets (ms) — matches Zed's write_latency_distribution ───────
const BUCKETS: Array<{ lo: number; hi: number; label: string; note: string }> = [
  { lo: 0, hi: 4, label: '0–4ms', note: 'excellent' },
  { lo: 4, hi: 8, label: '4–8ms', note: '120fps' },
  { lo: 8, hi: 16, label: '8–16ms', note: '60fps' },
  { lo: 16, hi: 33, label: '16–33ms', note: '30fps' },
  { lo: 33, hi: 100, label: '33–100ms', note: '' },
  { lo: 100, hi: Infinity, label: '100ms+', note: 'sluggish' },
];
const PERCENTILES: Array<{ label: string; q: number }> = [
  { label: 'min  ', q: 0 },
  { label: 'p50  ', q: 0.5 },
  { label: 'p75  ', q: 0.75 },
  { label: 'p90  ', q: 0.9 },
  { label: 'p95  ', q: 0.95 },
  { label: 'p99  ', q: 0.99 },
  { label: 'p99.9', q: 0.999 },
  { label: 'max  ', q: 1 },
];

/** Bounded ring buffer of recent samples (ms or counts). No deps — HDRHistogram
 *  is the "proper" version for production telemetry; this is sufficient for dev. */
class Histogram {
  private buf: Float64Array;
  private idx = 0;
  private n = 0;
  constructor(capacity = 20000) { this.buf = new Float64Array(capacity); }
  record(v: number): void {
    this.buf[this.idx] = v;
    this.idx = (this.idx + 1) % this.buf.length;
    if (this.n < this.buf.length) this.n++;
  }
  get count(): number { return this.n; }
  get isEmpty(): boolean { return this.n === 0; }
  /** q-th quantile (0..1) over a sorted copy of recorded samples. */
  percentile(q: number): number {
    if (this.n === 0) return 0;
    const sorted = Array.from(this.buf.subarray(0, this.n)).sort((a, b) => a - b);
    if (q === 0) return sorted[0];
    if (q === 1) return sorted[sorted.length - 1];
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  }
  distribution(): number[] {
    return BUCKETS.map(b => {
      let c = 0;
      for (let i = 0; i < this.n; i++) if (this.buf[i] >= b.lo && this.buf[i] < b.hi) c++;
      return c;
    });
  }
  reset(): void { this.idx = 0; this.n = 0; }
}

function formatLatency(h: Histogram, heading: string): string {
  if (h.isEmpty) return `  ${heading}: (no samples)\n`;
  let out = `  ${heading}:\n`;
  for (const { label, q } of PERCENTILES) {
    const ms = h.percentile(q);
    const hz = ms > 0 ? 1000 / ms : Infinity;
    out += `    ${label}: ${ms.toFixed(2).padStart(8)}ms  (${hz.toFixed(1).padStart(7)} Hz)\n`;
  }
  const dist = h.distribution();
  const total = h.count;
  out += `    distribution:\n`;
  BUCKETS.forEach((b, i) => {
    const c = dist[i];
    const pct = total > 0 ? (c / total) * 100 : 0;
    const bar = '█'.repeat(Math.round((pct / 100) * 30));
    out += `      ${b.label.padStart(8)}  ${b.note.padEnd(10)}: ${String(c).padStart(6)} (${pct.toFixed(1).padStart(5)}%) ${bar}\n`;
  });
  return out;
}

function formatCount(h: Histogram, heading: string, unit: string): string {
  if (h.isEmpty) return `  ${heading}: (no samples)\n`;
  let out = `  ${heading} (per frame, ${unit}):\n`;
  for (const { label, q } of PERCENTILES) {
    out += `    ${label}: ${h.percentile(q).toFixed(2).padStart(8)}\n`;
  }
  return out;
}

// ── Per-path rig ──────────────────────────────────────────────────────────────

interface FrameState {
  firstAt: number | null; // first event of the frame (get_or_insert semantics)
  events: number;         // events coalesced into this frame
}

class PathRig {
  latency = new Histogram();
  coalesce = new Histogram();
  private frame: FrameState = { firstAt: null, events: 0 };

  /** Arm firstAt (first-input semantics) + bump event count. */
  start(tsMs: number): void {
    if (this.frame.firstAt === null) this.frame.firstAt = tsMs;
    this.frame.events++;
  }
  /** Frame presented (rAF / onRender): record latency + coalesce, reset frame. */
  stop(tsMs: number): void {
    if (this.frame.firstAt !== null) {
      const latency = tsMs - this.frame.firstAt;
      // Discard stale-frame samples (e.g. terminal disposed while output
      // was armed): a real render-frame latency is well under 5s; anything
      // larger is a stale arm, not a real measurement.
      if (latency < 5_000) {
        this.latency.record(latency);
        this.coalesce.record(this.frame.events);
      }
    }
    this.frame = { firstAt: null, events: 0 };
  }
  reset(): void {
    this.latency.reset();
    this.coalesce.reset();
    this.frame = { firstAt: null, events: 0 };
  }
}

const inputRig = new PathRig();
const outputRig = new PathRig();

// ── Input frame end: one rAF per frame that had input (first-input arms it) ──
let inputRafScheduled = false;
function scheduleInputRaf(): void {
  if (inputRafScheduled) return;
  inputRafScheduled = true;
  requestAnimationFrame(() => {
    inputRafScheduled = false;
    inputRig.stop(performance.now());
  });
}

function dumpRig(): void {
  let out = '═══ Coffee CLI Latency Rig ═══\n';
  out += '\n── INPUT path (keydown → rAF) ──\n';
  out += formatLatency(inputRig.latency, 'input latency');
  out += formatCount(inputRig.coalesce, 'keys coalesced/frame', 'events');
  out += '\n── OUTPUT path (onOutput → onRender) ──\n';
  out += formatLatency(outputRig.latency, 'output latency');
  out += formatCount(outputRig.coalesce, 'PTY chunks/frame', 'chunks');
  out += '═══════════════════════════════\n';
  // Console (devtools, dev) + clipboard (visible in release builds w/o devtools).
  console.log(out);
  void clipboardWrite(out); // clipboard.ts swallows failures internally
  // Reset after dump → next dump = delta since this one (Zed semantics).
  inputRig.reset();
  outputRig.reset();
}

/** Public API. Always-on (see header) — near-zero cost, no telemetry. */
export const rig = {
  /** Call at the top of the keydown handler (attachCustomKeyEventHandler). */
  inputStart: () => {
    inputRig.start(performance.now());
    scheduleInputRaf();
  },
  /** Call at the top of the onOutput handler. */
  outputStart: () => {
    outputRig.start(performance.now());
  },
  /** Call from a term.onRender listener. */
  outputRenderEnd: () => {
    outputRig.stop(performance.now());
  },
  dump: dumpRig,
  reset: () => { inputRig.reset(); outputRig.reset(); },
};

// Expose on window for devtools + a shortcut so the report can be triggered
// without devtools (Ctrl/Cmd+Shift+L). The dump goes to the clipboard, so it's
// visible in release builds where devtools is off.
if (typeof window !== 'undefined') {
  (window as unknown as { __coffeeLatency?: typeof rig }).__coffeeLatency = rig;
  // Capture phase + stopPropagation so the rig OWNS Ctrl/Cmd+Shift+L before
  // xterm's textarea sees it — otherwise xterm forwards the combo to the PTY
  // as an escape sequence. preventDefault alone (bubble phase) is too late.
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyL') {
      e.preventDefault();
      e.stopPropagation();
      dumpRig();
    }
  }, true);
}
