import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/dsh-protocol.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} }; runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, console, Date, JSON });
const { emptyDshState, reduceDshEvent, reduceDshNotification, restoreDshLog, dshToolMessage, dshToolCard } = module.exports;
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

test('tool calls render as the shared tool card: commands, requested and applied edits', () => {
  const call = (id, name, args) => ({ type: 'tool/call', seq: 1, time: 5, data: { turn: 1, callId: id, name, arguments: JSON.stringify(args) } });
  const result = (id, extra) => ({ type: 'tool/result', seq: 2, time: 6, data: { turn: 1, message: { role: 'tool', toolCallId: id, content: [{ type: 'text', text: 'ok' }], isError: false }, ...extra } });
  let s = emptyDshState();
  for (const event of [
    call('b', 'bash', { command: 'df -h', description: 'Check disk' }),
    call('e', 'edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }),
    call('p', 'apply_patch', { patch: '*** Begin Patch' }),
    result('b'),
    result('p', { meta: { diffs: [{ path: '/r/c.ts', oldText: 'x', newText: 'y' }] } }),
  ]) s = reduceDshEvent(s, event);
  const tool = id => dshToolMessage(s.messages.find(m => m.id === `tool:${id}`));
  const bash = tool('b');
  assert.equal(bash.toolName, 'Bash'); assert.equal(bash.input.command, 'df -h'); assert.equal(bash.output, 'ok'); assert.equal(bash.toolStatus, 'done');
  const edit = tool('e');
  assert.equal(edit.toolName, 'Edit'); assert.deepEqual(plain(edit.input), { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' });
  assert.equal(edit.toolStatus, 'running'); assert.equal(edit.output, undefined, 'a running call has no output pane yet');
  const patch = tool('p');
  assert.equal(patch.toolName, 'Edit'); assert.deepEqual(plain(patch.input), { file_path: '/r/c.ts', old_string: 'x', new_string: 'y' });
  assert.equal(dshToolMessage({ id: 'x', role: 'tool', content: '', turn: 1, timestamp: 1, toolName: 'mystery', toolInput: '{"a":1}', toolStatus: 'done' }).toolName, 'mystery');
});

test('live stream frames show text, reasoning and tool arguments before the message commits', () => {
  const stream = (s, frame) => reduceDshNotification(s, { method: 'coffee/stream', params: { sessionId: 's1', frame } });
  const chunk = c => ({ type: 'chunk', chunk: c });
  let s = { ...emptyDshState(), sessionId: 's1' };
  s = reduceDshEvent(s, { type: 'user/message', seq: 1, time: 1, data: { turn: 1, id: 'u', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } });
  s = stream(s, { type: 'start' });
  s = stream(s, chunk({ type: 'reasoning-delta', index: 0, text: 'Let me ' }));
  s = stream(s, chunk({ type: 'reasoning-delta', index: 0, text: 'look' }));
  s = stream(s, chunk({ type: 'text-delta', index: 1, text: 'Checking.' }));
  s = stream(s, chunk({ type: 'tool-call-delta', index: 2, id: 'c1', name: 'bash', argumentsDelta: '{"command":"l' }));
  s = stream(s, chunk({ type: 'tool-call-delta', index: 2, id: 'c1', argumentsDelta: 's"}' }));
  assert.deepEqual(plain(s.messages.map(m => [m.role, m.content || m.toolInput])), [['user', 'hi'], ['reasoning', 'Let me look'], ['assistant', 'Checking.'], ['tool', '{"command":"ls"}']]);
  assert.equal(reduceDshNotification(s, { method: 'coffee/stream', params: { sessionId: 'other', frame: chunk({ type: 'text-delta', index: 1, text: 'x' }) } }), s, 'another session is ignored');
  assert.equal(stream(s, { type: 'end' }), s, 'the end frame alone changes nothing; it may precede the committed message');
  s = stream(s, { type: 'start' });
  assert.deepEqual(plain(s.messages.map(m => m.id)), ['user:u'], 'a retry drops what the uncommitted attempt streamed');
  s = stream(s, chunk({ type: 'text-delta', index: 0, text: 'Chec' }));
  s = stream(s, chunk({ type: 'text-delta', index: 1, text: 'stray' }));
  s = stream(s, chunk({ type: 'tool-call-delta', index: 2, id: 'c1', name: 'bash', argumentsDelta: '{"comm' }));
  s = reduceDshEvent(s, { type: 'assistant/message', seq: 5, time: 5, data: { turn: 1, message: { id: 'a1', content: [{ type: 'text', text: 'Checking.' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }] } } });
  assert.deepEqual(plain(s.messages.map(m => [m.id, m.content || m.toolInput, !!m.streaming])), [['user:u', 'hi', false], ['a1:0', 'Checking.', false], ['tool:c1', '{"command":"ls"}', false]], 'committed blocks replace live rows in place; a stray block is dropped');
  assert.equal(stream(s, { type: 'end' }).messages.length, 3, 'the committed end frame keeps everything');
  assert.equal(dshToolCard(s.messages[2]), dshToolCard(s.messages[2]), 'an unchanged row reuses its tool card');
});

test('a stopped turn keeps what it streamed, and the next turn starts clean', () => {
  const stream = (s, frame) => reduceDshNotification(s, { method: 'coffee/stream', params: { sessionId: 's1', frame } });
  const chunk = c => ({ type: 'chunk', chunk: c });
  let s = { ...emptyDshState(), sessionId: 's1' };
  s = reduceDshEvent(s, { type: 'user/message', seq: 1, time: 1, data: { turn: 2, id: 'u', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } });
  s = { ...s, messages: [...s.messages, { id: 'note', role: 'notice', content: '/plan', turn: 0, timestamp: 1, tone: 'info' }] };
  s = stream(s, { type: 'start' });
  s = stream(s, chunk({ type: 'text-delta', index: 0, text: 'Half a rep' }));
  assert.equal(s.messages.at(-1).turn, 2, 'live rows take the turn of the user message, not a trailing notice');
  s = reduceDshNotification(s, { method: 'coffee/exit', params: { code: 0 } });
  assert.ok(s.messages.some(m => m.content === 'Half a rep' && !m.streaming && !m.id.startsWith('live:')), 'the partial reply stays, settled');
  s = stream(s, { type: 'start' });
  s = stream(s, chunk({ type: 'text-delta', index: 0, text: 'New' }));
  assert.deepEqual(plain(s.messages.filter(m => m.role === 'assistant').map(m => m.content)), ['Half a rep', 'New'], 'the next attempt neither drops nor appends to it');
});

console.log(`${passed} DeepSeek Harness protocol checks passed`);
