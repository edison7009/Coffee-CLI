// Actual session stores with deterministic native startup failures and timers.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

for (const provider of ['claude', 'codex']) {
  const calls = [], timers = new Map(); let listener, timerId = 0;
  const start = `${provider}_session_start`, close = `${provider}_session_close`;
  const bridge = {
    listen: async (_name, fn) => { listener = fn; return () => {}; },
    invoke: async (name, args) => {
      calls.push({ name, ...args });
      if (name !== start) return {};
      const attempt = calls.filter(c => c.name === start && c.id === args.id).length;
      if (args.id === 'permanent' || attempt === 1 && args.id !== 'exit') throw new Error('Startup unavailable');
      if (args.id === 'exit' && attempt === 1) listener({ payload: { id: args.id, generation: args.generation, event: provider === 'claude' ? { type: 'coffee_exit', code: 1, detail: 'Early exit' } : { method: 'coffee/exit', params: { code: 1, detail: 'Early exit' } } } });
      return provider === 'claude' ? { sessionId: 'native', initialization: {}, history: { data: '', cursor: 0 } } : { thread: { id: 'native', turns: [] } };
    },
  };
  const result = await build({ entryPoints: [`src/lib/${provider}-session.ts`], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'native-boundary', setup(b) {
      b.onResolve({ filter: /^react$|\/tauri$|^@tauri-apps\/api\/event$/ }, args => ({ path: args.path, namespace: 'mock' }));
      b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: args.path === 'react' ? 'export function useSyncExternalStore(_subscribe,snapshot){return snapshot()}' : args.path.includes('/event') ? 'export const listen=globalThis.bridge.listen' : 'export const invoke=globalThis.bridge.invoke' }));
    } }],
  });
  const module = { exports: {} };
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, bridge, crypto: { randomUUID }, console,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
  });
  const api = module.exports, cap = provider[0].toUpperCase() + provider.slice(1);
  const retain = api[`retain${cap}Session`], state = id => (api.getClaudeSession ?? api.useCodexSession)(id);
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const advance = async delay => { const timer = [...timers].find(([, t]) => t.delay === delay); assert.ok(timer, `${provider}: ${delay}ms timer exists`); timers.delete(timer[0]); timer[1].fn(); await flush(); };

  let release = retain('transient', 'D:/Test', 'saved-thread'); await flush();
  assert.equal(state('transient').error, undefined, 'transient startup errors stay quiet');
  await advance(1000);
  assert.equal(state('transient').ready, true);
  const attempts = calls.filter(c => c.name === start && c.id === 'transient');
  assert.equal(attempts.length, 2); assert.equal(attempts[1].resumeToken, 'saved-thread');
  assert.notEqual(attempts[0].generation, attempts[1].generation);
  listener({ payload: { id: 'transient', generation: attempts[0].generation, event: provider === 'claude' ? { type: 'coffee_exit', code: 1 } : { method: 'coffee/exit', params: { code: 1 } } } });
  assert.equal(state('transient').ready, true, 'stale exits cannot terminate the replacement');
  release(); await advance(300);

  release = retain('closed', null); await flush(); release(); await advance(300); await advance(1000);
  assert.equal(calls.filter(c => c.name === start && c.id === 'closed').length, 1, 'closed tabs do not reconnect');

  release = retain('exit', null); await flush();
  assert.equal(state('exit').ready, false, 'a process that exits during initialization is never marked ready');
  assert.equal(state('exit').error, undefined);
  await advance(1000); assert.equal(state('exit').ready, true);
  release(); await advance(300);

  release = retain('permanent', null); await flush(); await advance(1000);
  assert.equal(state('permanent').error, undefined);
  await advance(2000); assert.match(state('permanent').error, /Startup unavailable/);
  assert.equal(calls.filter(c => c.name === start && c.id === 'permanent').length, 3, 'persistent errors do not loop indefinitely');
  assert.equal(calls.some(c => c.name.endsWith('_send') || c.method === 'turn/start'), false, 'reconnection never resends a prompt');
  release(); await advance(300);
  assert.ok(calls.some(c => c.name === close));
  console.log(`ok ${provider}: quiet startup retries, saved thread, stale exits, closed tabs, early exit and bounded failure`);
}
