import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const file = new URL('../src/lib/history-cache.ts', import.meta.url);
const tree = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const source = tree.statements.filter(node => !ts.isImportDeclaration(node))
  .map(node => node.getText(tree).replace(/^export /, '')).join('\n');
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let now = 10_000;
  let timerId = 0;
  const timers = new Map();
  const requests = [];
  const api = runInNewContext(ts.transpileModule(`${source};
    ({ prefetchHistory, refreshHistory, subscribeHistory, getHistorySnapshot });`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    isTauri: true,
    console: { error() {} },
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    commands: { getNativeHistory: force => new Promise((resolve, reject) => requests.push({ force, resolve, reject })) },
  });
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      await tick();
    }
    now = end;
    await tick();
  }
  return { api, requests, advance };
}

const session = {
  id: 'codex_native_one', name: 'One', tool: 'codex', cwd: '/project',
  session_token: 'one', saved_at: '1788710400000', created_at: '1788700000000',
  file_path: '/sessions/one.jsonl', turn_count: 1,
};

// A request during a slow scan is replayed once, bypassing the backend result
// TTL so sessions created during that scan can actually appear.
{
  const { api, requests, advance } = harness();
  api.refreshHistory(); await advance(400);
  assert.equal(requests.length, 0, 'refresh before prefetch is a no-op');
  api.prefetchHistory(); api.prefetchHistory();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].force, false);
  api.refreshHistory(); api.refreshHistory(); await advance(400);
  assert.equal(requests.length, 1, 'never fetch concurrently');
  requests[0].resolve([session]); await tick();
  await advance(1600);
  assert.equal(requests.length, 2, 'replay at the throttle deadline');
  assert.equal(requests[1].force, true, 'replay must bypass the five-second result cache');
  requests[1].resolve([session, { ...session, id: 'new' }]); await tick();
  assert.equal(api.getHistorySnapshot().sessions.length, 2);
  await advance(5000);
  assert.equal(requests.length, 2, 'a burst does not create a refresh loop');
}

// Identical data preserves the external-store snapshot, but every resume and
// navigation field must participate in comparison, even if mtime is unchanged.
{
  const { api, requests, advance } = harness();
  let emitted = 0;
  api.subscribeHistory(() => emitted++);
  api.prefetchHistory(); requests[0].resolve([session]); await tick();
  const initial = api.getHistorySnapshot();
  api.refreshHistory(); await advance(2000);
  requests.at(-1).resolve([{ ...session }]); await tick();
  assert.equal(api.getHistorySnapshot(), initial);
  assert.equal(emitted, 2, 'only loading and first ready publication');
  let current = { ...session };
  for (const [field, value] of Object.entries({
    file_path: '/moved/one.jsonl', created_at: '1788600000000',
    session_token: 'replacement', tool: 'claude', name: 'a\x01b',
    cwd: '/another', turn_count: 2,
  })) {
    const before = api.getHistorySnapshot();
    current = { ...current, [field]: value };
    api.refreshHistory(); await advance(2000);
    requests.at(-1).resolve([current]); await tick();
    assert.notEqual(api.getHistorySnapshot(), before, `${field} update was dropped`);
    assert.equal(api.getHistorySnapshot().sessions[0][field], value);
  }
  const beforeFailure = api.getHistorySnapshot();
  api.refreshHistory(); await advance(2000);
  requests.at(-1).reject(new Error('temporary read failure')); await tick();
  assert.equal(api.getHistorySnapshot(), beforeFailure, 'failed refresh retains visible data');
}

// A failed initial request still drains a queued refresh and reaches ready.
{
  const { api, requests, advance } = harness();
  api.prefetchHistory();
  api.refreshHistory(); await advance(400);
  requests[0].reject(new Error('offline')); await tick();
  assert.equal(api.getHistorySnapshot().status, 'error');
  await advance(1600);
  requests[1].resolve([]); await tick();
  assert.equal(api.getHistorySnapshot().status, 'ready');
  assert.equal(api.getHistorySnapshot().sessions.length, 0);
}

console.log('OK: history refresh replay, backend TTL bypass, full-field comparison, and failure recovery');
