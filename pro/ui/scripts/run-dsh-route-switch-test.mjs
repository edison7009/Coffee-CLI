import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Model and effort switches restart the DeepSeek Harness runtime. A switch requested while another
// restart runs must not be dropped: it waits, and only the latest request is applied.
const root = fileURLToPath(new URL('../', import.meta.url));
const compiled = await build({
  entryPoints: [`${root}src/lib/dsh-session.ts`], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'dsh-route-fixtures', setup(b) {
    b.onResolve({ filter: /^(?:react|\.\.\/tauri|\.\/session-replies|@tauri-apps\/api\/event)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: {
      react: 'export const useSyncExternalStore = (_subscribe, snapshot) => snapshot();',
      '../tauri': 'export const invoke = (...args) => globalThis.invokeFixture(...args);',
      './session-replies': 'export function recordSessionReply() {}',
      '@tauri-apps/api/event': 'export async function listen() { return () => {}; }',
    }[args.path] }));
  } }],
});

const starts = [];
globalThis.invokeFixture = (command, args) => {
  if (command === 'dsh_session_close') return Promise.resolve();
  if (command !== 'dsh_session_start') throw new Error(`Unexpected IPC ${command}`);
  return new Promise(resolve => starts.push({ route: args.route, finish: () => resolve({ sessionId: 's1', route: args.route ?? { provider: 'deepseek-account', model: 'deepseek-flash', effort: 'high' }, models: [] }) }));
};
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const tick = () => new Promise(resolve => setImmediate(resolve));
const effort = () => api.useDshSession('tab').route.effort;

api.retainDshSession('tab', '/project');
await tick(); starts.shift().finish(); await tick();
assert.equal(effort(), 'high');

const route = level => ({ provider: 'deepseek-account', model: 'deepseek-flash', effort: level });
const first = api.setDshRoute('tab', route('low'));
await tick();
assert.equal(starts.length, 1, 'the first switch restarts the runtime');
const second = api.setDshRoute('tab', route('high')), third = api.setDshRoute('tab', route('max'));
await tick();
assert.equal(starts.length, 1, 'later switches wait for the running restart');
starts.shift().finish(); await first;
await tick(); await tick();
assert.equal(starts.length, 1, 'one more restart follows');
assert.equal(starts[0].route.effort, 'max', 'only the latest waiting switch is applied');
starts.shift().finish(); await Promise.all([second, third]);
assert.equal(effort(), 'max', 'the session ends on the latest choice');
assert.equal(starts.length, 0, 'the skipped intermediate switch never restarts the runtime');

// An effort change during a model switch builds on the model being switched to, not the one on screen.
const model = api.setDshRoute('tab', { provider: 'deepseek-account', model: 'deepseek-v4-pro', effort: 'max' });
await tick();
assert.equal(api.useDshSession('tab').route.model, 'deepseek-flash', 'the screen still shows the previous model while it restarts');
const effortChange = api.setDshEffort('tab', 'low');
starts.shift().finish(); await model;
await tick(); await tick();
assert.deepEqual(starts[0].route, { provider: 'deepseek-account', model: 'deepseek-v4-pro', effort: 'low' }, 'the queued effort keeps the new model');
starts.shift().finish(); await effortChange;
assert.deepEqual(api.useDshSession('tab').route, { provider: 'deepseek-account', model: 'deepseek-v4-pro', effort: 'low' });
console.log('OK: DeepSeek Harness route switches during a restart wait and apply only the latest choice; effort changes keep a pending model switch');
