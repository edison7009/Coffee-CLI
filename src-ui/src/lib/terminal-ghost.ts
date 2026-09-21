// Clearing the ghost frames that accumulate in xterm's WebGL drawing buffer
// while the terminal canvas is hidden (issues #47, #74).
//
// @xterm/addon-webgl never calls gl.clear(). Every frame starts by drawing a
// full-viewport rectangle in the theme's background colour, and that rectangle
// is what erases the previous frame. Two things break that:
//
//   1. With a wallpaper — or a backdrop shape (glass / frost / carbon /
//      monogram) — TierTerminal builds the xterm theme with
//      `background: 'rgba(0,0,0,0)'` so the backdrop shows through. The
//      rectangle is then fully transparent and erases nothing. What actually
//      clears the buffer is Chromium's own "clear the drawing buffer after
//      compositing it" rule for a context created without
//      preserveDrawingBuffer, which is how the addon is configured.
//   2. A canvas that is not composited is never cleared by that rule. The
//      terminal canvas stops being composited exactly when TierTerminal masks
//      it (`opacity: 0` on tab switch-back and on window foreground) and while
//      it sits in a `display: none` background tab.
//
// So every frame an agent streams into a hidden terminal is alpha-blended on
// top of the one before it, and the reveal hands the compositor all of them at
// once: the doubled, sideways-smeared text users report as 重影. It then stays
// on screen until something repaints (clicking into the terminal, or dragging
// the window — "重新拖动界面才正常").
//
// Clearing the buffer immediately before the refresh that reveals the canvas
// gives that refresh a clean surface to paint the current grid onto. The
// clear is transparent, so nothing is imposed on the wallpaper underneath.
//
// Cheap and safe on an opaque theme too: the background rectangle repaints
// over the cleared buffer in the very same frame.

/** The slice of WebGL2RenderingContext this module uses. */
export interface DrawingBufferContext {
  isContextLost(): boolean;
  clearColor(red: number, green: number, blue: number, alpha: number): void;
  clear(mask: number): void;
  readonly COLOR_BUFFER_BIT: number;
}

/** The slice of HTMLCanvasElement this module uses. */
export interface DrawingBufferCanvas {
  getContext(contextId: 'webgl2'): DrawingBufferContext | null;
}

/**
 * Clear the accumulated drawing buffer of every live WebGL canvas in `canvases`.
 *
 * `getContext` returns the canvas's existing context when the type matches, so
 * this reaches the renderer's own context without the addon exposing it. A 2D
 * canvas answers null and is skipped, which also makes this a no-op on the DOM
 * renderer fallback (no WebGL canvas exists there at all).
 *
 * @returns how many canvases were cleared, for tests and debugging.
 */
export function clearWebglDrawingBuffers(
  canvases: Iterable<DrawingBufferCanvas>,
): number {
  let cleared = 0;
  for (const canvas of canvases) {
    let gl: DrawingBufferContext | null = null;
    try {
      gl = canvas.getContext('webgl2');
    } catch {
      continue; // Canvas already torn down; nothing to clear.
    }
    // A lost context restores itself with a blank buffer anyway, and issuing
    // commands against it is a no-op that only risks a console warning.
    if (!gl || gl.isContextLost()) continue;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    cleared++;
  }
  return cleared;
}
