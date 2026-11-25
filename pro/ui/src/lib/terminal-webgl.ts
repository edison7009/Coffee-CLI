// Process-wide WebGL renderer budget for xterm terminals. Split out of
// TierTerminal.tsx.

import type { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';

// ── Shared WebGL renderer budget ─────────────────────────────────────────────
// Chromium/WebView2 caps *active* WebGL contexts at ~16 per renderer process.
// With one terminal per tab/pane, a long session blows past that and the
// browser force-loses the OLDEST context. We mirror VS Code's terminal (whose
// team maintains xterm.js) with two process-wide guards:
//   • `webglDisabled` latch — once ANY terminal fails to acquire, or loses, its
//     GL context, every terminal that hasn't already attached (this one, if it
//     just failed, + all future ones) renders via the DOM renderer instead.
//     Terminals that already hold a live context keep it — the latch only
//     stops new competition for a slot that isn't coming back. xterm
//     auto-falls back to DOM when no render addon is loaded, so this degrades
//     gracefully instead of stranding a tab on a dead renderer.
//   • one cached GPU probe — the probe opens a throwaway GL context, so running
//     it per-terminal wasted a context slot every time.
let webglDisabled = false;
let gpuIsHardware: boolean | null = null;

export function detectHardwareWebgl(): boolean {
  try {
    const testCanvas = document.createElement('canvas');
    const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
    if (!gl) {
      console.log('[TierTerminal] WebGL unavailable → DOM renderer');
      return false;
    }
    const debugExt = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
    if (!debugExt) {
      // Privacy-hardened builds hide the renderer string; assume real hardware.
      // (Defaulting to DOM here used to spike CPU on locked-down machines.)
      console.log('[TierTerminal] GPU info hidden → WebGL (assuming hardware acceleration)');
      return true;
    }
    const renderer = (gl as WebGLRenderingContext).getParameter(debugExt.UNMASKED_RENDERER_WEBGL) as string;
    const isSoftware = /llvmpipe|softpipe|swrast|swiftshader|software|microsoft basic render|mesa offscreen/i.test(renderer);
    console.log(`[TierTerminal] GPU: ${renderer} → ${isSoftware ? 'DOM' : 'WebGL'} (software=${isSoftware})`);
    return !isSoftware;
  } catch {
    console.warn('[TierTerminal] WebGL probe failed → DOM renderer');
    return false;
  }
}

export function probeWebglOnce(): boolean {
  if (gpuIsHardware === null) gpuIsHardware = detectHardwareWebgl();
  return gpuIsHardware;
}

// Max context-loss recoveries per terminal before we conclude WebGL is
// unstable for this process and latch to the DOM renderer process-wide.
// Mirrors Tabby's MAX_WEBGL_RECOVERY_ATTEMPTS = 3. A single loss (typically
// Chromium reclaiming one of its ~16 active contexts) is recoverable — we
// dispose + re-attach on next visibility. Only repeated loss on the SAME
// terminal trips the process-wide latch.
export const MAX_WEBGL_RECOVERY_ATTEMPTS = 3;

// Retain only the two most recently hidden renderers. Switching between a few
// tabs reuses their contexts/atlases without reserving a context for every tab.
export const MAX_HIDDEN_WEBGL_RENDERERS = 2;
export const hiddenWebglRenderers = new Set<{ current: WebglAddon | null }>();

// Attach the WebGL renderer to `term`, respecting the shared context budget.
// Idempotent per terminal (guards on `webglRef`); a no-op once the latch is
// tripped or on a software GPU. Safe to call on first reveal AND on tab
// re-activation — a tab that is never shown never spends a context, and a
// least-recently hidden tabs release their contexts (see suspendWebglRenderer)
// so the active-context slots stay available for visible tabs. DOM fallback loses
// customGlyphs / rescaleOverlappingGlyphs, so box-drawing may misalign on
// degraded terminals.
export function attachWebglRenderer(
  term: Terminal,
  webglRef: { current: WebglAddon | null },
  attemptsRef: { current: number },
): void {
  hiddenWebglRenderers.delete(webglRef);
  if (webglDisabled || webglRef.current) return;
  if (!probeWebglOnce()) return; // software GPU → DOM renderer is cheaper
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      if (webglRef.current !== webgl) return;
      hiddenWebglRenderers.delete(webglRef);
      // Browser force-loses a context when the ~16 active-context cap is hit
      // or the GPU driver resets. Drop THIS terminal's renderer. Don't latch
      // process-wide on a single loss — re-attach is attempted on next
      // visibility (the tab is usually backgrounded when this fires, so the
      // re-attach lands on the next switch-back). Only after
      // MAX_WEBGL_RECOVERY_ATTEMPTS losses on the SAME terminal do we conclude
      // WebGL is unstable for this process and latch globally. Terminals that
      // already hold a live context (attached before this loss) are left alone
      // — revoking a still-working context would be more destructive than the
      // problem this is solving.
      try { webgl.dispose(); } catch { /* already gone */ }
      webglRef.current = null;
      attemptsRef.current += 1;
      if (attemptsRef.current >= MAX_WEBGL_RECOVERY_ATTEMPTS) {
        webglDisabled = true;
        console.warn(
          `[TierTerminal] WebGL context lost ${attemptsRef.current}× on one terminal → latching DOM renderer process-wide`,
        );
      }
    });
    term.loadAddon(webgl);
    webglRef.current = webgl;
    // Force an initial paint of the freshly-attached GL canvas. xterm's
    // setRenderer() already calls _fullRefresh(), but that render is
    // rAF-deferred and — when the attach lands on a tab that's ALREADY
    // visible (the switch-back path, where the IO/activation effect fires
    // after fit()) — the deferred render can race the canvasHidden mask's
    // onRender reveal, or land after the mask already fell back to its
    // 150 ms timeout. The new GL canvas then shows blank/stale until a
    // window resize forces ResizeObserver → fit() → re-render (issue #74,
    // "切换窗口卡住，重新拖动界面才正常"). An explicit refresh() re-marks
    // every row dirty and re-schedules, guaranteeing a painted GL frame
    // shortly after attach regardless of when the caller runs it.
    try {
      if (term.rows > 0) term.refresh(0, term.rows - 1);
    } catch { /* renderer not ready yet — first write surfaces it */ }
  } catch (err) {
    // No context available even now → give up on WebGL process-wide.
    webglDisabled = true;
    console.error('[TierTerminal] WebGL attach failed → DOM renderer', err);
  }
}

// Release this terminal's WebGL context WITHOUT tripping the recovery budget
// or the process-wide latch — used on cache eviction or unmount. Frees one of the
// ~16 active-context slots so new tabs don't get force-degraded to DOM. xterm
// falls back to its DOM renderer; buffer state is preserved, so re-attach on
// next visibility picks up where it left off. No-op when already detached.
export function detachWebglRenderer(
  webglRef: { current: WebglAddon | null },
): void {
  hiddenWebglRenderers.delete(webglRef);
  if (!webglRef.current) return;
  const webgl = webglRef.current;
  webglRef.current = null;
  try { webgl.dispose(); } catch { /* already gone */ }
}

export function suspendWebglRenderer(webglRef: { current: WebglAddon | null }): void {
  if (!webglRef.current || hiddenWebglRenderers.has(webglRef)) return;
  hiddenWebglRenderers.add(webglRef);
  if (hiddenWebglRenderers.size > MAX_HIDDEN_WEBGL_RENDERERS) {
    const oldest = hiddenWebglRenderers.values().next().value;
    if (oldest) detachWebglRenderer(oldest);
  }
}
