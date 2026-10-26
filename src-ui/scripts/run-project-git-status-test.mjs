import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const file = new URL('../src/lib/project-git-status.ts', import.meta.url);
const tree = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const source = tree.statements.filter(node => !ts.isImportDeclaration(node))
  .map(node => node.getText(tree).replace(/^export /, '')).join('\n');
const compiled = ts.transpileModule(`${source}; ({useProjectGitStatuses, getSnapshot, subscribe, gitStatusKey, read});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
const storageKey = 'cc-project-git-status-v1';
const first = { folder: 'D:/project', context: { branch: 'main', pull_requests: ['https://github.com/example/repo/pull/1'] } };
const second = { folder: 'D:/project', context: { branch: 'main', pull_requests: ['https://github.com/example/repo/pull/2'] } };
const status = (state = 'merged', number = 1) => ({
  repo_root: 'D:/project', branch: 'main', github: 'ok',
  pull_request: { number, url: `https://github.com/example/repo/pull/${number}`, state, ci: null },
});
const key = target => target.folder.toLowerCase() + '\0' + JSON.stringify(target.context);
const seeded = () => new Map([[storageKey, JSON.stringify([[key(first), status()], [key(second), status('closed', 2)]])]]);

function harness(storage = new Map(), blocked = false) {
  let now = 1_000_000, cleanup, writes = 0;
  const requests = [], foreground = new Set(), background = new Set(), timers = new Set();
  const localStorage = {
    getItem: k => { if (blocked) throw Error('blocked'); return storage.get(k) ?? null; },
    setItem: (k, value) => { if (blocked) throw Error('blocked'); writes++; storage.set(k, value); },
  };
  const api = runInNewContext(compiled, {
    isTauri: true, localStorage, document: { hidden: false },
    useSyncExternalStore: (_, getSnapshot) => getSnapshot(),
    useMemo: create => create(),
    useEffect: effect => { cleanup?.(); cleanup = effect(); },
    onWindowForeground: fn => { foreground.add(fn); return () => foreground.delete(fn); },
    onWindowBackground: fn => { background.add(fn); return () => background.delete(fn); },
    window: { setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn) },
    Date: class extends Date { static now() { return now; } },
    commands: { gitProjectStatus: (folder, context) => new Promise((resolve, reject) => requests.push({ folder, context, resolve, reject })) },
  });
  return { api, requests, storage, writes: () => writes, view: targets => api.useProjectGitStatuses(targets),
    advance: ms => { now += ms; }, poll: async () => { timers.forEach(fn => fn()); await tick(); }, dispose: () => cleanup?.() };
}

{
  const h = harness(seeded());
  const original = h.api.getSnapshot();
  const initial = h.view([first, second]);
  assert.equal(initial.get(key(first)).pull_request.state, 'merged');
  assert.equal(initial.get(key(second)).pull_request.state, 'closed', 'same folder keeps separate conversation PRs');
  assert.equal(h.requests.length, 2, 'restored snapshots still refresh in the background');
  assert.equal(h.api.getSnapshot(), original, 'pending refresh never clears the displayed snapshot');
  let changes = 0;
  const unsubscribe = h.api.subscribe(() => changes++);
  h.requests[0].resolve(status()); h.requests[1].resolve(status('closed', 2)); await tick();
  assert.equal(h.api.getSnapshot(), original, 'identical refresh preserves snapshot identity');
  assert.equal(changes, 0); assert.equal(h.writes(), 0, 'identical data does not rewrite storage');
  h.dispose();
  assert.equal(h.view([first, second]).get(key(first)), initial.get(key(first)), 'reopening the view uses the same snapshot immediately');
  assert.equal(h.requests.length, 2, 'fresh in-memory data is reused');
  await tick();
  h.advance(30_001); await h.poll();
  h.requests[2].resolve({ ...status(), github: 'unavailable', pull_request: null });
  h.requests[3].reject(Error('offline')); await tick();
  assert.equal(h.api.getSnapshot().get(key(first)).pull_request.state, 'merged', 'rate limits retain a known PR');
  assert.equal(h.api.getSnapshot().get(key(second)).pull_request.state, 'closed', 'request errors retain a known PR');
  const restarted = harness(h.storage);
  assert.equal(restarted.view([first]).get(key(first)).pull_request.state, 'merged', 'snapshot survives an app restart');
  restarted.requests[0].resolve({ ...status(), pull_request: null }); await tick();
  assert.equal(restarted.api.getSnapshot().get(key(first)).pull_request, null, 'a successful no-PR response clears the old mark');
  assert.equal(JSON.parse(h.storage.get(storageKey)).find(([k]) => k === key(first))[1].pull_request, null);
  unsubscribe(); h.dispose(); restarted.dispose();
}

{
  const h = harness(seeded());
  assert.equal(h.view([]).size, 0, 'inactive views do not inherit unrelated cached statuses');
  assert.equal(h.requests.length, 0);
  h.dispose();
}

for (const value of [null, { ...status(), github: 'not_github', pull_request: null },
  { ...status(), repo_root: 'D:/different', github: 'unavailable', pull_request: null },
  { ...status(), branch: 'different', github: 'unavailable', pull_request: null }]) {
  const h = harness(seeded()), reading = h.api.read(first);
  h.requests[0].resolve(value); await reading;
  assert.equal(h.api.getSnapshot().get(key(first))?.pull_request ?? null, null, 'missing repositories and changed identities cannot inherit a cached PR');
}

{
  const h = harness();
  h.view([first, second, { folder: 'D:/third' }]);
  assert.equal(h.requests.length, 2, 'only two native reads start at once');
  const shared = h.api.read({ ...first, folder: 'd:\\PROJECT\\' });
  assert.equal(h.requests.length, 2, 'identical normalized targets share a pending request');
  h.requests[0].resolve(status()); await shared; await tick();
  assert.equal(h.requests.length, 3);
  h.requests[1].resolve(status('closed', 2)); h.requests[2].resolve(null); await tick();
  assert.equal(h.api.getSnapshot().size, 3);
  h.dispose();
}

{
  const invalid = [[key(first), { ...status(), pull_request: { ...status().pull_request, state: 'invalid' } }],
    ['invalid', { ...status(), branch: 3 }], ['valid-null', null], [key(second), status('closed', 2)]];
  const h = harness(new Map([[storageKey, JSON.stringify(invalid)]]));
  assert.equal(h.api.getSnapshot().size, 2, 'invalid entries are ignored without losing valid snapshots');
  assert.equal(harness(new Map([[storageKey, '{broken']])).api.getSnapshot().size, 0);
  const unavailable = harness(new Map(), true), reading = unavailable.api.read(first);
  unavailable.requests[0].resolve(status()); await reading;
  assert.equal(unavailable.api.getSnapshot().get(key(first)).pull_request.state, 'merged', 'unavailable storage still supports live status');
}

{
  const storage = new Map([[storageKey, JSON.stringify(Array.from({ length: 300 }, (_, i) => [`old-${i}`, status()]))]]);
  const h = harness(storage);
  assert.equal(h.api.getSnapshot().size, 256);
  const reading = h.api.read(first); h.requests[0].resolve(status()); await reading;
  assert.equal(h.api.getSnapshot().size, 257, 'persisted limits do not evict currently displayed statuses from memory');
  assert.equal(h.api.getSnapshot().has('old-44'), true);
  assert.equal(JSON.parse(storage.get(storageKey)).length, 256, 'persisted snapshots stay bounded');
  assert.equal(JSON.parse(storage.get(storageKey)).some(([k]) => k === 'old-44'), false, 'oldest snapshots leave the persisted cache');
}
console.log('OK: immediate persisted PR snapshots, restart/remount, silent refresh, identity isolation, unavailable/error retention, authoritative clearing, deduplication, concurrency, corruption and bounded storage');
