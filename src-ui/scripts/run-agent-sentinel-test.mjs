import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiled = await build({
  stdin: { contents: 'export * from "./src/lib/agent-sentinel"; export * from "./src/lib/terminal-control"; export { reducer } from "./src/store/app-state";', resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'],
  plugins: [{ name: 'sentinel-fixtures', setup(builder) {
    builder.onLoad({ filter: /[/\\]app-state\.tsx$/ }, async ({ path }) => ({
      contents: (await readFile(path, 'utf8')).replace('function reducer(', 'export function reducer('), loader: 'tsx',
    }));
    builder.onLoad({ filter: /[/\\]terminal-observer\.ts$/ }, () => ({
      contents: 'export const getTerminalObserver = id => globalThis.__sentinelObservers.get(id);', loader: 'js',
    }));
    builder.onLoad({ filter: /[/\\]terminal-interaction\.ts$/ }, () => ({
      contents: 'export const getTerminalInteraction = id => globalThis.__sentinelInteractions.get(id);', loader: 'js',
    }));
  } }],
});
const require = createRequire(import.meta.url);
const tierSource = await readFile(new URL('../src/components/center/TierTerminal.tsx', import.meta.url), 'utf8');
const tierTree = ts.createSourceFile('TierTerminal.tsx', tierSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let forwardInputNode;
function findForwardInput(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tierTree) === 'forwardInput') forwardInputNode = node;
  ts.forEachChild(node, findForwardInput);
}
findForwardInput(tierTree);
assert.ok(forwardInputNode, 'find the actual TierTerminal input handler');
const forwardInputSource = `const ${forwardInputNode.getText(tierTree)};`;
assert.ok(forwardInputSource.includes('forwardTerminalInput'), 'extract the actual TierTerminal input handler');
const forwardInputBuild = await build({ stdin: { contents: `${forwardInputSource}\nglobalThis.__forwardInput = forwardInput;`, loader: 'ts' }, write: false });
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`  ok  ${name}`); }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture() {
  let now = 1_000, nextTimer = 0, failReport = false, enterGate, failInput;
  const timers = new Map(), observers = new Map(), interactions = new Map(), reports = [], errors = [], writes = [];
  const setTimer = (fn, delay = 0) => { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; };
  const module = { exports: {} };
  const state = { terminals: [], activeTerminalId: null };
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, require,
    console: { ...console, error: (...args) => errors.push(args) },
    setTimeout: setTimer, clearTimeout: id => timers.delete(id),
    localStorage: { setItem() {}, getItem() { return null; } },
    __sentinelObservers: observers, __sentinelInteractions: interactions,
    window: { __TAURI_INTERNALS__: { invoke: async (command, args) => {
      if (command === 'tier_terminal_input') {
        writes.push(args);
        if (failInput?.(args)) throw new Error('PTY input failed');
        if (args.data === '\r' && enterGate) await enterGate;
        return;
      }
      assert.equal(command, 'agent_sentinel_report');
      reports.push(args.report);
      if (failReport) throw new Error('delivery acknowledgement unavailable');
    } } },
  });
  const api = module.exports;
  async function advance(ms) {
    const end = now + ms;
    await flush();
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > end) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    now = end; await flush();
  }
  function observe(id, generation = `${id}:1`) {
    const config = { text: 'Tests: 4 passed. Task complete.', revision: 1, gap: false, failed: false, hasMore: false, flushState: 'flushed', startRow: 0 };
    const freshness = () => ({ gap: config.gap, failed: config.failed, flushState: config.flushState });
    const observer = {
      generation,
      readScreen: async () => ({ generation: observer.generation, lines: [{ text: config.text }], screenRevision: config.revision, bufferType: 'normal', capturedAt: now, freshness: freshness() }),
      readScrollback: async () => ({ lines: [{ text: config.text }], startRow: config.startRow, endRow: config.startRow + 1,
        availableRows: config.startRow + 1, screenRevision: config.revision, hasMore: config.hasMore, freshness: freshness() }),
    };
    observers.set(id, observer);
    return { observer, config };
  }
  function sync() { api.updateSentinelSessions(state.terminals, 'zh-CN'); }
  function add(id = 'main', tool = 'claude', cwd = 'E:\\project') {
    state.terminals.push({ id, tool, folderPath: cwd, toolTitle: `Work in ${id}`, agentStatus: 'idle' });
    const value = observe(id); sync(); return value;
  }
  function status(id, value) { Object.assign(state, api.reducer(state, { type: 'SET_AGENT_STATUS', id, status: value })); sync(); }
  function observed(id, value) {
    api.confirmTerminalAgentStatus(id);
    if (value === 'working') api.markSentinelWorking(id);
    status(id, value);
  }
  function start(id = 'main', prompt = 'Run the project tests') { api.markSentinelSubmission(id, prompt); observed(id, 'working'); }
  function control(id = 'main') {
    const context = { sessionId: id, stripRightClickMouse: data => data, forwardTerminalInput: api.forwardTerminalInput,
      isTerminalSubmitInput: api.isTerminalSubmitInput, markNotifySoundPromptSubmitted() {}, tool: 'claude',
      markAgentSubmission: () => status(id, 'working') };
    runInNewContext(forwardInputBuild.outputFiles[0].text, context);
    const term = { modes: { applicationCursorKeysMode: false }, paste: text => context.__forwardInput(`\x1b[200~${text}\x1b[201~`) };
    api.registerTerminalControl(id, term, statusConfirmed => { if (!statusConfirmed) status(id, 'working'); });
    api.setTerminalControlReady(id, true);
    return context.__forwardInput;
  }
  return { api, state, observers, interactions, reports, errors, writes, add, observe, observed, sync, status, start, control, advance,
    failReport: () => { failReport = true; }, failInput: predicate => { failInput = predicate; },
    holdEnter: () => { const gate = deferred(); enterGate = gate.promise; return gate.resolve; },
  };
}

await test('startup, pre-existing working/idle and empty Enter do not produce reports', async () => {
  const f = fixture(); f.add(); f.api.setSentinelEnabled(true);
  f.status('main', 'working'); f.status('main', 'idle');
  for (const text of ['', ' ', '\r', '\n\t']) f.api.markSentinelSubmission('main', text);
  f.status('main', 'working'); f.status('main', 'idle');
  await f.advance(60_000);
  assert.equal(f.reports.length, 0);
});

await test('each supported real tool ID reports one observed task with its directory and evidence', async () => {
  for (const tool of ['claude', 'codex', 'kimicode', 'omp']) {
    const f = fixture(); f.add('main', tool); f.api.setSentinelEnabled(true); f.start(); f.status('main', 'idle');
    await f.advance(1_200); f.sync(); await f.advance(5_000);
    assert.equal(f.reports.length, 1, tool);
    const report = f.reports[0];
    assert.equal(report.tool, tool); assert.equal(report.sessionId, 'main'); assert.equal(report.generation, 'main:1');
    assert.equal(report.cwd, 'E:\\project'); assert.equal(report.language, 'zh-CN');
    assert.equal(report.outcome, 'ended'); assert.equal(report.evidenceQuality, 'complete');
    assert.match(report.evidence, /Tests: 4 passed/); assert.ok(report.observedAt > 0);
  }
});

await test('unsupported tools and a prompt that never starts observed work do not report', async () => {
  for (const tool of ['opencode', 'muse', 'claude']) {
    const f = fixture(); f.add('main', tool); f.api.setSentinelEnabled(true);
    f.api.markSentinelSubmission('main', 'Inspect this project');
    await f.advance(50_000);
    f.status('main', 'working'); f.status('main', 'idle'); await f.advance(1_200);
    assert.equal(f.reports.length, 0, tool);
  }
});

await test('optimistic working state after submission is insufficient completion evidence', async () => {
  const f = fixture(); f.add(); f.api.setSentinelEnabled(true);
  f.api.markSentinelSubmission('main', 'Run project tests');
  f.status('main', 'working'); f.status('main', 'idle'); await f.advance(60_000);
  assert.equal(f.reports.length, 0);
});

await test('permission menus and wait_input are not task completion', async () => {
  const f = fixture(); f.add(); f.api.setSentinelEnabled(true);
  f.interactions.set('main', { kind: 'permission' }); f.api.markSentinelSubmission('main', '1');
  f.status('main', 'working'); f.status('main', 'idle'); await f.advance(1_200);
  assert.equal(f.reports.length, 0);
  f.interactions.delete('main'); f.start(); f.status('main', 'wait_input'); await f.advance(5_000);
  assert.equal(f.reports.length, 0);
  f.status('main', 'working'); f.status('main', 'idle'); await f.advance(1_200);
  assert.equal(f.reports.length, 1);
});

await test('an idle flicker followed by permissions or renewed work cancels premature reporting', async () => {
  for (const nextStatus of ['working', 'wait_input']) {
    const f = fixture(); f.add(); f.api.setSentinelEnabled(true); f.start(); f.status('main', 'idle');
    await f.advance(700); f.status('main', nextStatus); await f.advance(1_200);
    assert.equal(f.reports.length, 0, nextStatus);
    f.status('main', 'working'); f.status('main', 'idle'); await f.advance(1_200);
    assert.equal(f.reports.length, 1, nextStatus);
  }
});

await test('CtrlC and process exit preserve distinct outcomes rather than declaring success', async () => {
  for (const outcome of ['interrupted', 'exited']) {
    const f = fixture(); f.add(); f.api.setSentinelEnabled(true); f.start();
    if (outcome === 'interrupted') { f.api.markSentinelInterrupt('main'); f.status('main', 'idle'); }
    else f.api.markSentinelExit('main');
    await f.advance(1_200);
    assert.equal(f.reports.length, 1); assert.equal(f.reports[0].outcome, outcome);
  }
});

await test('local prompt input and the shared Gambit/Agent submit path arm before optimistic working status', async () => {
  for (const via of ['local', 'shared']) {
    const f = fixture(); f.add(); f.api.setSentinelEnabled(true); f.control();
    if (via === 'local') {
      await f.api.forwardTerminalInput('main', 'Run tests'); await f.api.forwardTerminalInput('main', '\r');
      f.observed('main', 'working');
    } else {
      const submit = f.api.submitTerminalPrompt('main', 'Run tests'); await f.advance(200); await submit;
    }
    f.observed('main', 'working');
    f.observed('main', 'idle'); await f.advance(1_200);
    assert.equal(f.reports.length, 1, via);
  }
});

await test('empty local Enter does not arm and acknowledged CtrlC marks the active task', async () => {
  const f = fixture(); f.add(); f.api.setSentinelEnabled(true); f.control();
  await f.api.forwardTerminalInput('main', '\r'); f.status('main', 'working'); f.status('main', 'idle'); await f.advance(1_200);
  assert.equal(f.reports.length, 0);
  f.start(); await f.api.sendTerminalKey('main', 'CtrlC', () => true); f.status('main', 'idle'); await f.advance(1_200);
  assert.equal(f.reports.length, 1); assert.equal(f.reports[0].outcome, 'interrupted');
});

await test('recalled history prompts arm only when the CLI really starts work', async () => {
  for (const key of ['\x1b[A', '\x1b[B', '\x1bOA', '\x1bOB']) {
    const f = fixture(); f.add(); f.api.setSentinelEnabled(true); f.control();
    await f.api.forwardTerminalInput('main', key); await f.api.forwardTerminalInput('main', '\r');
    f.status('main', 'working'); f.status('main', 'idle'); await f.advance(1_200);
    assert.equal(f.reports.length, 0, 'history navigation and optimistic state alone do not prove a task ran');
    f.observed('main', 'working'); f.observed('main', 'idle'); await f.advance(1_200);
    assert.equal(f.reports.length, 1, key);
  }
});

await test('failed Enter acknowledgement cancels submission and never sends a completion report', async () => {
  const f = fixture(); f.add(); f.api.setSentinelEnabled(true); f.control();
  f.failInput(args => args.data === '\r');
  const rejected = assert.rejects(f.api.submitTerminalPrompt('main', 'Run tests'), /PTY input failed/);
  await f.advance(200); await rejected;
  f.status('main', 'working'); f.api.markSentinelWorking('main'); f.status('main', 'idle'); await f.advance(1_200);
  assert.equal(f.reports.length, 0);
});

await test('two terminals ending together keep separate task evidence and report only once each', async () => {
  const f = fixture(); f.add('one', 'claude', 'E:\\one'); f.add('two', 'codex', 'E:\\two'); f.api.setSentinelEnabled(true);
  f.start('one'); f.start('two'); f.status('one', 'idle'); f.status('two', 'idle'); await f.advance(1_200);
  assert.equal(f.reports.length, 2);
  assert.deepEqual(f.reports.map(report => [report.sessionId, report.tool, report.cwd]), [['one', 'claude', 'E:\\one'], ['two', 'codex', 'E:\\two']]);
  f.sync(); await f.advance(5_000); assert.equal(f.reports.length, 2);
});

await test('generation replacement and closed tabs discard in-flight evidence', async () => {
  for (const change of ['generation', 'close']) {
    const f = fixture(); const { observer } = f.add(); f.api.setSentinelEnabled(true); f.start(); f.status('main', 'idle');
    await f.advance(700);
    if (change === 'generation') observer.generation = 'main:2';
    else f.state.terminals = [];
    f.sync(); await f.advance(1_200);
    assert.equal(f.reports.length, 0, change);
  }
});

await test('turning mode off cancels pending work and re-enabling establishes a fresh baseline', async () => {
  const f = fixture(); f.add(); f.api.setSentinelEnabled(true); f.start(); f.status('main', 'idle');
  await f.advance(700); f.api.setSentinelEnabled(false); f.api.setSentinelEnabled(true); await f.advance(1_200);
  assert.equal(f.reports.length, 0);
  f.sync(); await f.advance(1_200); assert.equal(f.reports.length, 0);
  f.start(); f.status('main', 'idle'); await f.advance(1_200); assert.equal(f.reports.length, 1);
});

await test('a quick next task preserves the previous frozen result without borrowing new output', async () => {
  const f = fixture(); const { config } = f.add(); f.api.setSentinelEnabled(true); f.start(); f.status('main', 'idle');
  await f.advance(700); config.text = 'Build output from the next task'; config.revision++;
  f.start('main', 'Now inspect the build'); await f.advance(1_200);
  assert.equal(f.reports.length, 1); assert.equal(f.reports[0].taskSequence, 1);
  assert.match(f.reports[0].evidence, /Tests: 4 passed/);
  assert.doesNotMatch(f.reports[0].evidence, /Build output from the next task/);
  assert.equal(f.reports[0].evidenceQuality, 'incomplete');
  f.status('main', 'idle'); await f.advance(1_200);
  assert.equal(f.reports.length, 2); assert.equal(f.reports[1].taskSequence, 2);
  assert.match(f.reports[1].evidence, /Build output from the next task/);
});

await test('a stale observer failure cannot delete a newer task in the same terminal', async () => {
  const f = fixture(); const { observer } = f.add(); const gate = deferred();
  const read = observer.readScreen; observer.readScreen = () => gate.promise;
  f.api.setSentinelEnabled(true); f.start(); f.status('main', 'idle'); await f.advance(700);
  observer.readScreen = read; f.start('main', 'Second real task');
  gate.reject(new Error('old screen failed')); await flush();
  f.status('main', 'idle'); await f.advance(1_200);
  assert.equal(f.reports.length, 2); assert.equal(f.reports[0].taskSequence, 1);
  assert.equal(f.reports[0].evidenceQuality, 'incomplete'); assert.equal(f.reports[1].taskSequence, 2);
});

await test('incomplete screen or scrollback is reported as incomplete evidence', async () => {
  for (const condition of ['gap', 'failed', 'hasMore', 'flushState', 'truncated']) {
    const f = fixture(); const { config } = f.add();
    if (condition === 'flushState') config.flushState = 'timeout';
    else if (condition === 'truncated') config.text = 'x'.repeat(20_000);
    else config[condition] = true;
    f.api.setSentinelEnabled(true); f.start(); f.status('main', 'idle'); await f.advance(1_200);
    assert.equal(f.reports.length, 1, condition); assert.equal(f.reports[0].evidenceQuality, 'incomplete', condition);
    assert.ok(f.reports[0].evidence.length <= 16_000);
  }
});

await test('uncertain IPC delivery does not retry the same completed task', async () => {
  const f = fixture(); f.add(); f.failReport(); f.api.setSentinelEnabled(true); f.start(); f.status('main', 'idle');
  await f.advance(1_200); f.sync(); await f.advance(10_000);
  assert.equal(f.reports.length, 1); assert.equal(f.errors.length, 1);
});

await test('actual TierTerminal multiline paste stays idle until shared Enter and reports the completed turn', async () => {
  const f = fixture(); f.add(); f.api.setSentinelEnabled(true); const forward = f.control();
  forward('\x1b[200~A local multiline\ndraft\x1b[201~');
  assert.equal(f.state.terminals[0].agentStatus, 'idle');
  await f.api.forwardTerminalInput('main', '\x15');
  const submit = f.api.submitTerminalPrompt('main', 'Inspect this project.\nThen run its tests.');
  await f.advance(100); assert.equal(f.state.terminals[0].agentStatus, 'idle');
  await f.advance(100); await submit;
  f.observed('main', 'working'); f.observed('main', 'idle'); await f.advance(1_200);
  assert.equal(f.reports.length, 1); assert.match(f.reports[0].evidence, /Then run its tests/);
});

await test('the last 200 scrollback rows are incomplete when earlier rows were omitted', async () => {
  const f = fixture(); const { observer } = f.add();
  observer.readScrollback = async () => ({ startRow: 800, endRow: 1000, availableRows: 1000, hasMore: false,
    screenRevision: 1, lines: Array.from({ length: 200 }, (_, row) => ({ text: `Recent row ${row}` })),
    freshness: { gap: false, failed: false, flushState: 'flushed' } });
  f.api.setSentinelEnabled(true); f.start(); f.status('main', 'idle'); await f.advance(1_200);
  assert.equal(f.reports.length, 1); assert.equal(f.reports[0].evidenceQuality, 'incomplete');
});

await test('a new turn before the old read resolves reports uncertainty and never attributes its output backwards', async () => {
  const f = fixture(); const { observer, config } = f.add(); const gate = deferred();
  const read = observer.readScreen; observer.readScreen = () => gate.promise;
  f.api.setSentinelEnabled(true); f.start(); f.status('main', 'idle');
  observer.readScreen = read; config.text = 'Next task result'; f.start('main', 'A second task');
  gate.resolve(await read()); await f.advance(1_200);
  assert.equal(f.reports.length, 1); assert.equal(f.reports[0].evidenceQuality, 'incomplete');
  assert.doesNotMatch(f.reports[0].evidence, /Next task result/);
  f.status('main', 'idle'); await f.advance(1_200);
  assert.equal(f.reports.length, 2); assert.match(f.reports[1].evidence, /Next task result/);
});

await test('mode off, closed tabs and changed generation also cancel detached previous-turn receipts', async () => {
  for (const change of ['off', 'close', 'generation']) {
    const f = fixture(); const { observer } = f.add(); f.api.setSentinelEnabled(true);
    f.start(); f.status('main', 'idle'); await f.advance(100); f.start('main', 'Another task');
    if (change === 'off') f.api.setSentinelEnabled(false);
    else if (change === 'close') f.state.terminals = [];
    else observer.generation = 'main:2';
    f.sync(); await f.advance(1_200); assert.equal(f.reports.length, 0, change);
  }
});

await test('a failed stability read retains the frozen evidence and marks the receipt incomplete', async () => {
  const f = fixture(); const { observer } = f.add(); f.api.setSentinelEnabled(true);
  f.start(); f.status('main', 'idle'); await f.advance(700);
  observer.readScreen = async () => { throw new Error('Final screen unavailable'); };
  await f.advance(500);
  assert.equal(f.reports.length, 1); assert.equal(f.reports[0].evidenceQuality, 'incomplete');
  assert.match(f.reports[0].evidence, /Tests: 4 passed/);
  f.sync(); await f.advance(2_000); assert.equal(f.reports.length, 1);
});

await test('late final output is refreshed when no newer prompt has been submitted', async () => {
  const f = fixture(); const { config } = f.add(); config.text = 'Finishing...'; f.api.setSentinelEnabled(true);
  f.start(); f.status('main', 'idle'); await f.advance(700);
  config.text = 'Final result: all 12 tests passed.'; config.revision++;
  await f.advance(500);
  assert.equal(f.reports.length, 1); assert.match(f.reports[0].evidence, /all 12 tests passed/);
  assert.equal(f.reports[0].evidenceQuality, 'incomplete', 'the changed frame is not proven stable');
});

await test('a new task during the final scrollback read keeps the earlier frozen result', async () => {
  const f = fixture(); const { observer, config } = f.add(); const gate = deferred();
  f.api.setSentinelEnabled(true); f.start(); f.status('main', 'idle'); await f.advance(700);
  const read = observer.readScrollback; observer.readScrollback = () => gate.promise;
  await f.advance(400);
  observer.readScrollback = read; config.text = 'Following task output'; config.revision++;
  f.start('main', 'Second task'); gate.resolve(await read()); await f.advance(100);
  assert.equal(f.reports.length, 1); assert.match(f.reports[0].evidence, /Tests: 4 passed/);
  assert.doesNotMatch(f.reports[0].evidence, /Following task output/);
});

await test('a permission prompt during confirmation cancels the premature frozen receipt', async () => {
  const f = fixture(); f.add(); f.api.setSentinelEnabled(true);
  f.start(); f.status('main', 'idle'); await f.advance(700);
  f.status('main', 'wait_input'); await f.advance(500); assert.equal(f.reports.length, 0);
  f.observed('main', 'working'); f.status('main', 'idle'); await f.advance(1_200);
  assert.equal(f.reports.length, 1);
});

await test('queued or steering input reports combined activity without attributing the second output to the first prompt', async () => {
  for (const queued of [true, false]) {
    const f = fixture(); const { config } = f.add(); f.api.setSentinelEnabled(true);
    f.start('main', 'First task: inspect files');
    assert.equal(f.api.markSentinelSubmission('main', 'Second task: run integration checks'), undefined);
    if (queued) { f.status('main', 'idle'); await f.advance(100); f.observed('main', 'working'); }
    config.text = 'Integration checks: 14 passed'; config.revision++;
    f.status('main', 'idle'); await f.advance(1_200);
    assert.equal(f.reports.length, 1); assert.equal(f.reports[0].evidenceQuality, 'incomplete');
    assert.match(f.reports[0].evidence, /Observed combined activity/);
    assert.match(f.reports[0].evidence, /First task: inspect files/);
    assert.match(f.reports[0].evidence, /Second task: run integration checks/);
    assert.match(f.reports[0].evidence, /not present this as the completed result of the initial prompt alone/);
    assert.match(f.reports[0].evidence, /Integration checks: 14 passed/);
  }
});

await test('a failed additional send preserves the running task and labels its input as unverified', async () => {
  const f = fixture(); f.add(); f.api.setSentinelEnabled(true); f.control(); f.start('main', 'Original task');
  f.failInput(args => args.data === '\r');
  const rejected = assert.rejects(f.api.submitTerminalPrompt('main', 'Additional task'), /PTY input failed/);
  await f.advance(200); await rejected;
  f.status('main', 'idle'); await f.advance(1_200);
  assert.equal(f.reports.length, 1); assert.equal(f.reports[0].taskSequence, 1);
  assert.equal(f.reports[0].evidenceQuality, 'incomplete');
  assert.match(f.reports[0].evidence, /Original task/); assert.match(f.reports[0].evidence, /Additional task/);
  assert.match(f.reports[0].evidence, /delivery is not verified/);
});

await test('renewed native work without a tracked prompt invalidates single-prompt attribution', async () => {
  const f = fixture(); const { config } = f.add(); f.api.setSentinelEnabled(true);
  f.start('main', 'Initial prompt'); f.status('main', 'idle'); await f.advance(100);
  f.observed('main', 'working'); config.text = 'Following activity output'; config.revision++;
  f.status('main', 'idle'); await f.advance(1_200);
  assert.equal(f.reports.length, 1); assert.equal(f.reports[0].evidenceQuality, 'incomplete');
  assert.match(f.reports[0].evidence, /Observed combined activity/);
  assert.match(f.reports[0].evidence, /No additional input captured/);
});

await test('dynamic split sessions retain their native identities, directories and independent completion state', async () => {
  const f = fixture();
  const ids = ['first', 'second'];
  f.state.terminals = ids.map((id, i) => ({ id, tool: i ? 'codex' : 'claude', folderPath: 'D:/' + id, agentStatus: 'idle' }));
  Object.assign(f.state, f.api.reducer(f.state, { type: 'OPEN_SESSION_SPLIT', id: 'second', targetId: 'first', edge: 'right' }));
  ids.forEach(id => f.observe(id)); f.sync(); f.api.setSentinelEnabled(true);
  ids.forEach(id => f.start(id));
  assert.ok(f.state.terminals.every(tab => tab.agentStatus === 'working'));
  f.status(ids[0], 'idle'); await f.advance(1_200);
  assert.equal(f.reports.length, 1); assert.equal(f.reports[0].sessionId, ids[0]);
  assert.equal(f.reports[0].cwd, 'D:/first');
  Object.assign(f.state, f.api.reducer(f.state, { type: 'CLOSE_SESSION_SPLIT', id: 'second' })); f.sync();
  f.status(ids[1], 'idle'); await f.advance(1_200);
  assert.equal(f.reports.length, 2); assert.equal(f.reports[1].sessionId, ids[1]);
  assert.equal(f.reports[1].cwd, 'D:/second', 'background work still completes after detaching its pane');
  assert.equal(f.api.reducer(f.state, { type: 'SET_AGENT_STATUS', id: ids[1], status: 'idle' }), f.state);
  assert.equal(f.api.reducer(f.state, { type: 'SET_AGENT_STATUS', id: 'missing', status: 'working' }), f.state);
});
await test('fast native completion during Enter acknowledgement is not overwritten by optimistic working', async () => {
  const f = fixture(); f.add(); f.api.setSentinelEnabled(true); f.control();
  const release = f.holdEnter();
  const submit = f.api.submitTerminalPrompt('main', 'Quick check'); await f.advance(200);
  f.observed('main', 'working'); f.observed('main', 'idle');
  release(); await submit; await f.advance(1_200);
  assert.equal(f.reports.length, 1);
});

console.log(`\n${passed} Agent sentinel tests passed.`);
