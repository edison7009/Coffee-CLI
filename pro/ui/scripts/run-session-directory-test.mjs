// Real session stores; only native process transport is isolated.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const calls = [], releases = [];
globalThis.directoryBridge = {
  listen: async () => () => {},
  invoke: async (name, args) => {
    calls.push({ name, ...args });
    if (name.endsWith('_session_start')) {
      if (args.id.includes('transient')) throw 'Connection unavailable';
      const status = ['missing', 'not_directory', 'unavailable'].find(s => args.id.endsWith(`-${s}`));
      if (status) throw `COFFEE_DIRECTORY:${status}:${args.cwd}`;
      return name.startsWith('claude')
        ? { sessionId: args.id, initialization: {}, history: { data: '', cursor: 0 } }
        : { thread: { id: args.id, turns: [] }, models: [] };
    }
    return {};
  },
};
const result = await build({
  stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts', contents: `
    export * from './src/lib/claude-session';
    export * from './src/lib/codex-session';
    export * from './src/lib/session-directory';
  ` },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'native-transport', setup(builder) {
    builder.onResolve({ filter: /^react$|^\.\.\/tauri$|^@tauri-apps\/api\/event$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'react'
      ? 'export function useSyncExternalStore(_subscribe,snapshot){return snapshot()}'
      : path.includes('event') ? 'export const listen=globalThis.directoryBridge.listen'
        : 'export const invoke=globalThis.directoryBridge.invoke' }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
try {
  const cwd = 'D:\\Projects\\项目', token = 'original-session';
  for (const tool of ['claude', 'codex']) {
    const retain = tool === 'claude' ? api.retainClaudeSession : api.retainCodexSession;
    for (const status of ['missing', 'not_directory', 'unavailable', 'transient', 'available']) {
      releases.push(retain(`${tool}-${status}`, cwd, token));
    }
  }
  // Wait beyond both retry delays to prove directory errors do not retry.
  await new Promise(resolve => setTimeout(resolve, 3200));
  for (const tool of ['claude', 'codex']) {
    const snapshot = tool === 'claude' ? api.getClaudeSession : api.useCodexSession;
    for (const status of ['missing', 'not_directory', 'unavailable', 'transient', 'available']) {
      const id = `${tool}-${status}`, starts = calls.filter(c => c.name === `${tool}_session_start` && c.id === id);
      assert.equal(starts.length, status === 'transient' ? 3 : 1, `${id}: expected startup count`);
      assert.ok(starts.every(c => c.cwd === cwd && c.resumeToken === token), 'never substitute another directory or resume token');
      assert.equal(snapshot(id).ready, status === 'available');
      if (!['available', 'transient'].includes(status)) {
        assert.deepEqual(api.directoryFailure(snapshot(id).error), { status, path: cwd });
        assert.equal(calls.filter(c => c.name === `${tool}_session_close` && c.id === id).length, 0, 'no retry close/restart');
      }
    }
  }
  assert.equal(api.directoryFailure('Connection unavailable'), undefined);
  assert.equal(api.directoryFailureMessage(`COFFEE_DIRECTORY:missing:${cwd}`, k => k), `directory.missing\n${cwd}`);
  assert.equal(api.directoryFailureMessage(`COFFEE_DIRECTORY:unavailable:${cwd}`, k => k), `directory.unavailable\n${cwd}`);
  assert.ok(!calls.some(c => c.name.startsWith('tier_terminal')), 'no replacement terminal');
  console.log('OK directory failures stop immediately for both stores; transient retries, valid startup and original session identity remain intact');
} finally {
  releases.forEach(release => release());
  await new Promise(resolve => setTimeout(resolve, 350));
}
