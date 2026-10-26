import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let status = { computer: true, browser: true }, fail = false;
globalThis.__controlTest = { invoke: async (name, { kind }) => {
  assert.equal(name, 'get_tool_control');
  if (fail) throw Error('unavailable');
  return { ready: true, agents: [{ tool: 'claude', enabled: status[kind], conflict: false }, { tool: 'codex', enabled: true, conflict: kind === 'browser' }] };
} };
const output = await build({ stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: "export * from './src/lib/session-controls'" }, bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'boundaries', setup(b) {
  b.onResolve({ filter: /^react$|^\.\.\/tauri$/ }, args => ({ path: args.path, namespace: 'test' }));
  b.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'react' ? 'export const useSyncExternalStore=(_subscribe,snapshot)=>snapshot();' : 'export const invoke=globalThis.__controlTest.invoke;' }));
} }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
assert.deepEqual(api.useSessionControls('unknown'), []);
const initial = await api.readLaunchControls('claude');
assert.deepEqual(initial, ['computer', 'browser']);
api.setSessionControls('one', 'g1', initial);
status = { computer: false, browser: false };
assert.deepEqual(api.useSessionControls('one'), ['computer', 'browser'], 'settings changes do not retroactively enable/disable an existing session');
api.setSessionControls('two', 'g1', await api.readLaunchControls('claude'));
assert.deepEqual(api.useSessionControls('two'), []);
api.clearSessionControls('one', 'other'); assert.deepEqual(api.useSessionControls('one'), initial, 'old generation cleanup cannot clear a current session');
api.clearSessionControls('one', 'g1'); assert.deepEqual(api.useSessionControls('one'), []);
assert.deepEqual(await api.readLaunchControls('codex'), ['computer'], 'conflicts do not advertise capabilities');
assert.deepEqual(await api.readLaunchControls('remote'), []);
fail = true; assert.deepEqual(await api.readLaunchControls('claude'), [], 'failed reads never claim capability activation');
console.log('OK: launch-time capability snapshots, per-session isolation, generation cleanup, conflicts and unreadable configuration');
