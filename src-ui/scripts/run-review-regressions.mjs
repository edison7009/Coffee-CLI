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
    session: { tool, toolTitle, folderPath: 'E:\\E300' }, baseTitle, worker,
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

// Agent reuses Gambit, but only while its tab is visible. The shared composer
// must preserve drafts on rejection and never send a second request while busy.
{
  const state = { agentPageActive: 'agent', leftPanelHidden: false, rightPanelHidden: false };
  let running = false, rejectSend = false;
  const sent = [], cancelled = [];
  const render = vm.runInNewContext(ts.transpileModule(
    `${declaration('components/agent/AgentPages.tsx', 'AgentChatPage')}; AgentChatPage`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } },
  ).outputText, {
    useAppState: () => ({ state }),
    useAgentClient: () => ({ messages: [], running, activity: '', error: '' }),
    useT: () => key => key,
    useState: initial => [initial, () => {}], useRef: initial => ({ current: initial }), useEffect() {}, useLayoutEffect() {},
    useMemo: callback => callback(), useCallback: callback => callback,
    React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    PageFrame: 'page', Gambit: 'gambit', MarkdownContent: 'markdown',
    ConversationNavigation: 'navigation', MessageCopyButton: 'copy',
    formatAgentActivity: text => text, formatAgentError: text => text, formatAgentMessage: text => text,
    sendAgentMessage: async text => { if (rejectSend) throw new Error('model unavailable'); sent.push(text); },
    invoke: async (command, args) => { cancelled.push({ command, ...args }); },
  });
  const composer = page => page.children.find(child => child?.type === 'gambit');
  let props = composer(render()).props;
  assert.equal(props.workspaceName, 'Coffee Agent');
  assert.equal(await props.onSend('  inspect terminal 2  '), true);
  assert.deepEqual(sent, ['inspect terminal 2']);
  rejectSend = true;
  assert.equal(await props.onSend('retry later'), false, 'IPC failure rejects the send without clearing its draft');
  running = true;
  props = composer(render()).props;
  assert.equal(props.running, true);
  assert.equal(await props.onSend('do not overlap'), false);
  await props.onCancel();
  assert.deepEqual(cancelled, [{ command: 'agent_cancel', conversationId: 'desktop' }]);
  for (const page of ['config', null]) {
    state.agentPageActive = page;
    assert.equal(composer(render()), undefined, 'hidden Agent must release the dock and its body effects');
  }

  const tree = source('components/center/Gambit.tsx');
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'handleSend') callback = node.initializer.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(callback);
  const history = [], cleared = [], failed = [];
  const context = {
    useCallback: fn => fn, draft: 'original prompt', running: false, claude: false, codex: false,
    sendingRef: { current: false }, latestDraftRef: { current: 'original prompt' }, historyCursorRef: { current: null },
    onSend: async () => true, onDraftChange: text => cleared.push(text),
    pushGambitHistory: text => history.push(text), setSendFailed: value => failed.push(value), setSendEmpty() {},
  };
  const send = () => evaluate(`${declaration('components/center/Gambit.tsx', 'wrapImagePathsForSend')}; ${callback}`, {
    ...context, IMAGE_PATH_RE: /(?:[A-Za-z]:[\\/]|\/)[^\s<>"'`]+?\.(?:png|jpe?g|gif|webp|bmp)/gi,
  });
  context.running = true;
  await send()();
  assert.equal(history.length, 0);
  assert.equal(cleared.length, 0, 'Enter during an Agent request cannot clear or send the pending draft');
  context.running = false;
  context.onSend = async () => false;
  await send()();
  assert.equal(failed.length, 1);
  assert.equal(cleared.length, 0, 'a rejected send preserves the draft');
  const pending = deferred(); let calls = 0;
  context.onSend = () => { calls++; return pending.promise; };
  const submit = send();
  const first = submit();
  await submit();
  assert.equal(calls, 1, 'a double click cannot submit two requests');
  context.latestDraftRef.current = 'next prompt typed while submitting';
  pending.resolve(true); await first;
  assert.equal(cleared.length, 0, 'accepting an earlier prompt preserves a newer draft');
  assert.deepEqual(history, ['original prompt']);
  context.latestDraftRef.current = context.draft;
  context.onSend = async () => true;
  await send()();
  assert.deepEqual(cleared, [''], 'an accepted unchanged draft still clears normally');
  console.log('OK: Agent Gambit visibility, routing, cancellation, busy guard, and draft preservation');
}

// Render the actual Agent page with persistent hooks and measured transcript
// rows. Navigation and copy handlers must act on messages, not their previews.
{
  const cells = [], effects = [], layouts = [], copied = [], timers = [];
  const client = { conversationId: 'coffee-test', messages: [], hasOlder: true, loadingOlder: false, running: false, activity: '', error: '' };
  let cursor = 0, rows = [], olderRequest;
  const scrollCalls = [];
  const scroll = {
    scrollTop: 0, scrollHeight: 2000, clientHeight: 400,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => rows,
    querySelector: selector => rows.find(row => selector.includes(`"${row.dataset.conversationNavigationId}"`)),
    scrollTo(options) { scrollCalls.push(options); this.scrollTop = options.top; },
  };
  function cell(initial) { const index = cursor++; return cells[index] ??= { value: initial }; }
  const sameDeps = (before, after) => before && after && before.length === after.length && before.every((value, index) => Object.is(value, after[index]));
  function schedule(queue, callback, deps) {
    const current = cell();
    if (!sameDeps(current.deps, deps)) {
      current.deps = deps;
      queue.push(() => { current.cleanup?.(); current.cleanup = callback(); });
    }
  }
  const component = vm.runInNewContext(ts.transpileModule(
    `${declaration('components/agent/AgentPages.tsx', 'AgentChatPage')}; AgentChatPage`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } },
  ).outputText, {
    useT: () => key => key,
    useAppState: () => ({ state: { agentPageActive: 'agent', leftPanelHidden: false, rightPanelHidden: false } }),
    useAgentClient: () => client,
    useState(initial) {
      const current = cell(typeof initial === 'function' ? initial() : initial);
      return [current.value, update => { current.value = typeof update === 'function' ? update(current.value) : update; }];
    },
    useRef(initial) { return cell({ current: initial }).value; },
    useMemo(callback, deps) {
      const current = cell();
      if (!sameDeps(current.deps, deps)) { current.value = callback(); current.deps = deps; }
      return current.value;
    },
    useCallback: callback => callback,
    useEffect: (callback, deps) => schedule(effects, callback, deps),
    useLayoutEffect: (callback, deps) => schedule(layouts, callback, deps),
    React: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) },
    PageFrame: 'page', Gambit: 'gambit', MarkdownContent: 'markdown',
    ConversationNavigation: 'navigation', MessageCopyButton: 'copy',
    formatAgentActivity: text => text, formatAgentError: text => text, formatAgentMessage: text => text,
    clipboardWrite: async text => { copied.push(text); },
    loadOlderAgentMessages: () => { olderRequest = deferred(); return olderRequest.promise; },
    window: {
      setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {},
      requestAnimationFrame: callback => { callback(); return 1; }, cancelAnimationFrame() {},
      addEventListener() {}, removeEventListener() {},
    },
    ResizeObserver: class { observe() {} disconnect() {} },
    CSS: { escape: text => String(text) },
  });
  function elements(node) {
    if (Array.isArray(node)) return node.flatMap(elements);
    return node && typeof node === 'object' ? [node, ...(node.children ?? []).flatMap(elements)] : [];
  }
  function render() {
    cursor = 0;
    const page = component();
    const nodes = elements(page);
    const thread = nodes.find(node => node.props.className === 'agent-chat-thread');
    thread.props.ref.current = scroll;
    const list = nodes.find(node => node.props.className === 'agent-message-list');
    if (list) list.props.ref.current = {};
    rows = nodes.filter(node => node.type === 'article').map((node, index) => ({
      dataset: { conversationNavigationId: node.props['data-conversation-navigation-id'] },
      offsetTop: client.messages[index].top,
      getBoundingClientRect: () => ({ top: 100 + client.messages[index].top - scroll.scrollTop }),
      getAttribute: name => node.props[name],
    }));
    for (const queue of [layouts, effects]) while (queue.length) queue.shift()();
    return nodes;
  }
  const markdown = '**Completed**\n```powershell\ncd E:\\tmp; git status --short\n```\n保持原文';
  client.messages = [
    { id: 100, role: 'assistant', text: 'older page starts within a reply', top: 20 },
    { id: 101, role: 'user', text: 'same prompt', top: 160 },
    { id: 102, role: 'assistant', text: markdown, top: 400 },
    { id: 103, role: 'user', text: 'same prompt', top: 860 },
    { id: 104, role: 'assistant', text: 'current result', top: 1120 },
  ];
  render();
  let nodes = render();
  const navigation = nodes.find(node => node.type === 'navigation');
  assert.ok(navigation, 'multiple prompts expose the shared conversation navigation');
  assert.deepEqual(Array.from(navigation.props.items, item => item.sourceMessageId), ['101', '103']);
  assert.deepEqual(Array.from(navigation.props.items, item => item.content), ['same prompt', 'same prompt']);
  navigation.props.onJump(navigation.props.items[0]);
  navigation.props.onJump(navigation.props.items[1]);
  assert.deepEqual(scrollCalls.map(call => call.top), [160, 860], 'repeated prompt text must jump to the selected unique message, not the first text match');
  assert.equal(scrollCalls.at(-1).behavior, 'auto');
  client.running = true;
  client.messages = client.messages.map(message => message.id === 104 ? { ...message, text: 'still streaming' } : message);
  nodes = render();
  assert.equal(scroll.scrollTop, 860, 'streaming output must not pull a navigation jump back to the bottom');
  const articles = nodes.filter(node => node.type === 'article');
  const copyOf = id => elements(articles.find(node => node.props['data-conversation-navigation-id'] === String(id))).find(node => node.type === 'copy');
  assert.ok(copyOf(103), 'user prompts remain copyable while the Agent is working');
  assert.ok(copyOf(102), 'a completed earlier Agent reply remains copyable');
  assert.equal(copyOf(104), undefined, 'the unfinished streaming reply must not expose a copy button');
  copyOf(102).props.onCopy();
  await tick();
  assert.deepEqual(copied, [markdown], 'copy must retain Markdown fences, commands, paths, line breaks, and non-English text');
  nodes = render();
  const copiedArticle = nodes.find(node => node.type === 'article' && node.props['data-conversation-navigation-id'] === '102');
  assert.equal(elements(copiedArticle).find(node => node.type === 'copy').props.copied, true);
  timers.at(-1)();
  nodes = render();
  assert.equal(elements(nodes.find(node => node.type === 'article' && node.props['data-conversation-navigation-id'] === '102')).find(node => node.type === 'copy').props.copied, false);

  scroll.scrollTop = 700;
  nodes.find(node => node.props.className === 'agent-chat-thread').props.onScroll();
  nodes.find(node => node.type === 'button' && node.children.includes('agent.chat.older')).props.onClick();
  assert.ok(olderRequest, 'the real older-history handler requested the archive');
  // Older rows add 300 px above, while an active reply grows another 500 px
  // below. Preserving by total scrollHeight would incorrectly add both.
  scroll.scrollHeight += 800;
  client.messages = [
    { id: 98, role: 'user', text: 'archived prompt', top: 0 },
    { id: 99, role: 'assistant', text: 'archived reply', top: 100 },
    ...client.messages.map(message => ({ ...message, top: message.top + 300 })),
  ];
  render();
  olderRequest.resolve(); await tick();
  assert.equal(scroll.scrollTop, 1000, 'prepending retains the same visible message even when the trailing reply also grows');
  client.running = false;
  nodes = render();
  assert.ok(elements(nodes.find(node => node.type === 'article' && node.props['data-conversation-navigation-id'] === '104')).some(node => node.type === 'copy'), 'the final reply becomes copyable when its request completes');
  console.log('OK: Agent unique-id navigation, streaming reading position, Markdown copy feedback, and older-history anchors');
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

// Exercise the actual tool-card handler: manual and Agent launch share one action.
const manualLaunches = [];
const checkedLaunchFolders = [];
const selectTool = evaluate(pinDeclarations.get('selectTool').initializer.getText(centerTree), {
  activeTerminalId: 'launchpad', dispatch: action => manualLaunches.push(action),
  activeIdRef: { current: 'launchpad' },
  commands: { async checkProjectDirectories(paths) { checkedLaunchFolders.push(...paths); return paths.map(path => ({ path, status: 'available' })); } },
  pushRecentFolder() {}, claudeLaunchMode: 'conversation',
});
await selectTool('claude', undefined, 'E:\\tmp');
assert.deepEqual(checkedLaunchFolders, ['E:\\tmp']);
assert.equal(manualLaunches.length, 1);
assert.equal(manualLaunches[0].type, 'LAUNCH_TERMINAL_TOOL');
assert.equal(manualLaunches[0].id, 'launchpad');
assert.equal(manualLaunches[0].tool, 'claude');
assert.equal(manualLaunches[0].cwd, 'E:\\tmp');
console.log('OK: actual tool-card folder selection uses the same launch action as Coffee Agent');

// Exercise the actual history-card click: a directoryless Coffee conversation
// must open its Agent page, while native history still resumes a real CLI tab.
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
  const agentConversations = [{
    id: 'coffee-history', route: 'weixin-bound', source: '微信', title: 'hello', updatedAt: newest, messageCount: 2,
  }];
  const sortByMtime = evaluate(`${declaration('lib/history-cache.ts', 'sortByMtime').replace(/^export\s+/, '')}; sortByMtime`);
  const merged = evaluate(merge, { useMemo: callback => callback(), nativeSessions, liveSessions: [], nowMs: newest, agentConversations, sortByMtime });
  assert.equal(merged[0].id, 'coffee-history', 'the newest Agent conversation must lead mixed timestamp histories');
  assert.equal(merged.slice(0, 30).some(session => session.id === 'coffee-history'), true, 'Agent history must appear on the first visible page');
  assert.deepEqual(Array.from(merged.slice(-2), session => session.id), ['native-seconds', 'native-iso']);
  const coffee = merged[0];
  assert.equal(coffee.turn_count, 2);
  assert.equal(coffee.cwd, '');
  assert.equal(coffee.session_token, null);
  const matchesQuery = evaluate(matches, {
    useCallback: callback => callback, renamed: {},
    projectName: () => '', getToolName: tool => tool,
  });
  const allHistories = evaluate(filter, {
    useMemo: callback => callback(), availableSessions: merged, debouncedQuery: '', matchesQuery,
  });
  assert.equal(allHistories.length, 38);
  assert.equal(allHistories.slice(0, 30).some(session => session.id === coffee.id), true, 'All projects must include the directoryless Agent conversation on its first page');
  const actions = [], opened = [];
  const click = evaluate(`const click = ${handler}; click`, {
    dispatch: action => actions.push(action), setAgentError() {},
    openAgentConversation: async id => opened.push(id), crypto: { randomUUID: () => 'native-tab' },
    isTauri: false, state: { terminals: [] }, liveSessions: [],
  });
  await click(coffee);
  assert.deepEqual(opened, ['coffee-history']);
  assert.deepEqual(actions.map(action => action.type), ['OPEN_AGENT_PAGE']);
  await click({ id: 'claude-history', tool: 'claude', cwd: 'E:\\tmp', session_token: 'native-resume' });
  assert.deepEqual(actions.slice(1).map(action => action.type), ['ADD_TERMINAL']);
  const filtered = evaluate(filter, {
    useMemo: callback => callback(), availableSessions: [coffee], debouncedQuery: 'Coffee Agent', matchesQuery,
  });
  assert.equal(filtered.length, 1);
  console.log('OK: mixed timestamps show Coffee history on the first page, reopen the Agent, and preserve native CLI resume');
}
