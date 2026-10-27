import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = file => ts.createSourceFile(file,
  readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const center = source('components/center/CenterPanel.tsx');
const store = source('store/app-state.tsx');
function declaration(tree, name) {
  const node = tree.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `Missing actual ${name} declaration`);
  return node.getText(tree).replace(/^export\s+/, '');
}
function callback(name) {
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(center) === name) found = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(center);
  assert.ok(found, `Missing actual ${name} callback`);
  return found.getText(center);
}
const compile = code => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const splitLayout = await import(`data:text/javascript;base64,${Buffer.from(compile(readFileSync(new URL('../src/lib/session-split-layout.ts', import.meta.url), 'utf8'))).toString('base64')}`);
const stateApi = vm.runInNewContext(compile(`${declaration(store, 'getTabOrder')}; ${declaration(store, 'splitForSession')}; ${declaration(store, 'reducer')}; ({ getTabOrder, reducer });`), {
  ...splitLayout,
  localStorage: { setItem() {}, removeItem() {} }, crypto: { randomUUID: () => 'replacement-terminal' },
  supportsAgentStatus: () => true,
});
const native = value => JSON.parse(JSON.stringify(value));
let passed = 0;
function test(name, run) { run(); passed++; console.log(`  ok  ${name}`); }

// Check the actual rendered Agent and terminal tabs use the tested pointer and
// click handlers, rather than exercising detached copies of dead callbacks.
const renderedTabs = [];
let agentClose;
function inspect(node) {
  if (ts.isJsxOpeningElement(node)) {
    const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
    if (attrs.some(attr => attr.name.getText(center) === 'data-tab-id')) {
      renderedTabs.push(Object.fromEntries(attrs.map(attr => [attr.name.getText(center), attr.initializer?.getText(center)])));
    }
    const close = attrs.find(attr => attr.name.getText(center) === 'aria-label' && attr.initializer?.getText(center).includes('agent.page.close_agent'));
    if (close) agentClose = attrs.find(attr => attr.name.getText(center) === 'onClick')?.initializer?.expression;
  }
  ts.forEachChild(node, inspect);
}
inspect(center);
assert.equal(renderedTabs.length, 2, 'Agent and terminal branches each render a shared draggable tab');
for (const tab of renderedTabs) {
  assert.match(tab.onPointerDown, /onTabPointerDown/);
  assert.match(tab.onClick, /onTabClickGuarded/);
}
assert.ok(agentClose, 'Use the actual Agent tab close click handler');

function fixture(order = ['one', 'two', 'agent:config', 'agent:agent']) {
  let state = {
    terminals: [{ id: 'one', tool: 'claude', folderPath: 'E:\\one' }, { id: 'two', tool: 'codex', folderPath: 'E:\\two' }],
    agentPages: ['config', 'agent'], tabOrder: order,
    activeTerminalId: 'one', agentPageActive: null, diffTabActive: false,
  };
  const listeners = new Map(), actions = [], dragFrames = [];
  const dispatch = action => { actions.push(native(action)); state = stateApi.reducer(state, action); };
  const visible = () => Array.from(vm.runInNewContext(compile(callback('visibleTabs')), {
    getTabOrder: stateApi.getTabOrder, state,
    sessions: new Map(state.terminals.map(session => [session.id, session])),
    activeTerminalId: state.activeTerminalId,
  }));
  const context = {
    dispatch, tabDrag: null, tabDragSuppressClickRef: { current: false },
    tabsHeaderRef: { current: { querySelectorAll(selector) {
      assert.equal(selector, '.chrome-tab[data-tab-id]');
      return visible().map((id, index) => ({ dataset: { tabId: id }, getBoundingClientRect: () => ({ left: index * 100, width: 100 }) }));
    } } },
    setTabDrag(value) { context.tabDrag = value; dragFrames.push(native(value)); },
    document: {
      addEventListener(name, handler) { assert.ok(!listeners.has(name)); listeners.set(name, handler); },
      removeEventListener(name, handler) { assert.equal(listeners.get(name), handler); listeners.delete(name); },
    },
    page: 'config',
  };
  const api = vm.runInNewContext(compile(`const onTabPointerDown = ${callback('onTabPointerDown')}; const onTabClickGuarded = ${callback('onTabClickGuarded')}; const getTabDragStyle = ${callback('getTabDragStyle')}; const close = ${agentClose.getText(center)}; ({ onTabPointerDown, onTabClickGuarded, getTabDragStyle, close });`), context);
  const centerX = id => visible().indexOf(id) * 100 + 50;
  function down(id, options = {}) {
    api.onTabPointerDown({ button: options.button ?? 0, clientX: centerX(id), target: { closest: selector => options.close && selector === '.tab-close-btn' ? {} : null } }, id);
  }
  function move(x) { listeners.get('pointermove')?.({ clientX: x }); }
  function up(x) { listeners.get('pointerup')?.({ clientX: x }); }
  return { api, actions, dragFrames, listeners, visible, down, move, up, centerX,
    get state() { return state; }, dispatch };
}

test('message settings drag left across terminal tabs without changing the focused surface', () => {
  const f = fixture();
  f.down('agent:config'); f.move(-50);
  assert.equal(f.dragFrames.at(-1).tabId, 'agent:config');
  assert.deepEqual(native(f.api.getTabDragStyle('one', 0)), { transform: 'translateX(100px)' });
  f.up(-50);
  assert.deepEqual(f.actions, [{ type: 'REORDER_TAB', tabId: 'agent:config', beforeId: 'one' }]);
  assert.deepEqual(f.visible(), ['agent:config', 'one', 'two', 'agent:agent']);
  assert.equal(f.state.activeTerminalId, 'one'); assert.equal(f.state.agentPageActive, null);
  assert.equal(f.listeners.size, 0); assert.equal(f.dragFrames.at(-1), null);
});

test('Coffee Agent drags right through terminals and message settings', () => {
  const f = fixture(['one', 'agent:agent', 'two', 'agent:config']);
  f.down('agent:agent'); f.move(500);
  assert.deepEqual(native(f.api.getTabDragStyle('two', 2)), { transform: 'translateX(-100px)' });
  f.up(500);
  assert.deepEqual(f.actions, [{ type: 'REORDER_TAB', tabId: 'agent:agent', beforeId: null }]);
  assert.deepEqual(f.visible(), ['one', 'two', 'agent:config', 'agent:agent']);
});

test('terminal dragging shares mixed tab order and keeps real terminal objects and numbering', () => {
  const f = fixture(['one', 'agent:config', 'two', 'agent:agent']);
  const original = [...f.state.terminals];
  f.down('one'); f.move(600); f.up(600);
  assert.deepEqual(f.visible(), ['agent:config', 'two', 'agent:agent', 'one']);
  assert.deepEqual(Array.from(f.state.terminals, tab => tab.id), ['two', 'one']);
  assert.equal(f.state.terminals[0], original[1]); assert.equal(f.state.terminals[1], original[0]);
  assert.equal(f.state.activeTerminalId, 'one');
});

test('the click generated after dragging never activates the dropped Agent tab', () => {
  const f = fixture();
  f.down('agent:agent'); f.move(-50); f.up(-50);
  f.api.onTabClickGuarded('agent:agent');
  assert.equal(f.actions.length, 1); assert.equal(f.state.agentPageActive, null);
  f.api.onTabClickGuarded('agent:agent');
  assert.deepEqual(f.actions.at(-1), { type: 'OPEN_AGENT_PAGE', page: 'agent' });
  assert.equal(f.state.agentPageActive, 'agent');
});

test('a normal settings click remains a click below the drag threshold', () => {
  const f = fixture(); const x = f.centerX('agent:config');
  f.down('agent:config'); f.move(x + 4); f.up(x + 4); f.api.onTabClickGuarded('agent:config');
  assert.deepEqual(f.actions, [{ type: 'OPEN_AGENT_PAGE', page: 'config' }]);
  assert.equal(f.state.agentPageActive, 'config'); assert.equal(f.listeners.size, 0);
});

test('close buttons do not start dragging and use the real Agent close action', () => {
  const f = fixture();
  f.down('agent:config', { close: true });
  assert.equal(f.listeners.size, 0); f.move(-100); f.up(-100);
  let stopped = false;
  f.api.close({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.deepEqual(f.actions, [{ type: 'CLOSE_AGENT_PAGE', page: 'config' }]);
  assert.deepEqual(f.visible(), ['one', 'two', 'agent:agent']);
});

test('non-primary buttons cannot start a drag', () => {
  const f = fixture();
  for (const button of [1, 2]) f.down('agent:config', { button });
  assert.equal(f.listeners.size, 0); assert.equal(f.actions.length, 0);
});

test('hidden terminals retain their lifecycle and are excluded from drag geometry', () => {
  const f = fixture(['one', 'two', 'agent:config', 'agent:agent']);
  f.dispatch({ type: 'SET_TERMINAL_HIDDEN', id: 'two', isHidden: true });
  f.actions.length = 0;
  f.down('agent:config'); f.move(-100); f.up(-100);
  assert.deepEqual(f.visible(), ['agent:config', 'one', 'agent:agent']);
  assert.deepEqual(Array.from(stateApi.getTabOrder(f.state)), ['agent:config', 'one', 'two', 'agent:agent']);
  assert.equal(f.state.terminals.find(tab => tab.id === 'two').isHidden, true);
});

test('close, reopen, new launch and terminal restart preserve remaining mixed order', () => {
  const f = fixture(['agent:config', 'one', 'agent:agent', 'two']);
  f.dispatch({ type: 'CLOSE_AGENT_PAGE', page: 'config' });
  f.dispatch({ type: 'OPEN_AGENT_PAGE', page: 'config' });
  f.dispatch({ type: 'LAUNCH_TERMINAL_TOOL', id: 'three', tool: 'claude', cwd: 'E:\\three' });
  f.dispatch({ type: 'RESTART_TERMINAL', id: 'one', newId: 'one-new' });
  assert.deepEqual(f.visible(), ['one-new', 'agent:agent', 'two', 'agent:config', 'three']);
  assert.equal(new Set(f.visible()).size, f.visible().length);
});

test('tool selection stays outside the strip and becomes a real tab only after launch', () => {
  const f = fixture();
  f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'home', tool: null, folderPath: null } });
  assert.equal(f.visible().includes('home'), false);
  f.down('agent:config'); f.move(-100); f.up(-100);
  assert.deepEqual(f.visible(), ['agent:config', 'one', 'two', 'agent:agent']);
  assert.equal(f.state.activeTerminalId, 'home', 'reordering does not switch away from the selector');
  f.dispatch({ type: 'LAUNCH_TERMINAL_TOOL', id: 'home', tool: 'claude', cwd: 'D:\\test' });
  assert.equal(f.visible().at(-1), 'home');
  assert.equal(f.state.terminals.find(session => session.id === 'one').tool, 'claude');
});

test('closing the final session leaves an untabbed tool selector', () => {
  const f = fixture();
  for (const page of ['agent', 'config']) f.dispatch({ type: 'CLOSE_AGENT_PAGE', page });
  for (const id of ['one', 'two']) f.dispatch({ type: 'REMOVE_TERMINAL', id });
  assert.deepEqual(f.visible(), []);
  assert.equal(f.state.terminals.find(session => session.id === f.state.activeTerminalId).tool, null);
});

test('closing a session selects a remaining real tab before the idle selector', () => {
  const f = fixture();
  f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'home', tool: null, folderPath: null } });
  f.dispatch({ type: 'SET_ACTIVE_TERMINAL', id: 'two' });
  f.dispatch({ type: 'REMOVE_TERMINAL', id: 'two' });
  assert.equal(f.state.activeTerminalId, 'one');
  assert.equal(f.visible().includes('home'), false);
});

test('new session reuses the selector, leaves application configuration and keeps running tabs', () => {
  const f = fixture();
  const open = () => vm.runInNewContext(compile(`(${callback('openNewSession')})()`), {
    terminals: f.state.terminals, dispatch: f.dispatch,
    crypto: { randomUUID: () => 'new-home' },
  });
  f.dispatch({ type: 'SET_TOOL_SETTINGS_OPEN', open: true });
  f.dispatch({ type: 'OPEN_AGENT_PAGE', page: 'agent' });
  open();
  assert.equal(f.state.toolSettingsOpen, false);
  assert.equal(f.state.agentPageActive, null);
  assert.equal(f.state.activeTerminalId, 'new-home');
  const sessions = f.state.terminals.length;
  open();
  assert.equal(f.state.terminals.length, sessions, 'repeated clicks reuse the idle selector');
  assert.deepEqual(f.visible(), ['one', 'two', 'agent:config', 'agent:agent']);
});

test('Explorer preview opens on the right and follows the user surface choice without changing terminals', () => {
  const f = fixture();
  f.dispatch({ type: 'SET_DIFF_MODE', mode: 'overlay' });
  f.dispatch({ type: 'OPEN_AGENT_PAGE', page: 'agent' });
  f.dispatch({ type: 'TOGGLE_RIGHT_PANEL' });
  const terminals = f.state.terminals;
  const selection = { path: 'D:/Test/README.md', repoRoot: 'D:/Test', folderPath: 'D:/Test', rel: 'README.md', kind: 'file', fileSize: 120 };
  f.dispatch({ type: 'SET_DIFF_SELECTION', selection });
  assert.equal(f.state.diffMode, 'overlay');
  assert.equal(f.state.diffTabActive, false);
  assert.equal(f.state.agentPageActive, 'agent');
  assert.equal(f.state.rightPanelHidden, false);
  assert.equal(f.state.terminals, terminals);
  f.dispatch({ type: 'SET_DIFF_MODE', mode: 'tab' });
  assert.equal(f.state.diffTabActive, true);
  assert.equal(f.state.agentPageActive, null);
  f.dispatch({ type: 'SET_ACTIVE_TERMINAL', id: 'two' });
  assert.equal(f.state.diffTabActive, false);
  f.dispatch({ type: 'SET_DIFF_SELECTION', selection });
  assert.equal(f.state.diffTabActive, true);
  assert.equal(f.state.terminals, terminals);
  f.dispatch({ type: 'TOGGLE_RIGHT_PANEL' });
  f.dispatch({ type: 'SET_DIFF_MODE', mode: 'overlay' });
  assert.equal(f.state.diffTabActive, false);
  assert.equal(f.state.rightPanelHidden, false, 'fold back reveals the right panel');
  f.dispatch({ type: 'CLEAR_DIFF' });
  assert.equal(f.state.diffSelection, null);
  assert.equal(f.state.activeTerminalId, 'two');
});

test('ordinary change selection keeps the overlay surface preference', () => {
  const f = fixture();
  f.dispatch({ type: 'SET_DIFF_MODE', mode: 'overlay' });
  f.dispatch({ type: 'SET_DIFF_SELECTION', selection: { path: 'D:/Test/index.ts', kind: 'uncommitted' } });
  assert.equal(f.state.diffMode, 'overlay');
  assert.equal(f.state.diffTabActive, false);
});

test('closing a session group removes its children and split references atomically', () => {
  const f = fixture();
  f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'child', parentId: 'one', tool: 'codex' } });
  f.dispatch({ type: 'OPEN_SESSION_SPLIT', id: 'child', targetId: 'two', edge: 'right' });
  f.dispatch({ type: 'CLOSE_TERMINAL_GROUP', id: 'one', childIds: ['child'], keepChildren: false });
  assert.deepEqual(native(f.state.terminals.map(tab => tab.id)), ['two']);
  assert.equal(f.state.activeTerminalId, 'two');
  assert.deepEqual(native(splitLayout.splitSessionIds(f.state.sessionSplit)), ['two'], 'split layout retains only the surviving session');
  assert.ok(!f.state.tabOrder.includes('one') && !f.state.tabOrder.includes('child'));
});
test('keeping children detaches them without replacing sessions or affecting unrelated tabs', () => {
  const f = fixture();
  f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'child', parentId: 'one', tool: 'codex', resumeToken: 'original', draft: 'keep draft' } });
  f.dispatch({ type: 'SET_ACTIVE_TERMINAL', id: 'child' });
  f.dispatch({ type: 'CLOSE_TERMINAL_GROUP', id: 'one', childIds: ['child'], keepChildren: true });
  const child = f.state.terminals.find(tab => tab.id === 'child');
  assert.equal(child.parentId, undefined); assert.equal(child.resumeToken, 'original'); assert.equal(child.draft, 'keep draft');
  assert.equal(f.state.activeTerminalId, 'child'); assert.ok(f.state.terminals.some(tab => tab.id === 'two'));
});
test('restoring child history reuses native identity and positions it next to the parent', () => {
  const f=fixture();
  const parent={id:'restored-parent',tool:'claude',resumeToken:'parent-history',folderPath:'D:/same'};
  const child={id:'restored-child',tool:'codex',resumeToken:'child-history',folderPath:'D:/same'};
  f.dispatch({type:'RESTORE_WORKER_SESSION',parent,child});f.dispatch({type:'RESTORE_WORKER_SESSION',parent,child});
  assert.equal(f.state.terminals.filter(tab=>tab.resumeToken==='parent-history').length,1);
  assert.equal(f.state.terminals.filter(tab=>tab.resumeToken==='child-history').length,1);
  assert.equal(f.state.activeTerminalId,child.id);assert.equal(f.state.terminals.find(tab=>tab.id===child.id).parentId,parent.id);
  assert.equal(f.state.tabOrder.indexOf(child.id),f.state.tabOrder.indexOf(parent.id)+1);
});
test('restoring a known tab before its native token arrives never duplicates or restarts it', () => {
  const f=fixture();f.dispatch({type:'ADD_TERMINAL',session:{id:'child',tool:'codex',isHidden:true,gambitDraft:'Unsent draft'}});
  f.dispatch({type:'RESTORE_WORKER_SESSION',parent:{id:'one',tool:'claude'},child:{id:'child',tool:'codex',resumeToken:'newly-discovered-token'}});
  assert.equal(f.state.terminals.filter(tab=>tab.id==='child').length,1);
  const child=f.state.terminals.find(tab=>tab.id==='child');assert.equal(child.gambitDraft,'Unsent draft');assert.equal(child.isHidden,false);
});
test('making an existing child independent preserves its session and draft', () => {
  const f=fixture();f.dispatch({type:'ADD_TERMINAL',session:{id:'child',parentId:'one',tool:'codex',resumeToken:'same-native',gambitDraft:'Keep this'}});
  f.dispatch({type:'RESTORE_WORKER_SESSION',child:{id:'other-id',tool:'codex',resumeToken:'same-native'}});
  const child=f.state.terminals.find(tab=>tab.id==='child');assert.equal(child.parentId,undefined);assert.equal(child.gambitDraft,'Keep this');
  assert.equal(f.state.terminals.some(tab=>tab.id==='other-id'),false);assert.equal(f.state.activeTerminalId,'child');assert.ok(f.state.terminals.some(tab=>tab.id==='one'));
});
console.log(`\n${passed} shared tab, preview and new-session tests passed.`);
