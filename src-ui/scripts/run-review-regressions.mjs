import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';

const source = file => ts.createSourceFile(file,
  fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(file, name) {
  const tree = source(file);
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return node.getText(tree);
}
function effect(file, fragment) {
  const tree = source(file); let found;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect'
      && node.arguments[0].getText(tree).includes(fragment)) found = node.arguments[0].getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(found, fragment); return found;
}
const evaluate = (code, context = {}) => vm.runInNewContext(ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText, context);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Actual reducer: a background PTY may only change its own tab/pane.
const reducer = evaluate(`${declaration('store/app-state.tsx', 'reducer')}; reducer`, {
  localStorage: { setItem() {} },
  paneSessionId: (tab, index, kind) => `${tab}::${kind}-${index}`,
});
const state = { activeTerminalId: 'A', terminals: [
  { id: 'A', folderPath: '/A' }, { id: 'B', folderPath: '/B' },
  { id: 'C', folderPath: '/C', multiAgent: { panes: [{ paneIdx: 1, folderPath: '/one' }, { paneIdx: 2, folderPath: '/two' }] } },
] };
const changed = reducer(state, { type: 'SET_TERMINAL_CWD', id: 'B', path: '/B/new' });
assert.equal(changed.terminals[0], state.terminals[0]);
assert.equal(changed.terminals[1].folderPath, '/B/new');
assert.equal(reducer(changed, { type: 'SET_TERMINAL_CWD', id: 'B', path: '/B/new' }), changed);
assert.equal(reducer(state, { type: 'SET_TERMINAL_CWD', id: 'closed', path: '/gone' }), state);
const split = reducer(state, { type: 'SET_TERMINAL_CWD', id: 'C::split-2', path: '/two/new' });
assert.equal(split.terminals[2].folderPath, '/C');
assert.equal(split.terminals[2].multiAgent.panes[0], state.terminals[2].multiAgent.panes[0]);
assert.equal(split.terminals[2].multiAgent.panes[1].folderPath, '/two/new');

const normalize = evaluate(`${declaration('components/center/ConversationView.tsx', 'normalizedPath')}; normalizedPath`);
assert.notEqual(normalize('/work/Project'), normalize('/work/project'));
assert.equal(normalize('C:\\Work\\Project\\'), normalize('c:/work/project'));
assert.equal(normalize('C:\\'), normalize('c:/'));
assert.equal(normalize('\\\\Host\\Share\\Project'), normalize('//host/share/project'));
assert.equal(normalize('/work/Project/.claude/worktrees/task'), '/work/Project');

// Cleanup during both async import and listen() registration, including StrictMode remounts.
for (const [file, fragment] of [
  ['components/right/TaskBoard.tsx', "'tasks-changed'"],
  ['components/center/CenterPanel.tsx', "'launch-request'"],
]) {
  for (const duringListen of [false, true]) {
    let created = 0, removed = 0;
    const registration = deferred();
    const body = effect(file, fragment).replace("import('@tauri-apps/api/event')", 'Promise.resolve(eventModule)');
    const cleanup = evaluate(`(${body})()`, {
      isTauri: true, commands: { takePendingLaunch: async () => null },
      eventModule: { listen: () => { created++; return registration.promise; } },
    });
    if (duringListen) await tick();
    cleanup(); registration.resolve(() => { removed++; }); await tick();
    assert.equal(created, removed, `${file}: leaked a late listener`);
    assert.equal(created, duringListen ? 1 : 0, `${file}: registration count`);
  }
}

// Actual Explorer effect: old folders and old refreshes cannot replace the latest listing.
const callbacks = new Map(), requests = []; let entries;
const browser = {
  addEventListener: (name, cb) => callbacks.set(name, cb),
  removeEventListener: name => callbacks.delete(name),
};
const refresh = effect('components/left/Explorer.tsx', 'const target = norm(folderPath)');
const mount = folderPath => evaluate(`(${refresh})()`, {
  folderPath, window: browser, setRootEntries: value => { entries = value; },
  commands: { listDirectory: () => { const request = deferred(); requests.push(request); return request.promise; } },
});
const closeA = mount('/A');
callbacks.get('fs-refresh')({ detail: { dirPath: '/A' } });
closeA(); const closeB = mount('/B');
requests[2].resolve(['B']); await tick();
requests[0].resolve(['old A']); requests[1].reject(new Error('late A')); await tick();
assert.equal(entries[0], 'B');
callbacks.get('fs-refresh')({ detail: { dirPath: '/B' } });
callbacks.get('fs-refresh')({ detail: { dirPath: '/B' } });
requests[4].resolve(['new B']); await tick(); requests[3].resolve(['old B']); await tick();
assert.equal(entries[0], 'new B'); closeB();

// Actual Diff load effect: equal line counts still refresh text; unchanged polls skip tokenization.
let poll, timer, output, tokenizations = 0, reads = 0, fileText = 'first', failure = false, pendingRead;
const diffCallbacks = new Map();
const diffEffect = effect('components/right/DiffPanel.tsx', 'const load = async');
const cleanupDiff = evaluate(`(${diffEffect})()`, {
  path: '/repo/a.txt', repoRoot: '/repo', rel: 'a.txt', kind: 'untracked', commitHash: undefined,
  dataTheme: 'dark', badgeRef: { current: { added: 1, deleted: 0 } },
  DIFF_MAX_CHANGED_LINES: 5000, DIFF_MAX_BYTES: 1_000_000,
  setResult: value => { output = value; },
  commands: { readTextFile: async () => {
    reads++;
    if (pendingRead) return pendingRead.promise;
    if (failure) throw new Error('read failed');
    return fileText;
  } },
  computeUnifiedDiff: (_old, text) => [{ kind: 'add', text, lineNum: 1 }],
  collapseToHunks: rows => rows, getShikiTheme: value => value,
  tokenizeFile: async () => { tokenizations++; return null; },
  document: { visibilityState: 'visible' }, TextEncoder,
  window: {
    setInterval: cb => { poll = cb; return 1; }, clearInterval() {},
    addEventListener: (name, cb) => diffCallbacks.set(name, cb),
    removeEventListener: name => diffCallbacks.delete(name),
  },
  setTimeout: cb => { timer = cb; return 1; }, clearTimeout() { timer = null; },
});
await tick(); assert.equal(output.rows[0].text, 'first');
poll(); await tick(); assert.equal(tokenizations, 2, 'unchanged poll retokenized');
fileText = 'second'; diffCallbacks.get('fs-refresh')({ detail: { dirPath: '/repo' } });
timer(); await tick(); assert.equal(output.rows[0].text, 'second');
assert.equal(tokenizations, 4);
failure = true; poll(); await tick(); assert.equal(output.state, 'error');
failure = false; poll(); await tick(); assert.equal(output.rows[0].text, 'second', 'retry must recover identical text');
fileText = '中'.repeat(400_000); poll(); await tick();
assert.equal(output.state, 'too_large', 'size guard must count UTF-8 bytes');
const largeReads = reads; poll(); await tick();
assert.equal(reads, largeReads, 'do not repeatedly read oversized files on the polling backstop');
fileText = 'second'; diffCallbacks.get('fs-refresh')({ detail: { dirPath: '/repo' } });
timer(); await tick(); assert.equal(output.rows[0].text, 'second');
pendingRead = deferred(); poll(); cleanupDiff();
pendingRead.resolve('late result'); await tick();
assert.equal(output.rows[0].text, 'second');
console.log('OK: background cwd, split ownership, path case, late listeners, Explorer races, and live Diff refresh');
