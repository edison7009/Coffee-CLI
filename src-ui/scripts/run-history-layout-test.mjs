import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile('HistoryBoard.tsx', readFileSync(new URL('../src/components/right/HistoryBoard.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const expressions = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer) expressions.set(node.name.getText(source), node.initializer.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
const context = vm.createContext({
  useMemo: callback => callback(), useCallback: callback => callback,
  getToolName: tool => ({ claude: 'Claude Code', codex: 'Codex CLI', openclaw: 'OpenClaw' }[tool] ?? tool),
  hidden: new Set(['claude:hidden']), pinned: new Set(['codex:pinned']),
  renamed: { 'claude:renamed': 'Custom session title' },
  orchestration: { tasks: [] }, state: { terminals: [] },
});
function evaluate(name) {
  assert.ok(expressions.has(name), `Missing actual ${name}`);
  const compiled = ts.transpileModule(`(${expressions.get(name)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return vm.runInContext(compiled, context);
}
context.projectName = evaluate('projectName');
context.normCwd = evaluate('normCwd');
const session = (id, cwd, tool = 'claude') => ({ id, cwd, tool, name: id });
context.baseSessions = [
  session('recent', 'D:\\Coffee-CLI'), session('same-project', 'd:/coffee-cli/'),
  session('hidden', 'D:/hidden'), session('pinned', 'D:/EchoBird', 'codex'),
  session('duplicate-a', '/one/shared'), session('duplicate-b', '/two/shared'),
  session('case-a', '/projects/App'), session('case-b', '/projects/app'),
  session('agent', '', 'coffee-agent'), session('claw', '/internal/workspace', 'openclaw'),
  session('renamed', 'D:/Coffee-CLI'),
];
const original = [...context.baseSessions];
context.availableSessions = evaluate('availableSessions');
assert.equal(context.availableSessions[0].id, 'pinned');
assert.equal(context.availableSessions.some(session => session.id === 'hidden'), false);
assert.deepEqual(context.baseSessions, original, 'sorting the visible list never mutates the shared history cache');
context.projects = evaluate('projects');
const coffee = context.projects.find(group => group.name === 'Coffee-CLI');
assert.deepEqual(Array.from(coffee.sessions, session => session.id), ['recent', 'same-project', 'renamed']);
assert.equal(context.projects.some(group => group.name === '/one/shared'), true);
assert.equal(context.projects.some(group => group.name === '/two/shared'), true);
assert.equal(context.projects.filter(group => ['App', 'app'].includes(group.name)).length, 2, 'case-sensitive Unix directories stay distinct');
assert.equal(context.projects.find(group => group.sessions[0].id === 'agent').name, 'Coffee Agent');
assert.equal(context.projects.find(group => group.sessions[0].id === 'claw').name, 'OpenClaw');
context.collapsedProjects = new Set([coffee.key]);
context.layout = 'projects';
let rows = evaluate('rows');
assert.equal(rows.filter(row => row.kind === 'project').length, context.projects.length);
assert.equal(rows.some(row => row.kind === 'session' && row.session.id === 'recent'), false);
assert.equal(rows.some(row => row.kind === 'session' && row.session.id === 'pinned'), true);
context.layout = 'list';
rows = evaluate('rows');
assert.deepEqual(Array.from(rows, row => row.session.id), Array.from(context.availableSessions, session => session.id), 'switching back restores the original session order');
const matches = evaluate('matchesQuery');
assert.equal(matches(original.at(-1), '  CUSTOM session  '), true);
assert.equal(matches(original.at(-1), 'renamed'), false, 'search follows custom titles');
assert.equal(matches(original[4], '/one/shared'), true, 'search includes full project paths');
assert.equal(matches(original[3], 'codex cli'), true);
assert.equal(matches(original[8], 'coffee agent'), true);
assert.equal(matches(original[9], 'internal/workspace'), false, 'directoryless tools do not expose internal workspaces');
assert.equal(matches(original[0], 'no such conversation'), false);
console.log('OK: hidden/pinned sessions, stable cache, directory grouping, duplicate names, case-sensitive paths, directoryless tools, collapse/toggle, renamed title and project/tool search');

context.state = { terminals: [
  { tool: 'claude', resumeToken: 'active', agentStatus: 'working', folderPath: 'D:/same' },
  { tool: 'claude', resumeToken: 'idle', agentStatus: 'idle', folderPath: 'D:/same' },
  { tool: 'codex', resumeToken: 'waiting', agentStatus: 'wait_input' },
  { tool: 'kimicode', resumeToken: 'active', agentStatus: 'idle' },
  { tool: 'hermes', agentStatus: 'working', folderPath: 'D:/same' },
] };
let working = evaluate('workingSessions');
assert.deepEqual(Array.from(working), ['claude:active'], 'only the exact working tool/token is projected; cwd and unknown tokens never bind');
context.state.terminals[0].agentStatus = 'idle';
assert.equal(evaluate('workingSessions').size, 0, 'finished tasks release the spinner slot');
context.state.terminals[0].agentStatus = 'wait_input';
assert.equal(evaluate('workingSessions').size, 0, 'permission waiting is not shown as working');
context.state.terminals = [];
assert.equal(evaluate('workingSessions').size, 0, 'closing a tab clears its indicator');
console.log('OK: history working state uses exact native identity and clears for waiting, completion and closed tabs');

// Exercise the real history click handler together with the shared reducer.
context.nativeSessions = [];
Object.defineProperty(context, 'liveSessions', { get: () => evaluate('liveSessions') });
const splitExports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/session-split-layout.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: splitExports });
Object.assign(context, splitExports);
const store = ts.createSourceFile('app-state.tsx', readFileSync(new URL('../src/store/app-state.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = ['getTabOrder', 'splitForSession', 'reducer'].map(name => store.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(store).replace(/^export\s+/, ''));
let nextId = 0;
context.crypto = { randomUUID: () => `history-tab-${++nextId}` };
context.localStorage = { setItem() {}, removeItem() {} };
context.reducer = vm.runInContext(ts.transpileModule(declarations.join('\n') + '\nreducer;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, context);
context.setAgentError = error => { context.error = error; };
context.openAgentConversation = async id => { context.agentOpened = id; };
context.dispatch = action => { context.state = context.reducer(context.state, action); };
const openHistory = evaluate('handleViewHistory');
const saved = { ...session('history-id', 'D:/Coffee-CLI'), session_token: 'native-1' };
function reset(terminals = [], native = false) {
  context.state = { terminals, tabOrder: terminals.map(tab => tab.id), activeTerminalId: terminals[0]?.id ?? null, sessionSplit: null, agentPages: [], agentPageActive: null, diffTabActive: false };
  context.isTauri = native;
  context.error = '';
  context.commands = { getTerminalSessionToken: async () => null };
}
reset();
await openHistory(saved);
const first = context.state.terminals[0];
assert.equal(first.resumeToken, saved.session_token);
context.dispatch({ type: 'ADD_TERMINAL', session: { id: 'other', tool: 'codex', folderPath: saved.cwd } });
context.state.agentPageActive = 'config';
context.state.diffTabActive = true;
await openHistory(saved);
assert.equal(context.state.terminals.length, 2);
assert.equal(context.state.activeTerminalId, first.id);
assert.equal(context.state.terminals[0], first, 'switching preserves the mounted session object and running process');
assert.equal(context.state.agentPageActive, null);
assert.equal(context.state.diffTabActive, false);
await Promise.all(Array.from({ length: 5 }, () => openHistory(saved)));
assert.equal(context.state.terminals.length, 2, 'rapid repeated opens do not add tabs');
assert.equal(context.state.activeTerminalId, first.id, 'never activate the discarded duplicate ID');
await openHistory({ ...saved, session_token: 'native-2' });
await openHistory({ ...saved, tool: 'codex' });
assert.equal(context.state.terminals.length, 4, 'same directory/title and cross-tool tokens remain distinct');
const beforeLegacy = context.state;
await openHistory({ ...saved, session_token: null });
assert.equal(context.state, beforeLegacy, 'legacy entries without resume identity are not opened');
context.dispatch({ type: 'SET_TERMINAL_HIDDEN', id: first.id, isHidden: true });
await openHistory(saved);
assert.equal(context.state.terminals.find(tab => tab.id === first.id).isHidden, false);
context.dispatch({ type: 'REMOVE_TERMINAL', id: first.id });
await openHistory(saved);
assert.notEqual(context.state.activeTerminalId, first.id, 'a closed session can be reopened');
assert.equal(context.state.terminals.filter(tab => tab.tool === saved.tool && tab.resumeToken === saved.session_token).length, 1);

reset([{ id: 'live-cli', tool: 'claude', folderPath: saved.cwd, gambitDraft: 'keep draft', restartKey: 3 }], true);
let lookups = 0;
context.commands.getTerminalSessionToken = async id => { assert.equal(id, 'live-cli'); lookups++; await Promise.resolve(); return saved.session_token; };
await Promise.all([openHistory(saved), openHistory(saved), openHistory(saved)]);
assert.equal(context.state.terminals.length, 1, 'concurrent probes reuse an already-running native terminal');
assert.equal(context.state.activeTerminalId, 'live-cli');
assert.equal(context.state.terminals[0].gambitDraft, 'keep draft');
assert.equal(context.state.terminals[0].restartKey, 3);
lookups = 0;
await openHistory(saved);
assert.equal(lookups, 0, 'a known native ID switches immediately without IPC');

reset([{ id: 'live-cli', tool: 'claude', folderPath: saved.cwd }], true);
context.commands.getTerminalSessionToken = async () => { throw new Error('native lookup failed'); };
await openHistory(saved);
assert.equal(context.state.terminals.length, 1, 'failed identity checks never start a potentially duplicate writer');
assert.match(context.error, /native lookup failed/);
reset([{ id: 'live-cli', tool: 'claude', folderPath: saved.cwd }], true);
await openHistory(saved);
assert.equal(context.state.terminals.length, 2, 'same cwd alone cannot identify a native conversation');

const liveTab = { id: 'live-no-token', tool: 'claude', folderPath: saved.cwd, gambitDraft: 'keep live draft' };
reset([liveTab, { id: 'split-target', tool: 'codex', folderPath: saved.cwd }], true);
context.state.activeTerminalId = 'split-target';
const liveEntry = { ...saved, id: `live:${liveTab.id}`, session_token: null };
await openHistory(liveEntry);
assert.equal(context.state.activeTerminalId, liveTab.id, 'a live row without a native token activates its existing tab');
assert.equal(context.state.terminals.length, 2);
assert.equal(context.state.terminals[0], liveTab, 'live row activation preserves the session and draft');
await openHistory(liveEntry, { targetId: 'split-target', edge: 'right' });
assert.deepEqual(Array.from(context.splitSessionIds(context.state.sessionSplit)), ['split-target', liveTab.id]);
assert.equal(context.state.terminals.length, 2, 'splitting a live row reuses its existing session');

reset();
await openHistory({ ...saved, tool: 'coffee-agent', session_token: null });
assert.equal(context.agentOpened, saved.id);
assert.equal(context.state.terminals.length, 0, 'Coffee Agent keeps its existing page-based open flow');
console.log('OK: repeat/rapid history opens, hidden/closed tabs, cross-tool identity, live native IDs, live row activation/split reuse, draft/process preservation, lookup failure and Agent flow');

context.setPreview = () => {};
context.hideSession = (tool, id) => { context.hiddenCalls.push([tool, id]); };
context.activeAgentConversation = null;
const deleteHistory = evaluate('handleDeleteHistory');
for (const tool of ['claude', 'codex']) for (const mode of ['terminal', 'conversation']) {
  reset([
    { id: 'closing', tool, resumeToken: 'native-1', [`${tool}Mode`]: mode },
    { id: 'duplicate', tool, resumeToken: 'native-1' },
    { id: 'unrelated', tool, resumeToken: 'native-2', folderPath: saved.cwd },
    { id: 'other-tool', tool: tool === 'claude' ? 'codex' : 'claude', resumeToken: 'native-1', folderPath: saved.cwd },
  ]);
  context.hiddenCalls = [];
  context.dispatch({ type: 'OPEN_SESSION_SPLIT', id: 'unrelated', targetId: 'closing', edge: 'right' });
  context.state.activeTerminalId = 'closing';
  await deleteHistory({ ...saved, tool });
  assert.deepEqual(context.state.terminals.map(tab => tab.id), ['unrelated', 'other-tool'], `${tool}/${mode}: remove only matching conversation tabs`);
  assert.equal(context.state.activeTerminalId, 'unrelated');
  assert.deepEqual(Array.from(context.splitSessionIds(context.state.sessionSplit)), ['unrelated']);
  assert.deepEqual(context.hiddenCalls, [[tool, saved.id]]);
  assert.ok(!context.state.tabOrder.includes('closing') && !context.state.tabOrder.includes('duplicate'));
}
reset([{ id: 'last-tab', tool: 'claude' }]);
context.hiddenCalls = [];
await deleteHistory({ ...saved, id: 'live:last-tab', session_token: null });
assert.equal(context.state.terminals.length, 1);
assert.equal(context.state.terminals[0].tool, null, 'deleting the last live row returns to the launcher');
assert.notEqual(context.state.activeTerminalId, 'last-tab');

reset([{ id: 'probe-match', tool: 'claude' }, { id: 'probe-other', tool: 'claude', folderPath: saved.cwd }], true);
context.hiddenCalls = [];
context.commands.getTerminalSessionToken = async id => id === 'probe-match' ? saved.session_token : 'different-token';
await deleteHistory(saved);
assert.deepEqual(context.state.terminals.map(tab => tab.id), ['probe-other'], 'native identity resolves a terminal before its UI token arrives');
assert.deepEqual(context.hiddenCalls, [['claude', saved.id]]);

reset([{ id: 'unknown', tool: 'claude', folderPath: saved.cwd }], true);
context.hiddenCalls = [];
context.commands.getTerminalSessionToken = async () => { throw new Error('native lookup failed'); };
await deleteHistory(saved);
assert.equal(context.state.terminals[0].id, 'unknown');
assert.equal(context.hiddenCalls.length, 0, 'failed identity checks neither close nor hide a possibly open session');
assert.match(context.error, /native lookup failed/);
context.commands.getTerminalSessionToken = async () => null;
await deleteHistory({ ...saved, session_token: null });
assert.equal(context.state.terminals[0].id, 'unknown', 'legacy records never close a tab based on its directory');

reset();
context.state.agentPages = ['agent', 'config'];
context.state.agentPageActive = 'agent';
context.activeAgentConversation = 'current-agent';
context.hiddenCalls = [];
await deleteHistory({ ...saved, tool: 'coffee-agent', id: 'older-agent', session_token: null });
assert.equal(context.state.agentPageActive, 'agent', 'deleting another Agent conversation preserves the open page');
await deleteHistory({ ...saved, tool: 'coffee-agent', id: 'current-agent', session_token: null });
assert.deepEqual(context.state.agentPages, ['config']);
console.log('OK: history deletion closes exact desktop/terminal tabs, updates split/tab order, preserves unrelated sessions, returns to the launcher, probes native IDs and closes only the matching Agent page');
