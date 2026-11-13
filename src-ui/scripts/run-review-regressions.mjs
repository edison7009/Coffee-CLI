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

// Muse's Windows launcher title must not replace the selected workspace name.
{
  const tree = source('components/center/CenterPanel.tsx');
  let title;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'title'
      && node.initializer?.getText(tree).includes('baseTitle')) title = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(title);
  const displayedTitle = (tool, toolTitle, baseTitle = 'E300', worker) => evaluate(title.getText(tree), {
    session: { tool, toolTitle, folderPath: 'E:\\E300' }, baseTitle, task: worker,
  });
  for (const launcher of [String.raw`C:\WINDOWS\system32\cmd.exe`, String.raw`C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`]) {
    assert.equal(displayedTitle('muse', launcher), 'E300', 'Muse keeps its actual workspace label');
  }
  assert.equal(displayedTitle('muse', undefined, 'Muse Code'), 'Muse Code');
  assert.equal(displayedTitle('claude', '  Implement feature  '), 'Implement feature', 'other tools retain native conversation titles');
  assert.equal(displayedTitle('codex', ''), 'E300');
  assert.equal(displayedTitle('codex', 'Native summary', 'E300', { title: 'Review changes' }), 'Review changes');
  console.log('OK: Muse workspace tab name and existing-tool native titles');
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Actual reducer: a background PTY may only change its own session.
const reducer = evaluate(`${declaration('store/app-state.tsx', 'reducer')}; reducer`, {
  localStorage: { setItem() {} },
});
const state = { activeTerminalId: 'A', terminals: [
  { id: 'A', folderPath: '/A' }, { id: 'B', folderPath: '/B' },
  { id: 'C', folderPath: '/C' },
] };
const changed = reducer(state, { type: 'SET_TERMINAL_CWD', id: 'B', path: '/B/new' });
assert.equal(changed.terminals[0], state.terminals[0]);
assert.equal(changed.terminals[1].folderPath, '/B/new');
assert.equal(reducer(changed, { type: 'SET_TERMINAL_CWD', id: 'B', path: '/B/new' }), changed);
assert.equal(reducer(state, { type: 'SET_TERMINAL_CWD', id: 'closed', path: '/gone' }), state);
const split = reducer(state, { type: 'SET_TERMINAL_CWD', id: 'C', path: '/C/new' });
assert.equal(split.terminals[0], state.terminals[0]);
assert.equal(split.terminals[2].folderPath, '/C/new');

const toolSettings = reducer(state, { type: 'SET_TOOL_SETTINGS_OPEN', open: true });
assert.equal(toolSettings.toolSettingsOpen, true);
assert.equal(toolSettings.terminals, state.terminals, 'tool settings keeps existing sessions mounted');
assert.equal(toolSettings.activeTerminalId, 'A');
const statistics = reducer(toolSettings, { type: 'SET_USAGE_OPEN', open: true });
assert.equal(statistics.toolSettingsOpen, false);
assert.equal(statistics.usageOpen, true);
assert.equal(reducer(statistics, { type: 'SET_TOOL_SETTINGS_OPEN', open: true }).usageOpen, false);
const conversation = reducer(toolSettings, { type: 'SET_ACTIVE_TERMINAL', id: 'B' });
assert.equal(conversation.toolSettingsOpen, false);
assert.equal(conversation.activeTerminalId, 'B');

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
      coldLaunchRef: { current: null },
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
  path: '/repo/a.txt', repoRoot: '/repo', rel: 'a.txt', kind: 'untracked', fileSize: undefined, commitHash: undefined,
  dataMode: 'dark', badgeRef: { current: { added: 1, deleted: 0 } }, refreshRef: { current: null }, activeRef: { current: true },
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

// Explorer previews use the same loading lifecycle, without Git or diff folds.
{
  let text = 'hello', result, refreshFile, refreshTimer, fileReads = 0;
  const mountPreview = (fileSize = 5) => evaluate(`(${diffEffect})()`, {
    path: '/repo/a.txt', repoRoot: '/repo', rel: 'a.txt', kind: 'file', fileSize,
    commitHash: undefined, dataMode: 'dark', badgeRef: { current: { added: 0, deleted: 0 } }, refreshRef: { current: null }, activeRef: { current: true },
    DIFF_MAX_CHANGED_LINES: 3, DIFF_MAX_BYTES: 10000,
    setResult: value => { result = value; },
    commands: { readTextFile: async () => { fileReads++; return text; } },
    computeUnifiedDiff: () => { throw new Error('preview must not compute a diff'); },
    collapseToHunks: () => { throw new Error('preview must not fold file contents'); },
    getShikiTheme: value => value, tokenizeFile: async () => null,
    document: { visibilityState: 'visible' }, TextEncoder,
    window: {
      setInterval: () => 1, clearInterval() {},
      addEventListener: (_name, callback) => { refreshFile = callback; }, removeEventListener() {},
    },
    setTimeout: callback => { refreshTimer = callback; return 1; }, clearTimeout() {},
  });
  const reload = async value => {
    text = value;
    refreshFile({ detail: { dirPath: '/repo' } });
    refreshTimer(); await tick();
  };
  const closePreview = mountPreview(); await tick();
  assert.equal(result.rows[0].line.kind, 'eq');
  assert.equal(result.rows[0].line.text, 'hello');
  await reload('1\n2\n3\n4');
  assert.equal(result.state, 'too_large');
  await reload('hello');
  assert.equal(result.state, 'ok', 'shrinking back to the previous contents must recover from the line limit');
  await reload('');
  assert.equal(result.state, 'ok'); assert.equal(result.rows.length, 0, 'empty file is a successful preview');
  await reload(null); assert.equal(result.state, 'error', 'binary or unreadable text is not an empty file');
  closePreview();
  const before = fileReads, closeLarge = mountPreview(10001); await tick();
  assert.equal(result.state, 'too_large');
  assert.equal(fileReads, before, 'Explorer size hint rejects large files before reading');
  closeLarge();
  console.log('OK: full neutral file previews, empty/binary files, size guards and recovery after shrinking');
}

// Every saved launchpad pin must have a visible switch, including Cline.
const centerTree = source('components/center/CenterPanel.tsx');
const pinDeclarations = new Map();
function collectPinDeclarations(node) {
  if (ts.isVariableDeclaration(node)) pinDeclarations.set(node.name.getText(centerTree), node);
  ts.forEachChild(node, collectPinDeclarations);
}
collectPinDeclarations(centerTree);
const pinInitializer = pinDeclarations.get('[pinnedItems, setPinnedItems]').initializer.arguments[0].getText(centerTree);
const validPinKeys = evaluate(pinDeclarations.get('VALID_PIN_KEYS').initializer.getText(centerTree));
let savedPins = JSON.stringify(['agent:cline']);
const pinContext = {
  VALID_PIN_KEYS: validPinKeys,
  localStorage: {
    getItem: () => savedPins,
    setItem: (_key, value) => { savedPins = value; },
  },
};
const loadPins = () => Array.from(evaluate(`(${pinInitializer})()`, pinContext));
assert.deepEqual(loadPins(), ['agent:cline'], 'preserve the existing Cline selection');
assert.equal(savedPins, '["agent:cline"]');
savedPins = JSON.stringify(['agent:vibeid']);
assert.deepEqual(loadPins(), [], 'retired tools must not leave an invisible pin');
assert.equal(savedPins, '[]', 'remove the ghost from storage as well as the counter');
assert.deepEqual(loadPins(), [], 'reloading must keep an intentionally empty selection');

// Compare against the actual rendered catalog so future removals cannot drift.
const aiPins = evaluate(pinDeclarations.get('BUILTIN_AI_CLI_FALLBACK').initializer.getText(centerTree), {
  getToolDisplayName: key => key,
}).map(item => item.key);
const utilityPins = [];
function collectCatalogKeys(node) {
  if (ts.isObjectLiteralExpression(node)) {
    const key = node.properties.find(property => property.name?.getText(centerTree) === 'key');
    if (key && ts.isAsExpression(key.initializer) && ts.isStringLiteral(key.initializer.expression)) utilityPins.push(key.initializer.expression.text);
  }
  ts.forEachChild(node, collectCatalogKeys);
}
collectCatalogKeys(pinDeclarations.get('AGENT_CATALOG').initializer);
const catalogPins = [...aiPins, ...utilityPins];
assert.ok(aiPins.includes('cline'), 'Cline must remain selectable as a launch-only tool');
assert.deepEqual([...validPinKeys].sort(), catalogPins.sort(), 'every valid pin needs a visible switch');

savedPins = JSON.stringify(['agent:cline', 'agent:claude', 'agent:multi-agent', 'agent:four-split']);
let pins = loadPins();
assert.deepEqual(pins, ['agent:cline', 'agent:claude'], 'preserve current tools and remove retired split pins');
const togglePin = evaluate(pinDeclarations.get('togglePin').initializer.getText(centerTree), {
  ...pinContext, MAX_PINS: 6, setPinnedItems: update => { pins = update(pins); },
});
for (const key of catalogPins) {
  if (pins.includes(`agent:${key}`)) togglePin(`agent:${key}`);
}
assert.equal(pins.length, 0, 'turning off every visible switch must produce 0/6');
assert.equal(savedPins, '[]');
assert.deepEqual(loadPins(), [], 'reloading after switching everything off must stay empty');
togglePin('agent:cline');
assert.deepEqual(Array.from(pins), ['agent:cline'], 'Cline can be pinned again');
togglePin('agent:cline');
assert.equal(pins.length, 0, 'Cline can be switched off again');
for (const key of catalogPins.slice(0, 7)) togglePin(`agent:${key}`);
assert.equal(pins.length, 6, 'all six slots must be usable while the cap remains enforced');
console.log('OK: Cline selection and toggling, retired pins, catalog consistency, persisted zero count, migration, and six-slot limit');

// Exercise the actual tool-card handler: a manual launch checks and remembers its folder.
const manualLaunches = [];
const checkedLaunchFolders = [];
const rememberedFolders = [];
const selectTool = evaluate(pinDeclarations.get('selectTool').initializer.getText(centerTree), {
  activeTerminalId: 'launchpad', dispatch: action => manualLaunches.push(action),
  activeIdRef: { current: 'launchpad' },
  commands: { async checkProjectDirectories(paths) { checkedLaunchFolders.push(...paths); return paths.map(path => ({ path, status: 'available' })); } },
  rememberFolder(tool, folder) { rememberedFolders.push([tool, folder]); }, claudeLaunchMode: 'conversation',
});
await selectTool('claude', undefined, 'E:\\tmp');
assert.deepEqual(checkedLaunchFolders, ['E:\\tmp']);
assert.equal(manualLaunches.length, 1);
assert.equal(manualLaunches[0].type, 'LAUNCH_TERMINAL_TOOL');
assert.equal(manualLaunches[0].id, 'launchpad');
assert.equal(manualLaunches[0].tool, 'claude');
assert.equal(manualLaunches[0].cwd, 'E:\\tmp');
assert.deepEqual(rememberedFolders, [['claude', 'E:\\tmp']], 'the launch is remembered as this tool\'s last folder');
console.log('OK: actual tool-card folder selection uses the launch action and remembers the tool\'s folder');

// Exercise the actual history-card click: native history resumes a real CLI tab,
// and mixed timestamp formats sort together.
{
  const tree = source('components/right/HistoryBoard.tsx');
  let handler, filter, merge, matches;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleViewHistory') handler = node.initializer.getText(tree);
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'matchedSessions') filter = node.initializer.getText(tree);
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'baseSessions') merge = node.initializer.getText(tree);
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'matchesQuery') matches = node.initializer.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(handler); assert.ok(filter); assert.ok(merge); assert.ok(matches);
  const newest = Date.UTC(2026, 9, 10, 13, 15);
  const nativeSessions = Array.from({ length: 35 }, (_, index) => ({
    id: `native-${index}`, name: `CLI history ${index}`, tool: 'claude', cwd: 'E:\\tmp',
    session_token: `resume-${index}`, saved_at: String(newest - (index + 1) * 60_000),
  }));
  nativeSessions.push(
    { ...nativeSessions[0], id: 'native-seconds', saved_at: String((newest - 36 * 60_000) / 1000) },
    { ...nativeSessions[0], id: 'native-iso', saved_at: new Date(newest - 37 * 60_000).toISOString() },
  );
  const sortByMtime = evaluate(`${declaration('lib/history-cache.ts', 'sortByMtime').replace(/^export\s+/, '')}; sortByMtime`);
  const merged = evaluate(merge, { useMemo: callback => callback(), nativeSessions, liveSessions: [], state: { terminals: [] }, nowMs: newest, sortByMtime });
  assert.equal(merged[0].id, 'native-0', 'the newest history leads mixed timestamp histories');
  assert.deepEqual(Array.from(merged.slice(-2), session => session.id), ['native-seconds', 'native-iso']);
  const matchesQuery = evaluate(matches, {
    useCallback: callback => callback, renamed: {},
    projectName: () => '', getToolName: tool => tool,
  });
  const allHistories = evaluate(filter, {
    useMemo: callback => callback(), availableSessions: merged, debouncedQuery: '', matchesQuery,
  });
  assert.equal(allHistories.length, 37);
  const actions = [];
  const click = evaluate(`const click = ${handler}; click`, {
    dispatch: action => actions.push(action), setAgentError() {},
    crypto: { randomUUID: () => 'native-tab' },
    isTauri: false, state: { terminals: [] }, liveSessions: [], renamed: { 'claude:claude-renamed': 'My name' },
  });
  await click({ id: 'claude-history', tool: 'claude', cwd: 'E:\\tmp', session_token: 'native-resume' });
  assert.deepEqual(actions.map(action => action.type), ['ADD_TERMINAL']);
  await click({ id: 'claude-renamed', tool: 'claude', name: 'History title', cwd: 'E:\\tmp', session_token: 'native-renamed' });
  assert.equal(actions.at(-1).session.toolTitle, 'History title', 'a reopened tab starts under its history title');
  assert.equal(actions.at(-1).session.pinnedTitle, 'My name', 'the name the user gave it outranks later tool titles');
  console.log('OK: mixed timestamps sort together and native CLI history resumes under its title');
}
