import { isTauri } from '../tauri';

// A fixed glyph grid lit by drifting, curled ribbons. One instanced draw keeps
// the ambient effect off the React render path and avoids a full-size simulation.
const VERTEX = `#version 300 es
precision highp float;
uniform vec2 u_size;
uniform vec2 u_grid;
uniform vec2 u_origin;
uniform float u_time;
uniform float u_seed;
uniform float u_glyphSeed;
uniform float u_age;
out vec2 v_uv;
out float v_light;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float curl(vec2 p) {
  return noise(p) * 0.62 + noise(p * 2.1 + 9.0) * 0.27
       + noise(p * 4.3 + 17.0) * 0.11;
}
void main() {
  float index = float(gl_InstanceID);
  vec2 cell = vec2(mod(index, u_grid.x), floor(index / u_grid.x));
  vec2 corner = vec2(float(gl_VertexID % 2), float(gl_VertexID / 2));
  vec2 position = (cell + corner) / u_grid;
  gl_Position = vec4(position * vec2(2, -2) + vec2(-1, 1), 0, 1);

  vec2 p = (cell + 0.5) * vec2(7, 14) / 230.0;
  float t = u_time * 0.14;
  vec2 drift = vec2(t * 0.8, -t * 0.35);
  float eddy = curl(p * 0.72 + drift + u_seed);
  float fold = sin(p.x * 0.8 + p.y * 0.52 + eddy * 5.0 - t * 1.7);
  float ribbon = pow(max(0.0, 1.0 - abs(fold) * 3.2), 2.0);
  float detail = curl(p * 1.8 - drift * 0.7 + 24.0);
  float body = smoothstep(0.33, 0.76, eddy) * (0.3 + detail * 0.7);
  vec2 delta = ((cell + 0.5) / u_grid - u_origin) * u_size / 340.0;
  float distance = length(delta);
  float wake = exp(-pow((distance - u_age * 0.42) * 2.4, 2.0))
             * exp(-u_age * 0.48);
  v_light = clamp(0.004 + body * 0.07 + ribbon * detail * 0.42 + wake * 0.20, 0.0, 0.58);
  v_light *= smoothstep(0.0, 1.5, u_time);

  // Only scattered glyphs change at once; the wind carries light rather than
  // scrolling whole columns of text down the screen.
  float tick = floor(u_time * 0.65 + hash(cell) * 60.0);
  float glyph = floor(hash(cell + vec2(tick, u_glyphSeed)) * 62.0);
  vec2 tile = vec2(mod(glyph, 16.0), floor(glyph / 16.0));
  v_uv = (tile + corner) / vec2(16, 4);
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D u_atlas;
uniform vec4 u_ink;
in vec2 v_uv;
in float v_light;
out vec4 color;
void main() {
  float alpha = texture(u_atlas, v_uv).a * v_light * u_ink.a;
  color = vec4(u_ink.rgb * alpha, alpha);
}`;

export interface CharacterRenderer {
  select: (id: string, origin: { x: number; y: number }) => void;
  dispose: () => void;
}

type RGB = [number, number, number];

export function characterInk(
  surface: RGB,
  accent: RGB,
  dark: boolean
): [number, number, number, number] {
  // Background palettes carry the theme hue; neutral palettes use the UI accent.
  const source = Math.max(...surface) - Math.min(...surface) < 18 ? accent : surface;
  const minimum = Math.min(...source);
  const range = Math.max(...source) - minimum;
  const base = dark ? 0.22 : 0.1;
  const span = dark ? 0.66 : 0.43;
  const channels = source.map(
    (channel) => base + (range ? (channel - minimum) / range : 0.5) * span
  );
  return [channels[0], channels[1], channels[2], dark ? 1 : 0.72];
}

export function createCharacterRenderer(canvas: HTMLCanvasElement): CharacterRenderer | null {
  let gl: WebGL2RenderingContext | null;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      powerPreference: 'low-power',
      failIfMajorPerformanceCaveat: true,
    });
  } catch {
    return null;
  }
  if (!gl) return null;
  const context = gl;
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let atlas: WebGLTexture | null = null;
  let frame = 0;
  let timer: number | undefined;
  let fence: WebGLSync | null = null;
  let removeActivityListeners: (() => void) | undefined;
  let disposed = false;
  let observer: ResizeObserver | null = null;
  let theme: MutationObserver | null = null;
  const onContextLost = (event: Event) => {
    event.preventDefault();
    canvas.style.visibility = 'hidden';
    release();
  };
  const release = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    removeActivityListeners?.();
    observer?.disconnect();
    theme?.disconnect();
    canvas.removeEventListener('webglcontextlost', onContextLost);
    shaders.forEach((shader) => context.deleteShader(shader));
    context.deleteTexture(atlas);
    context.deleteProgram(program);
    if (fence) context.deleteSync(fence);
    if (!context.isContextLost()) context.getExtension('WEBGL_lose_context')?.loseContext();
  };

  try {
    const rendererInfo = context.getExtension('WEBGL_debug_renderer_info');
    if (
      rendererInfo &&
      /swiftshader|llvmpipe|softpipe|software|warp|basic render/i.test(
        String(context.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL))
      )
    ) {
      release();
      return null;
    }
    for (const [type, source] of [
      [context.VERTEX_SHADER, VERTEX],
      [context.FRAGMENT_SHADER, FRAGMENT],
    ] as const) {
      const shader = context.createShader(type);
      if (!shader) throw new Error('Unable to allocate character shader');
      shaders.push(shader);
      context.shaderSource(shader, source);
      context.compileShader(shader);
      if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
        throw new Error(context.getShaderInfoLog(shader) || 'Character shader compilation failed');
      }
    }
    program = context.createProgram();
    if (!program) throw new Error('Unable to allocate character program');
    shaders.forEach((shader) => context.attachShader(program!, shader));
    context.linkProgram(program);
    if (!context.getProgramParameter(program, context.LINK_STATUS)) {
      throw new Error(context.getProgramInfoLog(program) || 'Character shader link failed');
    }

    const glyphs = document.createElement('canvas');
    glyphs.width = 16 * 28;
    glyphs.height = 4 * 56;
    const ink = glyphs.getContext('2d');
    if (!ink) throw new Error('Character atlas unavailable');
    ink.font = `38px ${getComputedStyle(document.documentElement).getPropertyValue('--mono')}`;
    ink.textAlign = 'center';
    ink.textBaseline = 'middle';
    ink.fillStyle = '#fff';
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let i = 0; i < alphabet.length; i++) {
      ink.fillText(alphabet[i], (i % 16) * 28 + 14, Math.floor(i / 16) * 56 + 28);
    }
    atlas = context.createTexture();
    if (!atlas) throw new Error('Unable to allocate character atlas');
    context.bindTexture(context.TEXTURE_2D, atlas);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    context.texImage2D(
      context.TEXTURE_2D,
      0,
      context.RGBA,
      context.RGBA,
      context.UNSIGNED_BYTE,
      glyphs
    );
    context.useProgram(program);
    const uniforms = Object.fromEntries(
      ['size', 'grid', 'origin', 'time', 'seed', 'glyphSeed', 'age', 'ink'].map((name) => [
        name,
        context.getUniformLocation(program!, `u_${name}`),
      ])
    );
    let width = 1;
    let height = 1;
    let columns = 1;
    let rows = 1;
    let seed = 1;
    let targetSeed = 1;
    let origin = { x: 0.5, y: 0.5 };
    let time = 0;
    let selectedAt = 0;
    let lastTick = performance.now();
    let idleDeadline = lastTick + 180_000;
    let calm = false;
    let faults = 0;
    let slowFrames = 0;
    let gpuLate = 0;
    let draws = 0;
    let lateFrames: boolean[] = [];
    let retryAt = 0;
    let retryDelay = 60_000;
    let nativeFocused: boolean | undefined;
    const foreground = () =>
      document.visibilityState === 'visible' && (nativeFocused ?? document.hasFocus());
    const cancel = () => {
      window.clearTimeout(timer);
      timer = undefined;
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const schedule = () => {
      if (disposed || calm || !foreground() || frame || timer !== undefined) return;
      timer = window.setTimeout(
        () => {
          timer = undefined;
          if (disposed || !foreground()) return;
          if (retryAt) {
            retryAt = 0;
            faults = slowFrames = gpuLate = 0;
            lateFrames = [];
            lastTick = performance.now();
            idleDeadline = lastTick + 180_000;
          }
          frame = requestAnimationFrame(draw);
        },
        retryAt ? Math.max(0, retryAt - performance.now()) : faults ? 83 : 40
      );
    };
    const backoff = () => {
      if (retryAt) return;
      retryAt = performance.now() + retryDelay;
      retryDelay = Math.min(480_000, retryDelay * 2);
      cancel();
    };
    const noteLag = () => {
      if (++faults >= 2) backoff();
    };
    const wake = () => {
      if (disposed || !foreground()) return;
      idleDeadline = performance.now() + 180_000;
      if (calm) {
        calm = false;
        lastTick = performance.now();
      }
      schedule();
    };
    const onVisibility = () => {
      if (!foreground()) cancel();
      else {
        lastTick = performance.now();
        wake();
      }
    };
    const redraw = () => {
      if (disposed || !foreground() || retryAt || frame) return;
      window.clearTimeout(timer);
      timer = undefined;
      frame = requestAnimationFrame(draw);
    };
    let color: [number, number, number, number];
    const refreshTheme = () => {
      const style = getComputedStyle(document.documentElement);
      const read = (name: string) =>
        [1, 3, 5].map(offset => parseInt(style.getPropertyValue(name).trim().slice(offset, offset + 2), 16)) as RGB;
      color = characterInk(
        read('--bg-panel'),
        read('--accent'),
        document.documentElement.dataset.mode !== 'light'
      );
    };
    refreshTheme();
    theme = new MutationObserver(() => {
      refreshTheme();
      redraw();
    });
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-mode', 'style'],
    });
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      const dpr = Math.min(
        window.devicePixelRatio || 1,
        1.5,
        Math.sqrt(4_000_000 / (width * height))
      );
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      // Keep the glyph count bounded on large displays, independently of DPR.
      const cell = Math.max(8, Math.sqrt((width * height) / 32000));
      columns = Math.max(1, Math.floor(width / cell));
      rows = Math.max(1, Math.floor(height / (cell * 2)));
      context.viewport(0, 0, canvas.width, canvas.height);
    };
    observer = new ResizeObserver(() => {
      resize();
      redraw();
    });
    observer.observe(canvas);
    resize();
    const draw = (now: number) => {
      frame = 0;
      if (disposed || !foreground()) return;
      const started = performance.now();
      const delta = Math.min(100, Math.max(0, started - lastTick));
      lastTick = started;
      const settling = Math.min(1, Math.max(0, (started - idleDeadline) / 8000));
      time += (delta / 1000) * (1 - settling * settling * (3 - 2 * settling));
      seed += (targetSeed - seed) * (1 - Math.exp(-delta / 1800));
      context.uniform2f(uniforms.size, width, height);
      context.uniform2f(uniforms.grid, columns, rows);
      context.uniform2f(uniforms.origin, origin.x, origin.y);
      context.uniform1f(uniforms.time, time);
      context.uniform1f(uniforms.age, time - selectedAt);
      context.uniform1f(uniforms.seed, seed);
      context.uniform1f(uniforms.glyphSeed, targetSeed);
      context.uniform4f(uniforms.ink, ...color);
      context.drawArraysInstanced(context.TRIANGLE_STRIP, 0, 4, columns * rows);
      if (fence) {
        gpuLate =
          context.getSyncParameter(fence, context.SYNC_STATUS) === context.SIGNALED
            ? 0
            : gpuLate + 1;
        context.deleteSync(fence);
        fence = null;
        if (gpuLate >= 2) {
          gpuLate = 0;
          noteLag();
        }
      }
      if (++draws % 4 === 0) {
        fence = context.fenceSync(context.SYNC_GPU_COMMANDS_COMPLETE, 0);
        context.flush();
      }
      lateFrames = [...lateFrames.slice(-9), started - now > 17];
      if (lateFrames.filter(Boolean).length >= 5) {
        lateFrames = [];
        noteLag();
      }
      slowFrames = performance.now() - started > 50 ? slowFrames + 1 : 0;
      if (slowFrames >= 3) backoff();
      if (settling === 1) {
        calm = true;
        retryDelay = 60_000;
      }
      schedule();
    };
    canvas.addEventListener('webglcontextlost', onContextLost);
    window.addEventListener('focus', onVisibility);
    window.addEventListener('blur', onVisibility);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pointermove', wake, { passive: true });
    window.addEventListener('pointerdown', wake, { passive: true });
    window.addEventListener('keydown', wake);
    let unlistenNative: (() => void) | undefined;
    if (isTauri) {
      void (async () => {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        if (disposed) return;
        const win = getCurrentWindow();
        let revision = 0;
        const unlisten = await win.onFocusChanged(({ payload }) => {
          if (disposed) return;
          revision++;
          nativeFocused = payload;
          onVisibility();
        });
        if (disposed) { unlisten(); return; }
        unlistenNative = unlisten;
        const initialRevision = revision;
        const focused = await win.isFocused();
        if (!disposed && revision === initialRevision) {
          nativeFocused = focused;
          onVisibility();
        }
      })().catch(() => { /* Browser focus remains available if native focus fails. */ });
    }
    removeActivityListeners = () => {
      unlistenNative?.();
      window.removeEventListener('focus', onVisibility);
      window.removeEventListener('blur', onVisibility);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
    schedule();
    return {
      select(id, position) {
        let hash = 0;
        for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
        targetSeed = ((hash >>> 0) % 9700) / 2425;
        origin = position;
        selectedAt = time;
        // Explicit tab feedback must not wait for the ambient animation's retry.
        if (retryAt) {
          retryAt = 0;
          cancel();
          lastTick = performance.now();
        }
        faults = slowFrames = gpuLate = 0;
        lateFrames = [];
        wake();
      },
      dispose: release,
    };
  } catch {
    // Decoration must never block selection or launching on unsupported GPUs.
    release();
    return null;
  }
}
