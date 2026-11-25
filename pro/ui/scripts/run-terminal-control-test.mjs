import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../src/lib/terminal-control.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'control-only-sentinel', setup(builder) {
    builder.onLoad({ filter: /[/\\]agent-sentinel\.ts$/ }, () => ({ loader: 'js', contents: 'export function markSentinelSubmission() {} export function cancelSentinelSubmission() {} export function markSentinelInterrupt() {}' }));
  } }],
});
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`  ok  ${name}`); }
function fixture() {
  const writes = [];
  let failure;
  let failAfter;
  let invokeCount = 0;
  let enterGate;
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, console, setTimeout, clearTimeout,
    window: { __TAURI_INTERNALS__: { invoke: async (command, args) => {
      assert.equal(command, 'tier_terminal_input');
      writes.push(args);
      invokeCount++;
      if (failure) throw new Error(failure);
      if (failAfter !== undefined && invokeCount > failAfter) throw new Error('chunk write lost');
      if (args.data === '\r' && enterGate) await enterGate;
    } } },
  });
  const api = module.exports;
  let submitted = 0;
  const term = { modes: { applicationCursorKeysMode: false, bracketedPasteMode: true } };
  const dispose = api.registerTerminalControl('target', term, () => submitted++);
  return { api, writes, term, dispose, setFailure: value => { failure = value; }, setFailAfter: value => { failAfter = value; }, holdEnter: () => { let release; enterGate = new Promise(resolve => { release = resolve; }); return release; }, get submitted() { return submitted; } };
}
await test('does not send before PTY startup or after exit', async () => {
  const f = fixture();
  await assert.rejects(f.api.submitTerminalPrompt('target', '任务'), /尚未启动/);
  f.api.setTerminalControlReady('target', true);
  f.api.setTerminalControlReady('target', false);
  await assert.rejects(f.api.submitTerminalPrompt('target', '任务'), /进程已退出/);
  assert.equal(f.writes.length, 0);
});
await test('uses xterm bracketed paste, acknowledged write and separate Enter for one explicit target', async () => {
  const f = fixture(); f.api.setTerminalControlReady('target', true);
  await f.api.submitTerminalPrompt('target', '中文\r\n第二行');
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[0].sessionId, 'target');
  assert.equal(f.writes[0].data, '\x1b[200~中文\r第二行\x1b[201~');
  assert.equal(f.writes[1].data, '\r');
  assert.equal(f.submitted, 1);
});
await test('write error rejects and never sends Enter or reports submitted', async () => {
  const f = fixture(); f.api.setTerminalControlReady('target', true); f.setFailure('PTY gone');
  await assert.rejects(f.api.submitTerminalPrompt('target', '任务'), /PTY gone/);
  assert.equal(f.writes.length, 1);
  assert.equal(f.submitted, 0);
  assert.equal(f.api.terminalControlStatus('target').localInputPending, true);
});
await test('local unfinished input blocks remote paste and accidental Enter', async () => {
  const f = fixture(); f.api.setTerminalControlReady('target', true);
  await f.api.forwardTerminalInput('target', 'unsent');
  await assert.rejects(f.api.submitTerminalPrompt('target', 'remote'), /本地未提交/);
  await assert.rejects(f.api.sendTerminalKey('target', 'Enter', () => true), /本地未提交/);
  assert.equal(f.writes.length, 1);
  await f.api.sendTerminalKey('target', 'CtrlC', () => true);
  assert.equal(f.api.terminalControlStatus('target').localInputPending, false);
});
await test('a local multiline bracketed paste is unsent input, despite embedded newlines', async () => {
  const f = fixture(); f.api.setTerminalControlReady('target', true);
  await f.api.forwardTerminalInput('target', '\x1b[200~first\rsecond\x1b[201~');
  await assert.rejects(f.api.submitTerminalPrompt('target', 'remote'), /本地未提交/);
  assert.equal(f.writes.length, 1);
});
await test('local history navigation protects recalled input in normal and application cursor modes', async () => {
  for (const key of ['\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB', '\x1b[1;5A']) {
    const f = fixture(); f.api.setTerminalControlReady('target', true);
    await f.api.forwardTerminalInput('target', key);
    await assert.rejects(f.api.submitTerminalPrompt('target', 'remote'), /本地未提交/);
    await assert.rejects(f.api.sendTerminalKey('target', 'Enter', () => true), /本地未提交/);
    assert.equal(f.writes.length, 1);
    await f.api.forwardTerminalInput('target', '\x03');
    assert.equal(f.api.terminalControlStatus('target').localInputPending, false);
  }
});
await test('modified Enter is unsent local editing input, not an Enter submission', async () => {
  for (const data of ['\x1b[13;2u', '\x1b[13;5u', '\x1b[27;2;13~', '\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_']) {
    const f = fixture(); f.api.setTerminalControlReady('target', true);
    await f.api.forwardTerminalInput('target', data, true);
    assert.equal(f.api.isTerminalSubmitInput('target', data), false);
    assert.equal(f.api.terminalControlStatus('target').localInputPending, true);
    await assert.rejects(f.api.submitTerminalPrompt('target', 'remote'), /本地未提交/);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].data, data);
    assert.equal(f.submitted, 0);
  }
});
await test('local takeover during paste delay leaves pasted text unsubmitted', async () => {
  const f = fixture(); f.api.setTerminalControlReady('target', true);
  const operation = f.api.submitTerminalPrompt('target', 'remote');
  await f.api.forwardTerminalInput('target', 'local');
  await assert.rejects(operation, /检测到本地输入/);
  assert.equal(f.writes.some(write => write.data === '\r'), false);
  assert.equal(f.submitted, 0);
});
await test('typing while Enter acknowledgement is pending remains a protected local draft', async () => {
  const f = fixture(); f.api.setTerminalControlReady('target', true);
  const release = f.holdEnter();
  const operation = f.api.submitTerminalPrompt('target', 'remote');
  while (f.writes.length < 2) await new Promise(resolve => setTimeout(resolve, 10));
  const typing = f.api.forwardTerminalInput('target', 'new-local-draft');
  assert.equal(f.api.terminalControlStatus('target').localInputPending, true, 'protect input immediately, before the ordered pipe write completes');
  assert.equal(f.writes.length, 2, 'local text queues behind the pending Enter acknowledgement');
  release(); await Promise.all([operation, typing]);
  assert.equal(f.api.terminalControlStatus('target').localInputPending, true);
  await assert.rejects(f.api.submitTerminalPrompt('target', 'next-remote'), /本地未提交/);
});
await test('cancellation and replacement before delayed Enter cannot write to a new lifecycle', async () => {
  const f = fixture(); f.api.setTerminalControlReady('target', true);
  let valid = true;
  const operation = f.api.submitTerminalPrompt('target', 'remote', () => valid);
  valid = false;
  await assert.rejects(operation, /已关闭或改变/);
  assert.equal(f.writes.length, 1);
  await f.api.forwardTerminalInput('target', '\x03');
  const replacement = f.api.submitTerminalPrompt('target', 'old');
  f.api.registerTerminalControl('target', f.term, () => {});
  f.api.setTerminalControlReady('target', true);
  f.dispose();
  await assert.rejects(replacement, /已关闭或改变/);
  assert.equal(f.api.terminalControlStatus('target').ready, true);
});
await test('uses TUI application cursor mode and rejects arbitrary control sequences', async () => {
  const f = fixture(); f.api.setTerminalControlReady('target', true); f.term.modes.applicationCursorKeysMode = true;
  await f.api.sendTerminalKey('target', 'Down', () => true);
  assert.equal(f.writes[0].data, '\x1bOB');
  await assert.rejects(f.api.sendTerminalKey('target', '\x1b[3~', () => true), /不支持/);
  assert.equal(f.writes.length, 1);
});
await test('large paste splits into ordered chunks under one bracketed pair before Enter (issue #127)', async () => {
  const f = fixture(); f.api.setTerminalControlReady('target', true);
  const text = 'a'.repeat(2048 * 2 + 10);
  await f.api.submitTerminalPrompt('target', text);
  assert.equal(f.writes.length, 4);
  assert.equal(f.writes[0].data, `\x1b[200~${text.slice(0, 2048)}`);
  assert.equal(f.writes[1].data, text.slice(2048, 4096));
  assert.equal(f.writes[2].data, `${text.slice(4096)}\x1b[201~`);
  assert.equal(f.writes[3].data, '\r');
  assert.equal(f.submitted, 1);
  assert.equal(f.api.terminalControlStatus('target').localInputPending, false);
});
await test('paste chunking never splits a UTF-16 surrogate pair', async () => {
  const f = fixture(); f.api.setTerminalControlReady('target', true);
  const text = 'x'.repeat(2047) + '😀' + 'y'.repeat(5000);
  await f.api.submitTerminalPrompt('target', text);
  const first = f.writes[0].data.slice('\x1b[200~'.length);
  const tail = first.charCodeAt(first.length - 1);
  assert.ok(!(tail >= 0xd800 && tail <= 0xdbff), 'high surrogate must not end a chunk');
  assert.ok(f.writes[1].data.startsWith('😀'), 'surrogate pair must open the next chunk');
  const body = f.writes.slice(0, -1).map(write => write.data.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '')).join('');
  assert.equal(body, text);
});
await test('lost chunk mid-paste marks dirty and never sends Enter (issue #127)', async () => {
  const f = fixture(); f.api.setTerminalControlReady('target', true);
  f.setFailAfter(1);
  await assert.rejects(f.api.submitTerminalPrompt('target', 'a'.repeat(2048 * 2 + 10)), /chunk write lost/);
  assert.ok(f.writes.length < 4);
  assert.ok(!f.writes.some(write => write.data === '\r'), 'Enter must not follow a truncated paste');
  assert.equal(f.submitted, 0);
  assert.equal(f.api.terminalControlStatus('target').localInputPending, true);
});
console.log(`\n${passed} terminal control tests passed.`);
