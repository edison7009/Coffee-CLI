import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/dsh-protocol.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} }; runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, console, Date, JSON });
const { emptyDshState, reduceDshEvent, reduceDshNotification, restoreDshLog } = module.exports;
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${name}`); }
const plain = value => JSON.parse(JSON.stringify(value));

// Shapes copied from a persisted DeepSeek Harness 0.2.x Session log.
const log = [
  { type: 'session', version: 4, id: 'session-1', cwd: 'D:\\repo' },
  { type: 'permission/preset', seq: 0, data: { preset: 'workspace-write' } },
  { type: 'approval/policy', seq: 2, data: { policy: 'ask' } },
  { type: 'turn/start', seq: 4, time: 100, data: { turn: 1 } },
  { type: 'user/message', seq: 8, time: 101, data: { content: [{ type: 'text', text: 'Update the repo' }], source: { kind: 'user', rpcId: 'r1' }, role: 'user', id: 'u1' } },
  { type: 'user/message', seq: 9, time: 101, data: { content: [{ type: 'text', text: 'Current runtime context.' }], source: { kind: 'runtime-context', form: 'snapshot' }, role: 'user', id: 'ctx' } },
  { type: 'request/context', seq: 13, data: { provider: 'deepseek-account', model: 'deepseek-flash', contextWindow: 1048576 } },
  { type: 'session/title', seq: 14, data: { title: 'Repo update' } },
  { type: 'assistant/message', seq: 19, time: 102, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'reasoning', text: 'Check the repo first.' }, { type: 'tool-call', id: 'call_1', name: 'pwsh', arguments: '{"command":"git pull"}' }, { type: 'tool-call', id: 'call_2', name: 'read_file', arguments: '{"path":"README.md"}' }] }, usage: { inputTokens: 800, outputTokens: 100, cacheReadTokens: 8000, cacheWriteTokens: 0, totalTokens: 8900 } } },
  { type: 'tool/call', seq: 20, data: { turn: 1, step: 1, callId: 'call_1', name: 'pwsh', arguments: '{"command":"git pull"}' } },
  { type: 'tool/result', seq: 23, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'Already up to date.' }], isError: false } } },
  { type: 'command/run', seq: 54, data: { commandId: 'cmd-1', name: 'permission', args: ' danger-full-access', source: { kind: 'user' } } },
  { type: 'command/done', seq: 59, data: { commandId: 'cmd-1', kind: 'success', text: 'preset danger-full-access' } },
  { type: 'permission/preset', seq: 60, data: { preset: 'danger-full-access' } },
  { type: 'assistant/message', seq: 70, time: 103, data: { turn: 1, step: 2, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } } },
  { type: 'turn/end', seq: 80, data: { turn: 1, reason: { kind: 'interrupted' } } },
  { type: 'model/selection', seq: 90, data: { provider: 'deepseek-account', model: 'deepseek-v4-pro', reasoningEffort: 'low' } },
  { type: 'session-log-deepseek/delivery-accepted', seq: 91, data: {} },
];

test('a persisted log restores the user-visible transcript and session facts', () => {
  const s = restoreDshLog(log);
  assert.equal(s.sessionId, 'session-1');
  assert.equal(s.title, 'Repo update');
  assert.equal(s.preset, 'danger-full-access');
  assert.equal(s.policy, 'ask');
  assert.equal(s.contextWindow, 1048576);
  assert.deepEqual(plain(s.route), { provider: 'deepseek-account', model: 'deepseek-v4-pro', effort: 'low' });
  assert.deepEqual(plain(s.messages.map(m => [m.role, m.content || m.toolName])), [
    ['user', 'Update the repo'], ['reasoning', 'Check the repo first.'], ['tool', 'Already up to date.'], ['tool', 'read_file'],
    ['notice', '/permission danger-full-access · preset danger-full-access'], ['assistant', 'Done.'], ['notice', 'interrupted'],
  ]);
  const [, , pull, read] = s.messages;
  assert.equal(pull.toolStatus, 'done');
  assert.equal(pull.toolInput, '{"command":"git pull"}');
  assert.equal(read.toolStatus, 'failed', 'an interrupted turn settles its unanswered tool calls');
  assert.equal(s.busy, false, 'history never replays live state');
  assert.equal(s.contextTokens, 0, 'history usage does not claim the live context');
});

test('live notifications drive running state, requests, and exit', () => {
  let s = { ...emptyDshState(), ready: true, sessionId: 'session-1' };
  s = reduceDshNotification(s, { method: 'session.status', params: { sessionId: 'session-1', status: 'running' } });
  assert.equal(s.busy, true); assert.ok(s.startedAt);
  s = reduceDshNotification(s, { method: 'session.event', params: { sessionId: 'other', event: { type: 'user/message', data: { content: [{ type: 'text', text: 'not mine' }], source: { kind: 'user' } } } } });
  assert.equal(s.messages.length, 0, 'events from other sessions in the runtime are ignored');
  s = reduceDshNotification(s, { method: 'session.event', params: { sessionId: 'session-1', event: { type: 'assistant/message', data: { turn: 1, message: { id: 'a', content: [{ type: 'text', text: 'Hi' }] }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 } } } } });
  assert.equal(s.messages[0].content, 'Hi'); assert.equal(s.contextTokens, 15);
  s = reduceDshNotification(s, { id: 7, method: 'approval/request', params: { sessionId: 'session-1', toolName: 'pwsh', reason: 'escalate' } });
  s = reduceDshNotification(s, { id: 8, method: 'user-question/ask', params: { requestId: 'q1', sessionId: 'session-1', questions: [] } });
  assert.equal(s.requests.length, 2);
  s = reduceDshNotification(s, { method: 'user-question.cancelled', params: { requestId: 'q1', sessionId: 'session-1' } });
  assert.deepEqual(plain(s.requests.map(r => r.id)), [7]);
  s = reduceDshNotification(s, { method: 'session.status', params: { sessionId: 'session-1', status: 'idle' } });
  assert.equal(s.busy, false); assert.equal(s.requests.length, 0); assert.equal(s.startedAt, undefined);
  const exited = reduceDshNotification(s, { method: 'coffee/exit', params: { code: 1, detail: 'boom' } });
  assert.equal(exited.ready, false); assert.equal(exited.error, 'boom');
  const restarting = reduceDshNotification({ ...s, restarting: true }, { method: 'coffee/exit', params: { code: 1, detail: 'killed' } });
  assert.equal(restarting.error, undefined, 'a deliberate stop is not an error');
});

test('unknown events leave the state untouched', () => {
  const s = emptyDshState();
  assert.equal(reduceDshEvent(s, { type: 'job/registered', data: {} }), s);
});

console.log(`${passed} DeepSeek Harness protocol checks passed`);
