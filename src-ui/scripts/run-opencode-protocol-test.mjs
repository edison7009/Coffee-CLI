import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/opencode-protocol.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} }; runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, console, Date, JSON, WeakMap });
const { emptyOpenCodeState, reduceOpenCodeEvent, openCodeRows, lastContextTokens } = module.exports;
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${name}`); }
const plain = value => JSON.parse(JSON.stringify(value));

// One real OpenCode 2.2.4 turn: the SSE events as streamed, and `/message?order=desc` read afterwards.
const { events, history } = JSON.parse(readFileSync(new URL('./fixtures/opencode-turn.json', import.meta.url), 'utf8'));
const session = events.find(e => e.data.sessionID).data.sessionID;
const live = events.reduce(reduceOpenCodeEvent, { ...emptyOpenCodeState(), ready: true, nativeId: session });
const shape = rows => plain(rows).map(row => [row.role, row.kind ?? '', row.toolName ?? '', row.toolStatus ?? '', row.content.trim(), row.outcome ?? '']);

test('live events and the history read produce the same transcript', () => {
  assert.deepEqual(shape(openCodeRows(live.native)), shape(openCodeRows([...history].reverse())));
});
test('a finished turn is idle with its reply, tool and duration', () => {
  assert.equal(live.busy, false);
  assert.equal(live.title, 'Read readme.txt contents');
  const rows = openCodeRows(live.native);
  assert.deepEqual(plain(rows.map(r => r.kind ?? r.role)), ['user', 'tool', 'assistant', 'idle']);
  assert.equal(rows[1].toolName, 'read');
  assert.match(rows[1].title, /readme\.txt/);
  assert.equal(rows[2].content, 'The readme.txt file contains the single word: hello.');
  assert.ok(rows[3].durationMs > 0);
  assert.equal(live.contextTokens, 135 + 13 + 8064);
  assert.equal(lastContextTokens(live.native), live.contextTokens);
});
test('a running turn streams text and keeps tools running until they settle', () => {
  const index = events.findIndex(e => e.type === 'session.tool.called');
  const mid = events.slice(0, index + 1).reduce(reduceOpenCodeEvent, { ...emptyOpenCodeState(), ready: true, nativeId: session });
  assert.equal(mid.busy, true);
  const tool = openCodeRows(mid.native).find(r => r.role === 'tool');
  assert.equal(tool.toolStatus, 'running');
  assert.equal(tool.partial, true);
});
test('an interrupted execution closes open tools and records the outcome', () => {
  const index = events.findIndex(e => e.type === 'session.tool.called');
  let s = events.slice(0, index + 1).reduce(reduceOpenCodeEvent, { ...emptyOpenCodeState(), ready: true, nativeId: session });
  s = reduceOpenCodeEvent(s, { type: 'session.execution.interrupted', id: 'evt_stop', created: Date.now(), data: { sessionID: session, reason: 'user' } });
  const rows = openCodeRows(s.native);
  assert.equal(rows.find(r => r.role === 'tool').toolStatus, 'failed');
  assert.equal(rows.at(-1).outcome, 'interrupted');
  // A server shutdown resumes the turn later and leaves no marker.
  const shutdown = reduceOpenCodeEvent({ ...s, native: s.native.slice(0, -1) }, { type: 'session.execution.interrupted', id: 'evt_down', data: { sessionID: session, reason: 'shutdown' } });
  assert.notEqual(openCodeRows(shutdown.native).at(-1).kind, 'idle');
});
test('events of other sessions are ignored', () => {
  const other = reduceOpenCodeEvent(live, { type: 'session.text.delta', data: { sessionID: 'ses_other', assistantMessageID: 'x', delta: 'leak' } });
  assert.equal(other, live);
});
test('a sub-agent asks through the tab, and its other events stay out of the transcript', () => {
  const child = reduceOpenCodeEvent(live, { type: 'permission.asked', data: { id: 'per_2', sessionID: 'ses_child', action: 'edit' } });
  assert.equal(child.permissions[0].sessionID, 'ses_child');
  assert.equal(reduceOpenCodeEvent(live, { type: 'session.renamed', data: { sessionID: 'ses_child', title: 'Other' } }), live);
});
test('permissions and forms queue until replied or the turn ends', () => {
  let s = reduceOpenCodeEvent(live, { type: 'permission.asked', data: { id: 'per_1', sessionID: session, action: 'read', resources: ['.env'], save: ['*'] } });
  s = reduceOpenCodeEvent(s, { type: 'form.created', data: { form: { id: 'frm_1', sessionID: session, title: 'Questions', fields: [{ key: 'q0', type: 'string', options: [{ value: 'Red', label: 'Red' }] }] } } });
  s = reduceOpenCodeEvent(s, { type: 'permission.asked', data: { id: 'per_1', sessionID: session, action: 'read' } });
  assert.equal(s.permissions.length, 1); assert.equal(s.forms.length, 1);
  s = reduceOpenCodeEvent(s, { type: 'permission.replied', data: { sessionID: session, requestID: 'per_1', reply: 'once' } });
  s = reduceOpenCodeEvent(s, { type: 'form.replied', data: { id: 'frm_1', sessionID: session, answer: { q0: 'Red' } } });
  assert.equal(s.permissions.length + s.forms.length, 0);
});
test('a prompt steered into a running turn waits in the inbox, then joins the transcript in order', () => {
  let s = reduceOpenCodeEvent(live, { type: 'session.inbox.enqueued', created: 10, data: { sessionID: session, inboxID: 'msg_steer', item: { type: 'user', payload: { text: 'Also check README' } } } });
  assert.equal(openCodeRows(s.native).at(-1).pending, true);
  s = reduceOpenCodeEvent(s, { type: 'session.step.started', created: 11, data: { sessionID: session, assistantMessageID: 'msg_a3', agent: 'build', model: {} } });
  s = reduceOpenCodeEvent(s, { type: 'session.inbox.delivered', created: 12, data: { sessionID: session, inboxID: 'msg_steer' } });
  const native = s.native.map(m => m.id);
  assert.equal(native.at(-1), 'msg_steer');
  assert.equal(s.native.at(-1).pending, false);
  const cancelled = reduceOpenCodeEvent(s, { type: 'session.inbox.cancelled', data: { sessionID: session, inboxID: 'msg_steer' } });
  assert.ok(!cancelled.native.some(m => m.id === 'msg_steer'));
});
test('empty reasoning blocks and provider errors render as expected', () => {
  const rows = openCodeRows([{ id: 'msg_a', type: 'assistant', time: { created: 1, completed: 2 }, content: [{ type: 'reasoning', text: '' }], error: { type: 'provider.auth', message: 'Invalid API key' } }]);
  assert.deepEqual(plain(rows.map(r => [r.role, r.kind, r.content])), [['assistant', 'notice', 'Invalid API key']]);
});
test('the process exit ends the session with its detail', () => {
  const s = reduceOpenCodeEvent({ ...live, busy: true }, { type: 'coffee.exit', data: { code: 1, detail: 'boom\n' } });
  assert.equal(s.ready, false); assert.equal(s.busy, false); assert.equal(s.error, 'boom');
});
console.log(`${passed} OpenCode protocol tests passed`);
