/** Codex app-server reducer checks with `node scripts/run-codex-protocol-test.mjs`. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/codex-protocol.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} }; runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, console, Date, JSON });
const { emptyCodexState, reduceCodexEvent, codexSubTasks, restoreCodexTurns } = module.exports;
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${name}`); }
const plain = value => JSON.parse(JSON.stringify(value));

test('spawned sub-agents run until their threads go idle, and only this thread spawns them', () => {
  const event = (method, params) => ({ method, params: { threadId: 'main', turnId: 't1', ...params } });
  let s = { ...emptyCodexState(), nativeId: 'main' };
  const spawn = { id: 'c1', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', prompt: '\nReview the auth module\nthen report', receiverThreadIds: ['child-1'], agentsStates: { 'child-1': { status: 'pendingInit' } } };
  s = reduceCodexEvent(s, event('item/completed', { item: spawn }));
  assert.deepEqual(plain(codexSubTasks(s)), [{ id: 'child-1', description: 'Review the auth module' }]);
  s = reduceCodexEvent(s, { method: 'thread/status/changed', params: { threadId: 'child-1', status: { type: 'active', activeFlags: [] } } });
  assert.equal(codexSubTasks(s).length, 1);
  s = reduceCodexEvent(s, { method: 'thread/status/changed', params: { threadId: 'child-1', status: { type: 'idle' } } });
  assert.deepEqual(plain(codexSubTasks(s)), [], 'an idle sub-agent thread has finished');
  const unknown = reduceCodexEvent(s, { method: 'thread/status/changed', params: { threadId: 'stranger', status: { type: 'active' } } });
  assert.equal(unknown, s, 'another thread is ignored');
  s = reduceCodexEvent(s, event('item/completed', { item: { ...spawn, id: 'c2', receiverThreadIds: ['child-2'], agentsStates: { 'child-2': { status: 'running' } } } }));
  s = reduceCodexEvent(s, event('item/completed', { item: { id: 'w1', type: 'collabAgentToolCall', tool: 'wait', status: 'completed', receiverThreadIds: ['child-2'], agentsStates: { 'child-2': { status: 'completed' } } } }));
  assert.deepEqual(plain(codexSubTasks(s)), [], 'a wait reporting completion settles it');
  s = reduceCodexEvent(s, event('item/completed', { item: { ...spawn, id: 'c3', receiverThreadIds: ['child-3'], agentsStates: {} } }));
  assert.equal(codexSubTasks(reduceCodexEvent(s, { method: 'coffee/exit', params: { code: 0 } })).length, 0, 'an exited process runs nothing');
});

test('a turn adds up each request and keeps its totals on its status line', () => {
  const usage = (input, cached, output) => ({ method: 'thread/tokenUsage/updated', params: { threadId: 'main', tokenUsage: { last: { inputTokens: input, cachedInputTokens: cached, outputTokens: output }, total: {} } } });
  let s = { ...emptyCodexState(), nativeId: 'main', model: 'gpt-x' };
  s = reduceCodexEvent(s, { method: 'turn/started', params: { threadId: 'main', turn: { id: 't1' } } });
  s = reduceCodexEvent(s, usage(100, 60, 5));
  s = reduceCodexEvent(s, usage(50, 0, 7));
  s = reduceCodexEvent(s, { method: 'turn/completed', params: { threadId: 'main', turn: { id: 't1', status: 'completed', durationMs: 3000 } } });
  assert.deepEqual(plain(s.messages.at(-1).turnStats), { durationMs: 3000, usage: { input: 90, output: 12, cacheRead: 60, cacheWrite: 0 }, model: 'gpt-x' }, 'cached input is billed apart');
  const history = restoreCodexTurns([{ id: 'h', status: 'completed', durationMs: 4200, completedAt: 9, items: [{ id: 'a', type: 'agentMessage', text: 'done' }] }, { id: 'live', status: 'inProgress', items: [{ id: 'b', type: 'agentMessage', text: '…' }] }]);
  assert.deepEqual(plain(history.map(m => [m.id, m.turnStats?.durationMs ?? null])), [['h:a', null], ['h:status', 4200], ['live:b', null]], 'an ended turn in history keeps its duration');
});

console.log(`${passed} Codex protocol checks passed`);
