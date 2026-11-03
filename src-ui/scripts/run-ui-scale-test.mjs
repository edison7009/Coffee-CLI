import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/ui-scale.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'scale-fixture', setup(builder) {
    builder.onLoad({ filter: /[/\\]react[/\\]index\.js$/ }, () => ({ contents: 'export const useSyncExternalStore = (subscribe, snapshot) => snapshot();' }));
    builder.onLoad({ filter: /[/\\]api[/\\]webview\.js$/ }, () => ({ contents: 'export const getCurrentWebview = () => ({ setZoom: globalThis.zoom });' }));
  } }],
});

function fixture(saved, platform = 'Win32') {
  const values = new Map(saved === undefined ? [] : [['cc-ui-scale', saved]]);
  const zooms = [], writes = [], events = [], handlers = {}, cssVars = {};
  let failure = false;
  let zoomGate;
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, Event,
    navigator: { platform },
    document: { documentElement: { style: { setProperty: (name, value) => { cssVars[name] = value; } } } },
    zoom: async value => { zooms.push(value); if (failure) throw new Error('native failure'); if (zoomGate) { const gate = zoomGate; zoomGate = undefined; await gate; } },
    window: {
      __TAURI_INTERNALS__: {},
      addEventListener: (name, handler) => { handlers[name] = handler; },
      dispatchEvent: event => { events.push(event.type); },
    },
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { writes.push([key, value]); values.set(key, value); },
    },
  });
  return { api: module.exports, cssVars, values, zooms, writes, events, handlers, fail: value => { failure = value; }, holdZoom: () => { let release; zoomGate = new Promise(resolve => { release = resolve; }); return release; } };
}

let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`  ok  ${name}`); }

await test('restores saved scale before startup without rewriting storage', async () => {
  const f = fixture('80');
  await f.api.initializeUiScale();
  assert.deepEqual(f.zooms, [0.8]);
  assert.equal(f.api.useUiScale().percent, 80);
  assert.equal(f.writes.length, 0);
});
await test('missing and invalid preferences restore 100%', async () => {
  for (const saved of [undefined, 'garbage', '0', '160', '85']) {
    const f = fixture(saved); await f.api.initializeUiScale();
    assert.deepEqual(f.zooms, [1]);
  }
});
await test('bounds and reset persist only applied values and notify terminals', async () => {
  const f = fixture();
  for (const value of [1, 999, 100]) await f.api.setUiScale(value);
  assert.deepEqual(f.zooms, [0.7, 1.5, 1]);
  assert.deepEqual(f.writes.map(write => write[1]), ['70', '150', '100']);
  assert.equal(f.events.length, 3);
});
await test('native failure preserves saved scale and can be retried', async () => {
  const f = fixture('90'); await f.api.initializeUiScale(); f.fail(true);
  await f.api.setUiScale(80);
  assert.equal(f.api.useUiScale().percent, 90);
  assert.equal(f.api.useUiScale().failed, true);
  assert.equal(f.api.useUiScale().pending, false);
  assert.equal(f.writes.length, 0);
  f.fail(false); await f.api.setUiScale(80);
  assert.equal(f.api.useUiScale().failed, false);
  assert.equal(f.values.get('cc-ui-scale'), '80');
});
await test('other windows follow preference changes without writing back', async () => {
  const f = fixture('100'); await f.api.initializeUiScale();
  f.values.set('cc-ui-scale', '90');
  f.handlers.storage({ key: 'cc-ui-scale' });
  // Wait for the queued native operation and its finally callback.
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(f.zooms, [1, 0.9]);
  assert.equal(f.writes.length, 0);
});
await test('queued changes apply in order and end at the last requested scale', async () => {
  const f = fixture();
  await Promise.all([f.api.setUiScale(80), f.api.setUiScale(120)]);
  assert.deepEqual(f.zooms, [0.8, 1.2]);
  assert.equal(f.values.get('cc-ui-scale'), '120');
  assert.equal(f.api.useUiScale().pending, false);
});
await test('fast dragging replaces stale queued steps and saves only the latest scale', async () => {
  const f = fixture();
  const release = f.holdZoom();
  const first = f.api.setUiScale(80);
  while (f.zooms.length === 0) await new Promise(resolve => setTimeout(resolve, 0));
  const changes = [90, 100, 110, 150, 120].map(value => f.api.setUiScale(value));
  assert.equal(f.api.useUiScale().requestedPercent, 120);
  assert.equal(f.api.useUiScale().pending, true);
  release();
  await Promise.all([first, ...changes]);
  assert.deepEqual(f.zooms, [0.8, 1.2]);
  assert.deepEqual(f.writes.map(write => write[1]), ['120']);
  assert.equal(f.api.useUiScale().requestedPercent, null);
  assert.equal(f.api.useUiScale().pending, false);
});
await test('applied scale reaches CSS and only macOS counter-zooms titlebar coordinates', async () => {
  const mac = fixture(undefined, 'MacIntel');
  await mac.api.setUiScale(150);
  assert.equal(mac.cssVars['--ui-scale'], '1.5');
  assert.equal(mac.api.titlebarPxPerClientPx(), 1.5);
  mac.fail(true); await mac.api.setUiScale(80);
  assert.equal(mac.cssVars['--ui-scale'], '1.5');
  assert.equal(mac.api.titlebarPxPerClientPx(), 1.5);
  const win = fixture();
  await win.api.setUiScale(150);
  assert.equal(win.cssVars['--ui-scale'], '1.5');
  assert.equal(win.api.titlebarPxPerClientPx(), 1);
});
console.log(`\n${passed} interface scale tests passed.`);
