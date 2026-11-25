import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/pi-protocol.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} }; runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, console, Date, JSON });
const { emptyPiState, reducePiEvent, restorePiMessages, piStats, cacheHitRate, piToolInput } = module.exports;
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok ${name}`); }
const plain = value => JSON.parse(JSON.stringify(value));

// One real Pi 1.5.0 RPC run: write a file, edit it, run a command, reply. Events as streamed,
// `get_messages` and `get_session_stats` read afterwards.
const { events, history, stats } = JSON.parse(readFileSync(new URL('./fixtures/pi-turn.json', import.meta.url), 'utf8'));
const base = { ...emptyPiState(), ready: true, sessionId: 's' };
const live = events.reduce(reducePiEvent, base);
const restored = restorePiMessages(history, base);
const shape = rows => plain(rows).map(row => [row.role, row.toolName ?? '', row.toolStatus ?? '', row.content.trim(), row.input ?? null, (row.output ?? '').trim()]);

test('live events and the history read produce the same transcript', () => {
  assert.deepEqual(shape(live.messages), shape(restored.messages));
});
test('a settled run is idle with its user prompt, three tools and the reply', () => {
  assert.equal(live.busy, false);
  assert.equal(live.interrupted, false);
  assert.ok(live.startedAt && live.endedAt >= live.startedAt);
  const rows = live.messages;
  assert.equal(rows[0].role, 'user');
  assert.deepEqual(plain(rows.filter(r => r.role === 'tool').map(r => [r.toolName, r.toolStatus])), [['Write', 'done'], ['Edit', 'done'], ['Bash', 'done']]);
  assert.equal(rows.at(-1).role, 'assistant');
  assert.ok(rows.every(r => !r.partial));
  assert.deepEqual(plain(live.streams), {});
});
test('the edit renders as a diff and the command shows its output', () => {
  const edit = live.messages.find(r => r.toolName === 'Edit');
  assert.equal(edit.input.file_path, 'hello.txt');
  assert.match(edit.input.old_string, /beta/);
  assert.match(edit.input.new_string, /gamma/);
  const bash = live.messages.find(r => r.toolName === 'Bash');
  assert.equal(bash.input.command, 'cat hello.txt');
  assert.equal(bash.output.trim(), 'alpha\ngamma');
  const write = live.messages.find(r => r.toolName === 'Write');
  assert.equal(write.input.content.trim(), 'alpha\nbeta');
});
test('streamed tool arguments show while they arrive', () => {
  const start = events.findIndex(e => e.assistantMessageEvent?.type === 'toolcall_start');
  const end = events.findIndex((e, i) => i > start && e.assistantMessageEvent?.type === 'toolcall_end');
  const mid = events.slice(0, Math.floor((start + end) / 2) + 1).reduce(reducePiEvent, base);
  assert.equal(mid.busy, true);
  const tool = mid.messages.find(r => r.role === 'tool');
  assert.equal(tool.toolName, 'Write');
  assert.equal(tool.toolStatus, 'running');
  assert.equal(Object.keys(mid.streams).length, 1);
});
test('streamed text is partial until its block ends', () => {
  const first = events.findIndex(e => e.assistantMessageEvent?.type === 'text_delta');
  const mid = events.slice(0, first + 1).reduce(reducePiEvent, base);
  const text = mid.messages.find(r => r.role === 'assistant');
  assert.equal(text.partial, true);
  assert.ok(text.content.length > 0);
});
test('statistics give context use and the cache hit rate', () => {
  const s = piStats(stats, base.stats);
  assert.equal(s.contextWindow, 128000);
  assert.ok(s.contextTokens > 0);
  const rate = cacheHitRate(s);
  assert.ok(rate >= 0 && rate <= 1);
  assert.equal(cacheHitRate(base.stats), undefined);
  assert.equal(cacheHitRate({ ...base.stats, input: 25, cacheRead: 75 }), 0.75);
  assert.equal(piStats({ tokens: {}, contextUsage: { tokens: null, contextWindow: 1000 } }, { ...base.stats, contextTokens: 5 }).contextTokens, null, 'after compaction the size is unknown');
});
test('an aborted run marks unfinished tools interrupted', () => {
  let s = reducePiEvent(base, { type: 'agent_start' });
  s = reducePiEvent(s, { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'sleep 9' } });
  s = reducePiEvent(s, { type: 'tool_execution_update', toolCallId: 't1', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'partial' }] } });
  assert.equal(s.messages[0].output, 'partial');
  s = reducePiEvent(s, { type: 'agent_settled', aborted: true });
  assert.equal(s.busy, false);
  assert.equal(s.interrupted, true);
  assert.deepEqual(plain([s.messages[0].toolStatus, s.messages[0].interrupted]), ['failed', true]);
});
test('extension dialogs wait for an answer; notifications become notices', () => {
  let s = reducePiEvent(base, { type: 'extension_ui_request', id: 'd1', method: 'confirm', title: 'Allow rm?', message: 'rm -rf build' });
  s = reducePiEvent(s, { type: 'extension_ui_request', id: 'd2', method: 'select', title: 'Pick', options: ['a', 'b'] });
  assert.deepEqual(plain(s.requests.map(r => [r.id, r.method, r.options])), [['d1', 'confirm', []], ['d2', 'select', ['a', 'b']]]);
  s = reducePiEvent(s, { type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'Saved', notifyType: 'info' });
  assert.deepEqual(plain(s.messages.map(r => [r.role, r.content])), [['notice', 'Saved']]);
  assert.equal(reducePiEvent(s, { type: 'extension_ui_request', id: 'w', method: 'setWidget' }), s, 'unsupported methods change nothing');
});
test('a compaction between runs ends busy; one inside a run does not', () => {
  let idle = reducePiEvent(base, { type: 'compaction_start', reason: 'manual' });
  assert.deepEqual(plain([idle.busy, idle.status]), [true, 'compacting']);
  idle = reducePiEvent(idle, { type: 'compaction_end', reason: 'manual', result: { summary: 'x' } });
  assert.deepEqual(plain([idle.busy, idle.status, idle.messages.at(-1).content]), [false, 'working', 'compacted']);
  let run = reducePiEvent(reducePiEvent(base, { type: 'agent_start' }), { type: 'compaction_start', reason: 'threshold' });
  run = reducePiEvent(run, { type: 'compaction_end', reason: 'threshold', result: { summary: 'x' } });
  assert.equal(run.busy, true);
});
test('retries report their attempt and a final failure', () => {
  let s = reducePiEvent(base, { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529' });
  assert.deepEqual(plain([s.status, s.retry.attempt, s.retry.maxAttempts]), ['retrying', 1, 3]);
  s = reducePiEvent(s, { type: 'auto_retry_end', success: false, attempt: 3, finalError: 'overloaded' });
  assert.deepEqual(plain([s.status, s.messages.at(-1).content, s.messages.at(-1).toolStatus]), ['working', 'overloaded', 'failed']);
});
test('multiple replacements in one edit stack into one diff', () => {
  const { toolName, input } = piToolInput('edit', { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }, { oldText: 'p', newText: 'q' }] });
  assert.equal(toolName, 'Edit');
  assert.deepEqual(plain(input), { file_path: 'a.ts', old_string: 'x\np', new_string: 'y\nq' });
  assert.equal(piToolInput('mcp_tool', { a: 1 }).toolName, 'mcp_tool');
});
test('the process exiting ends the session with its stderr', () => {
  const s = reducePiEvent({ ...base, busy: true, requests: [{ id: 'd' }] }, { type: 'coffee_exit', code: 1, detail: 'boom\n' });
  assert.deepEqual(plain([s.ready, s.busy, s.requests.length, s.error]), [false, false, 0, 'boom']);
});
test('every run keeps its time, tokens and Pi\'s cost on its last row', () => {
  const reply = (at, input, output, cost) => ({ role: 'assistant', timestamp: at, model: 'claude-x', content: [{ type: 'text', text: `at ${at}` }], usage: { input, output, cacheRead: 1, cacheWrite: 0, totalTokens: input + output + 1, cost: { total: cost } } });
  const restored = restorePiMessages([
    { role: 'user', timestamp: 1000, content: 'one' }, reply(2000, 10, 2, 0.01), reply(3000, 5, 1, 0.02),
    { role: 'user', timestamp: 5000, content: 'two' }, reply(7000, 3, 3, 0.005),
  ], emptyPiState());
  const stats = restored.messages.filter(m => m.turnStats).map(m => [m.turnStats.durationMs, m.turnStats.usage.input, m.turnStats.cost]);
  assert.deepEqual(plain(stats), [[2000, 15, 0.03], [2000, 3, 0.005]]);
  let s = { ...emptyPiState(), messages: [] };
  s = reducePiEvent(s, { type: 'agent_start' });
  s = reducePiEvent(s, { type: 'message_end', message: reply(Date.now(), 4, 4, 0.004) });
  s = reducePiEvent(s, { type: 'agent_settled' });
  assert.equal(s.messages.at(-1).turnStats.cost, 0.004, 'a live run takes its totals when it settles');
});

console.log(`${passed} Pi protocol tests passed`);
