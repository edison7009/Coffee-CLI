import {
  clearWebglDrawingBuffers,
  type DrawingBufferCanvas,
  type DrawingBufferContext,
} from './terminal-ghost';

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `assertion failed: ${message}\n  actual: ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`,
    );
  }
}

const COLOR_BUFFER_BIT = 0x4000;

interface FakeGl extends DrawingBufferContext {
  clears: number;
  lastClearColor: [number, number, number, number] | null;
  lastMask: number | null;
}

function fakeGl(lost = false): FakeGl {
  return {
    COLOR_BUFFER_BIT,
    clears: 0,
    lastClearColor: null,
    lastMask: null,
    isContextLost: () => lost,
    clearColor(r, g, b, a) { this.lastClearColor = [r, g, b, a]; },
    clear(mask) { this.lastMask = mask; this.clears++; },
  };
}

/** A canvas that answers `getContext('webgl2')` the way a WebGL one does. */
function webglCanvas(gl: FakeGl): DrawingBufferCanvas {
  return { getContext: () => gl };
}

/** xterm's 2D layers (and every canvas on the DOM renderer) answer null. */
function canvas2d(): DrawingBufferCanvas {
  return { getContext: () => null };
}

function clearsTheLiveWebglCanvas(): void {
  const gl = fakeGl();
  const cleared = clearWebglDrawingBuffers([webglCanvas(gl)]);
  equal(cleared, 1, 'the WebGL canvas is counted as cleared');
  equal(gl.clears, 1, 'clear() is issued exactly once');
  equal(gl.lastMask, COLOR_BUFFER_BIT, 'only the colour buffer is cleared');
  equal(
    JSON.stringify(gl.lastClearColor),
    JSON.stringify([0, 0, 0, 0]),
    'cleared to fully transparent so the wallpaper still shows through',
  );
}

function skipsCanvasesWithoutAWebglContext(): void {
  const gl = fakeGl();
  const cleared = clearWebglDrawingBuffers([canvas2d(), webglCanvas(gl), canvas2d()]);
  equal(cleared, 1, 'only the WebGL canvas is touched');
  equal(gl.clears, 1, 'the WebGL canvas is still found among 2D layers');
}

function skipsALostContext(): void {
  const gl = fakeGl(true);
  const cleared = clearWebglDrawingBuffers([webglCanvas(gl)]);
  equal(cleared, 0, 'a lost context is not counted');
  equal(gl.clears, 0, 'no command is issued against a lost context');
}

function survivesACanvasThatThrows(): void {
  const gl = fakeGl();
  const throwing: DrawingBufferCanvas = {
    getContext: () => { throw new Error('canvas detached'); },
  };
  const cleared = clearWebglDrawingBuffers([throwing, webglCanvas(gl)]);
  equal(cleared, 1, 'a torn-down canvas does not abort the sweep');
  equal(gl.clears, 1, 'the remaining canvas is still cleared');
}

function isANoOpOnTheDomRenderer(): void {
  equal(clearWebglDrawingBuffers([]), 0, 'no canvases, nothing cleared');
  equal(clearWebglDrawingBuffers([canvas2d()]), 0, 'DOM renderer has no WebGL canvas');
}

export async function main(): Promise<void> {
  const tests: [string, () => void][] = [
    ['clears the live WebGL canvas', clearsTheLiveWebglCanvas],
    ['skips canvases without a WebGL context', skipsCanvasesWithoutAWebglContext],
    ['skips a lost context', skipsALostContext],
    ['survives a canvas that throws', survivesACanvasThatThrows],
    ['is a no-op on the DOM renderer', isANoOpOnTheDomRenderer],
  ];
  for (const [name, run] of tests) {
    run();
    console.log(`  ok  ${name}`);
  }
  console.log(`terminal-ghost: ${tests.length} passed`);
}
