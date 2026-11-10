import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/lib/claude-session.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'native-fixture', setup(b) {
    b.onResolve({ filter: /(?:^react$|\/tauri$|^@tauri-apps\/api\/event$)/ }, args => ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'react' ? 'export function useSyncExternalStore() {}' : args.path.includes('/event') ? 'export async function listen() { return () => {}; }' : 'export const invoke = globalThis.nativeInvoke;' }));
  } }],
});

for (const closeDuringStartup of [false, true]) {
  const calls = [];
  let resumeStart;
  const startGate = new Promise(resolve => { resumeStart = resolve; });
  const nativeInvoke = async (name, args) => {
    calls.push({ name, ...args });
    if (name === 'get_tool_control') return { ready: false, agents: [] };
    if (name === 'claude_session_start') {
      if (args.id === 'new') await startGate;
      const timestamp = new Date(Date.now() - 180 * 60_000).toISOString();
      const history = [
        { type: 'user', uuid: 'user', timestamp, message: { content: 'Earlier question' } },
        { type: 'assistant', uuid: 'answer', timestamp, message: { id: 'message', content: [{ type: 'text', text: 'Earlier answer' }], usage: { input_tokens: 200000 } } },
      ];
      return { sessionId: randomUUID(), initialization: {}, history: { data: args.id === 'old' ? history.map(row => JSON.stringify(row)).join('\n') : '', cursor: 0 } };
    }
    if (name === 'claude_session_control') return { applied: {}, effective: {} };
  };
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, nativeInvoke, crypto: { randomUUID }, setTimeout, clearTimeout });
  const api = module.exports, releaseOld = api.retainClaudeSession('old', 'D:/Test');
  await tick();
  assert.equal(api.getClaudeSession('old').ready, true);
  assert.equal(await api.sendClaudeInteractive('old', 'Held prompt'), true);
  assert.equal(api.getClaudeSession('old').coldReturn.prompt, 'Held prompt');
  assert.equal(api.continueClaudeInNewConversation('old', 'new'), true);
  const releaseNew = api.retainClaudeSession('new', 'D:/Test');
  await tick();
  assert.ok(calls.some(call => call.name === 'claude_session_start' && call.id === 'new'));
  if (closeDuringStartup) releaseNew();
  resumeStart();
  await tick();
  assert.deepEqual(calls.filter(call => call.name === 'claude_session_send').map(call => call.text), closeDuringStartup ? [] : ['Held prompt'], 'a held prompt is forwarded only while the new conversation is still open');
  if (!closeDuringStartup) releaseNew();
  releaseOld();
}
console.log('OK: held continuation forwards once; closing during startup never submits a task');
