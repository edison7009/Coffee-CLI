import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiled = await build({
  entryPoints: [`${root}/src/lib/character-renderer.ts`],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'native-focus-fixture', setup(builder) {
    builder.onLoad({ filter: /[/\\]tauri\.ts$/ }, () => ({
      loader: 'js', contents: 'export const isTauri = globalThis.native;',
    }));
    builder.onResolve({ filter: /^@tauri-apps\/api\/window$/ }, () => ({ path: 'window', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
      loader: 'js', contents: 'export const getCurrentWindow = () => globalThis.nativeWindow;',
    }));
  } }],
});

function fixture(options = {}) {
  let now = 0, next = 0, draws = 0, programs = 0, textures = 0, released = 0;
  let resize, theme, nativeNotify, unsubscribed = 0, finishSubscribe;
  let focused = true, gpuReady = true, late = 0, cost = 0, animationTime = 0;
  const timers = new Map();
  const uniforms = {};
  const setTimeout = (callback, delay = 0) => {
    timers.set(++next, { at: now + delay, callback });
    return next;
  };
  const clearTimeout = id => timers.delete(id);
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    SYNC_STATUS: 5, SIGNALED: 6,
    createShader: () => ({}), createProgram: () => { programs++; return {}; },
    createTexture: () => { textures++; return {}; },
    getShaderParameter: () => !options.badShader, getProgramParameter: () => true,
    getShaderInfoLog: () => 'fixture compile failure',
    getUniformLocation: (_program, name) => name,
    uniform1f: (name, value) => { uniforms[name] = value; if (name === 'u_time') animationTime = value; },
    uniform2f: (name, ...values) => { uniforms[name] = values; },
    uniform4f: (name, ...values) => { uniforms[name] = values; },
    drawArraysInstanced: (...args) => { draws++; uniforms.draw = args; now += cost; },
    getSyncParameter: () => gpuReady ? 6 : 0, fenceSync: () => ({}),
    isContextLost: () => false,
    getExtension: name => name === 'WEBGL_debug_renderer_info'
      ? { UNMASKED_RENDERER_WEBGL: 7 } : { loseContext: () => {} },
    getParameter: () => options.software ? 'SwiftShader' : 'hardware renderer',
    deleteProgram: value => { if (value) released++; },
  };
  for (const name of ['shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'bindTexture',
    'texParameteri', 'texImage2D', 'useProgram', 'viewport', 'flush', 'deleteShader', 'deleteTexture', 'deleteSync']) {
    gl[name] = () => {};
  }
  const rect = { width: 1000, height: 650 };
  const canvas = Object.assign(new EventTarget(), {
    style: {}, width: 0, height: 0, getContext: () => options.noWebGL ? null : gl,
    getBoundingClientRect: () => rect,
  });
  const doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible', hasFocus: () => focused,
    documentElement: { dataset: { mode: 'dark' } },
    createElement: () => ({ getContext: () => ({ fillText() {} }) }),
  });
  const win = Object.assign(new EventTarget(), { setTimeout, clearTimeout, devicePixelRatio: 2 });
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, window: win, document: doc,
    native: !!options.native,
    nativeWindow: {
      onFocusChanged: async notify => {
        nativeNotify = notify;
        if (options.deferredNative) await new Promise(resolve => { finishSubscribe = resolve; });
        return () => { unsubscribed++; };
      },
      isFocused: async () => focused,
    },
    performance: { now: () => now },
    requestAnimationFrame: callback => setTimeout(() => {
      const timestamp = now;
      now += late;
      callback(timestamp);
    }, 16),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: () => ({ getPropertyValue: name => ({
      '--bg-panel': '#181e28', '--accent': '#6789b6', '--mono': 'monospace',
    })[name] }),
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} disconnect() {} },
    MutationObserver: class { constructor(callback) { theme = callback; } observe() {} disconnect() {} },
  });
  const renderer = module.exports.createCharacterRenderer(canvas);
  const advance = duration => {
    const until = now + duration;
    for (;;) {
      const pending = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!pending || pending[1].at > until) break;
      timers.delete(pending[0]);
      now = Math.max(now, pending[1].at);
      pending[1].callback();
    }
    now = Math.max(now, until);
  };
  return {
    renderer, advance, canvas, doc, win, rect, timers, uniforms, api: module.exports,
    resize: () => resize(), theme: () => theme(),
    focus: value => { focused = value; win.dispatchEvent(new Event(value ? 'focus' : 'blur')); },
    nativeFocus: value => nativeNotify({ payload: value }),
    finishNative: () => finishSubscribe(),
    lag: mode => { gpuReady = mode !== 'gpu'; cost = mode === 'slow' ? 70 : 0; late = mode === 'late' ? 20 : 0; },
    get draws() { return draws; }, get programs() { return programs; }, get textures() { return textures; },
    get released() { return released; }, get time() { return animationTime; },
    get unsubscribed() { return unsubscribed; },
  };
}

let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log(`  ok  ${name}`);
}
const microtasks = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

await test('caps frame rate, pixel resolution and glyph count on large displays', () => {
  const f = fixture();
  assert.ok(f.renderer);
  f.advance(1000);
  assert.ok(f.draws > 0 && f.draws <= 25);
  f.rect.width = 7680; f.rect.height = 4320;
  f.resize(); f.advance(100);
  assert.ok(f.canvas.width * f.canvas.height <= 4_005_000);
  assert.ok(f.uniforms.draw[3] <= 32000);
  assert.ok(f.uniforms.u_ink.every(Number.isFinite));
  assert.ok(f.uniforms.u_ink[2] > f.uniforms.u_ink[0], 'blue palette must remain blue');
  f.renderer.dispose();
});

await test('pauses on blur and hide, resumes without rebuilding or jumping time', () => {
  const f = fixture();
  f.advance(1000);
  const count = f.draws, time = f.time;
  f.focus(false);
  f.renderer.select('background-tool', { x: 0.4, y: 0.03 });
  f.advance(600_000);
  assert.equal(f.draws, count); assert.equal(f.timers.size, 0);
  f.focus(true); f.advance(1000);
  assert.ok(f.draws > count && f.time - time < 2);
  f.doc.visibilityState = 'hidden';
  f.doc.dispatchEvent(new Event('visibilitychange'));
  const hidden = f.draws;
  f.advance(1000); assert.equal(f.draws, hidden);
  f.doc.visibilityState = 'visible';
  f.doc.dispatchEvent(new Event('visibilitychange')); f.advance(1000);
  assert.ok(f.draws > hidden);
  assert.equal(f.programs, 1); assert.equal(f.textures, 1);
  f.renderer.dispose();
});

await test('settles after idle, redraws theme/size once and wakes on input or tab selection', () => {
  const f = fixture();
  f.advance(189_000);
  const count = f.draws;
  assert.equal(f.timers.size, 0);
  f.advance(60_000); assert.equal(f.draws, count);
  f.doc.documentElement.dataset.mode = 'light';
  f.theme(); f.advance(1000);
  assert.equal(f.draws, count + 1); assert.equal(f.timers.size, 0);
  assert.equal(f.uniforms.u_ink[3], 0.72);
  f.resize(); f.advance(1000); assert.equal(f.draws, count + 2);
  f.win.dispatchEvent(new Event('keydown')); f.advance(1000);
  assert.ok(f.draws > count + 2);
  f.renderer.select('codex', { x: 0.5, y: 0.5 }); f.advance(1000);
  assert.deepEqual(Array.from(f.uniforms.u_origin), [0.5, 0.5]);
  assert.equal(f.programs, 1);
  f.renderer.dispose();
});

await test('switching tabs wakes idle flow and resets the wave without rebuilding graphics', () => {
  const f = fixture();
  f.advance(189_000);
  const count = f.draws;
  assert.equal(f.timers.size, 0);
  f.renderer.select('agent:agent', { x: 0.4, y: 0.03 }); f.advance(1000);
  assert.ok(f.draws > count);
  assert.ok(f.uniforms.u_age < 2);
  assert.deepEqual(Array.from(f.uniforms.u_origin), [0.4, 0.03]);
  const seed = f.uniforms.u_glyphSeed;
  f.renderer.select('diff', { x: 0.7, y: 0.03 }); f.advance(100);
  assert.notEqual(f.uniforms.u_glyphSeed, seed);
  assert.ok(f.uniforms.u_age < 0.2);
  assert.equal(f.programs, 1); assert.equal(f.textures, 1);
  f.renderer.dispose();
});

for (const mode of ['gpu', 'slow', 'late']) await test(`backs off ${mode} frames and retries with existing resources`, () => {
  const f = fixture();
  f.advance(1000); f.lag(mode); f.advance(5000);
  const count = f.draws;
  f.advance(5000); assert.equal(f.draws, count);
  f.lag(null); f.advance(60_000);
  assert.ok(f.draws > count); assert.equal(f.programs, 1);
  f.renderer.dispose();
});

for (const mode of ['gpu', 'slow', 'late']) await test(`every existing tool tab switch interrupts ${mode} backoff`, () => {
  const f = fixture();
  f.advance(1000); f.lag(mode); f.advance(5000);
  f.lag(null);
  const count = f.draws;
  f.win.dispatchEvent(new Event('pointermove'));
  f.win.dispatchEvent(new Event('keydown'));
  f.advance(1000);
  assert.equal(f.draws, count, 'ordinary activity must preserve performance backoff');
  let previousSeed;
  for (const [id, x] of [['codex-session', 0.25], ['claude-session', 0.45], ['codex-session', 0.25]]) {
    const before = f.draws;
    f.renderer.select(id, { x, y: 0.03 }); f.advance(100);
    assert.ok(f.draws > before, 'a tab switch must produce feedback immediately, including returning to an old tab');
    assert.deepEqual(Array.from(f.uniforms.u_origin), [x, 0.03]);
    assert.ok(f.uniforms.u_age < 0.2);
    assert.notEqual(f.uniforms.u_glyphSeed, previousSeed);
    previousSeed = f.uniforms.u_glyphSeed;
    // A busy tool may cause another backoff before the next switch.
    f.lag(mode); f.advance(5000); f.lag(null);
  }
  assert.equal(f.programs, 1); assert.equal(f.textures, 1);
  f.renderer.dispose();
});

await test('theme changes never stack timers; context loss and disposal release everything', () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) {
    f.advance(35); f.theme(); f.advance(25);
    assert.equal(f.timers.size, 1);
  }
  f.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  assert.equal(f.canvas.style.visibility, 'hidden');
  f.renderer.dispose(); f.win.dispatchEvent(new Event('keydown')); f.advance(600_000);
  assert.equal(f.timers.size, 0); assert.equal(f.released, 1);
});

for (const option of ['noWebGL', 'software', 'badShader']) await test(`fails quietly with ${option}`, () => {
  const f = fixture({ [option]: true });
  assert.equal(f.renderer, null); assert.equal(f.timers.size, 0);
});

await test('native focus overrides stale document focus and unsubscribes on disposal', async () => {
  const f = fixture({ native: true });
  await microtasks(); f.advance(1000);
  const count = f.draws;
  f.nativeFocus(false); f.advance(600_000);
  assert.equal(f.draws, count); assert.equal(f.timers.size, 0);
  f.focus(false); f.nativeFocus(true); f.advance(1000);
  assert.ok(f.draws > count); assert.equal(f.programs, 1);
  f.renderer.dispose(); assert.equal(f.unsubscribed, 1);
});

await test('disposal before native subscription resolves still removes the listener', async () => {
  const f = fixture({ native: true, deferredNative: true });
  await microtasks(); f.renderer.dispose(); f.finishNative(); await microtasks();
  assert.equal(f.unsubscribed, 1); assert.equal(f.timers.size, 0);
});

await test('all 11 languages translate all shape options, including Monogram and Character Flow', async () => {
  const personalization = await build({
    entryPoints: [`${root}/src/lib/personalization.ts`],
    bundle: true, platform: 'node', format: 'cjs', write: false,
  });
  const module = { exports: {} };
  runInNewContext(personalization.outputFiles[0].text, { module, exports: module.exports });
  const shapes = module.exports.THEME_SHAPES;
  assert.equal(shapes.length, 10);
  assert.equal(shapes.slice(-2).map(shape => shape.code).join(), 'characters,basalt', 'Basalt follows Character flow');
  for (const language of module.exports.LANGUAGES) {
    const dictionary = await readFile(`${root}/src/i18n/${language.code}.ts`, 'utf8');
    for (const shape of shapes) assert.ok(dictionary.includes(`'${shape.labelKey}':`), `${language.code}: ${shape.code}`);
    if (language.code === 'zh-CN') assert.ok(dictionary.includes("'theme.shape.monogram': '老花纹'"));
  }
});

await test('saved character selection uses identical backdrop attributes before React starts', async () => {
  const html = await readFile(`${root}/index.html`, 'utf8');
  const attributes = {};
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    localStorage: { getItem: key => ({ 'cc-theme': 'indigo', 'cc-mode': 'light', 'cc-shape': 'characters' })[key] },
    window: { matchMedia: () => ({ matches: false }) },
    document: { documentElement: { setAttribute: (name, value) => { attributes[name] = value; } } },
  });
  assert.equal(attributes['data-shape'], 'carbon');
  assert.equal(attributes['data-background'], 'characters');
  assert.equal(attributes['data-mode'], 'light');
});

await test('saved Basalt selection gets Carbon chrome and its own backdrop before React starts', async () => {
  const html = await readFile(`${root}/index.html`, 'utf8');
  const attributes = {};
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    localStorage: { getItem: key => ({ 'cc-theme': 'indigo', 'cc-mode': 'light', 'cc-shape': 'basalt' })[key] },
    window: { matchMedia: () => ({ matches: false }) },
    document: { documentElement: { setAttribute: (name, value) => { attributes[name] = value; } } },
  });
  assert.equal(attributes['data-shape'], 'carbon');
  assert.equal(attributes['data-background'], 'basalt');
});

await test('first launch defaults to Graphite, dark mode and Basalt before React starts', async () => {
  const html = await readFile(`${root}/index.html`, 'utf8');
  const attributes = {};
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    localStorage: { getItem: () => null },
    window: { matchMedia: () => ({ matches: false }) },
    document: { documentElement: { setAttribute: (name, value) => { attributes[name] = value; } } },
  });
  assert.equal(attributes['data-theme'], 'obsidian');
  assert.equal(attributes['data-mode'], 'dark');
  assert.equal(attributes['data-shape'], 'carbon');
  assert.equal(attributes['data-background'], 'basalt');
  const state = await readFile(`${root}/src/store/app-state.tsx`, 'utf8');
  assert.match(state, /let theme: ThemeColor = 'obsidian';/);
  assert.match(state, /let themeMode: ThemeMode = 'dark';/);
  assert.match(state, /let shape: ThemeShape = 'basalt';/);
});

console.log(`OK: ${passed} character background regression checks`);
