import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiled = await build({
  stdin: { contents: 'export * from "./src/lib/agent-tools"; export * from "./src/lib/terminal-observer"; export * from "./src/lib/terminal-output-scheduler"; export * from "./src/lib/terminal-control"; export { reducer, getTabOrder } from "./src/store/app-state";', resolveDir: root },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'],
  plugins: [{ name: 'test-reducer', setup(builder) {
    builder.onLoad({ filter: /app-state\.tsx$/ }, async ({ path }) => ({ contents: (await readFile(path, 'utf8')).replace('function reducer(', 'export function reducer('), loader: 'tsx' }));
  } }],
});
const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/xterm');
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`  ok  ${name}`); }
function fixture({ deferOpen = false } = {}) {
  const writes = [], actions = [], directories = [], files = [], mounted = new Map();
  const stateRef = { current: { terminals: [], activeTerminalId: null, tabOrder: [], diffTabActive: false, diffMode: 'overlay', currentLang: 'zh-CN' } };
  const module = { exports: {} };
  let cancelled = false;
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, require, console, Date, performance, setTimeout, clearTimeout, crypto: { randomUUID },
    localStorage: { getItem: () => 'terminal', setItem() {} }, requestAnimationFrame: () => {},
    window: { __TAURI_INTERNALS__: { invoke: async (command, args) => {
      if (command === 'list_tools') return [{ id: 'claude', displayName: 'Claude Code' }, { id: 'codex', displayName: 'Codex' }];
      if (command === 'check_tools_installed') return { claude: true, codex: true };
      if (command === 'get_native_history') return [{ id: 'win', tool: 'claude', cwd: 'D:\\Project', session_token: 'resume-id' }, { id: 'unix', tool: 'claude', cwd: '/Project', session_token: 'unix-id' }];
      if (command === 'resolve_project_directory') { if (args.path === 'missing') throw new Error('Directory does not exist'); return args.path.startsWith('canonical:') ? args.path : `canonical:${args.path}`; }
      if (command === 'tier_terminal_input' || command === 'tier_terminal_kill') { writes.push({ command, ...args }); return; }
      throw new Error(`Unexpected IPC ${command}`);
    } } },
  });
  const api = module.exports;
  function mount(id) {
    const term = new Terminal({ cols: 40, rows: 5, scrollback: 5000 });
    term.paste = text => { api.forwardTerminalInput(id, text).catch(() => {}); };
    api.registerSession(id, term);
    const stopObserver = api.registerTerminalObserver(id, term);
    const stopControl = api.registerTerminalControl(id, term, () => {});
    api.setTerminalControlReady(id, true);
    mounted.set(id, () => { stopObserver(); stopControl(); api.unregisterSession(id); term.dispose(); });
  }
  const dispatch = action => {
    if (action.type === 'ADD_TERMINAL' && action.session.tool === 'claude') action = { ...action, session: { ...action.session, claudeMode: 'terminal' } };
    if (action.type === 'LAUNCH_TERMINAL_TOOL' && action.tool === 'claude') action = { ...action, claudeMode: 'terminal' };
    if ((action.type === 'ADD_TERMINAL' || action.type === 'LAUNCH_TERMINAL_TOOL') && deferOpen) {
      deferOpen = false;
      setTimeout(() => dispatch(action), 10);
      return;
    }
    actions.push(action);
    stateRef.current = api.reducer(stateRef.current, action);
    if (action.type === 'ADD_TERMINAL' && action.session.tool) mount(action.session.id);
    if (action.type === 'LAUNCH_TERMINAL_TOOL' && action.tool) mount(action.id);
    if (action.type === 'REMOVE_TERMINAL') { mounted.get(action.id)?.(); mounted.delete(action.id); }
  };
  const execute = api.createAgentToolExecutor({ stateRef, dispatch, pending: async () => !cancelled, isCancelled: () => cancelled });
  return { api, stateRef, dispatch, execute: (name, args = {}, metadata = {}) => execute({ requestId: 'request', name, arguments: args, ...metadata }), writes, actions, directories, files, mount, cancel: () => { cancelled = true; }, dispose: () => { mounted.forEach(stop => stop()); } };
}
await test('coordinated worker tabs group after the parent without stealing focus or closing settings', async () => {
  const f = fixture();
  try {
    f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'parent', tool: 'claude', folderPath: 'project' } });
    f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'unrelated', tool: 'codex', folderPath: 'other' } });
    f.dispatch({ type: 'SET_TOOL_SETTINGS_OPEN', open: true });
    const focused = f.stateRef.current.activeTerminalId;
    for (const id of ['worker-1', 'worker-2']) {
      const result = await f.execute('sessions_open', { tool: 'codex', cwd: 'project' }, { parentId: 'parent', sessionId: id, background: true });
      assert.equal(result.ready, true); assert.equal(result.sessionId, id);
      assert.equal(f.stateRef.current.activeTerminalId, focused); assert.equal(f.stateRef.current.toolSettingsOpen, true);
      assert.equal(f.stateRef.current.terminals.find(tab => tab.id === id).parentId, 'parent');
    }
    assert.deepEqual([...f.api.getTabOrder(f.stateRef.current)], ['parent','worker-1','worker-2','unrelated']);
    const before = f.actions.length;
    await assert.rejects(f.execute('sessions_open', { tool: 'codex', cwd: 'project' }, { parentId: 'parent', sessionId: 'worker-1', background: true }), /已存在/);
    assert.equal(f.actions.length, before, 'repeated delivery cannot replace a running worker');
    f.dispatch({ type: 'SET_ACTIVE_TERMINAL', id: 'worker-1' });
    assert.equal(f.stateRef.current.activeTerminalId, 'worker-1'); assert.equal(f.stateRef.current.toolSettingsOpen, false);
  } finally { f.dispose(); }
});
await test('remote open dispatches an ordinary visible tab with its own validated directory and preserves previous cwd', async () => {
  const f = fixture();
  try {
    f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'manual', tool: 'claude', folderPath: 'old-project' } });
    const opened = await f.execute('sessions_open', { tool: 'codex', cwd: 'new-project' });
    const tab = f.stateRef.current.terminals.find(tab => tab.id === opened.sessionId);
    assert.equal(tab.tool, 'codex'); assert.equal(tab.folderPath, 'canonical:new-project'); assert.equal(tab.strictCwd, true);
    assert.equal(f.stateRef.current.activeTerminalId, tab.id);
    assert.equal(f.stateRef.current.terminals.find(tab => tab.id === 'manual').folderPath, 'old-project');
    assert.equal(opened.ready, true); assert.equal(opened.screen.sessionId, tab.id);
    const before = f.actions.length;
    await assert.rejects(f.execute('sessions_open', { tool: 'claude', cwd: 'missing' }), /does not exist/);
    assert.equal(f.actions.length, before);
    await assert.rejects(f.execute('sessions_open', { tool: 'unknown', cwd: 'project' }), /CLI/);
    await assert.rejects(f.execute('sessions_open', { cwd: 'project' }), /工具/);
    await assert.rejects(f.execute('sessions_open', { tool: '   ', cwd: 'project' }), /工具/);
    await assert.rejects(f.execute('sessions_open', { tool: 'claude' }), /目录/);
    await assert.rejects(f.execute('sessions_open', { tool: 'claude', cwd: '   ' }), /目录/);
    assert.equal(f.actions.length, before);
  } finally { f.dispose(); }
});
await test('remote open waits for React to publish the new visible tab before checking for closure', async () => {
  const f = fixture({ deferOpen: true });
  try {
    const opened = await f.execute('sessions_open', { tool: 'claude', cwd: 'chosen-project' });
    assert.equal(opened.ready, true);
    assert.equal(f.stateRef.current.activeTerminalId, opened.sessionId);
    assert.equal(f.stateRef.current.terminals.find(tab => tab.id === opened.sessionId).folderPath, 'canonical:chosen-project');
  } finally { f.dispose(); }
});
await test('manual folder selection and remote open use the same visible launch action', async () => {
  const f = fixture();
  try {
    f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'manual', tool: null, folderPath: 'previous-project' } });
    f.dispatch({ type: 'LAUNCH_TERMINAL_TOOL', id: 'manual', tool: 'claude', cwd: 'canonical:chosen-project' });
    const manual = f.stateRef.current.terminals.find(tab => tab.id === 'manual');
    assert.equal(manual.folderPath, 'canonical:chosen-project');
    const opened = await f.execute('sessions_open', { tool: 'claude', cwd: 'chosen-project' });
    const remote = f.stateRef.current.terminals.find(tab => tab.id === opened.sessionId);
    assert.equal(remote.tool, manual.tool);
    assert.equal(remote.folderPath, manual.folderPath);
    assert.equal(remote.viewMode, manual.viewMode);
    assert.equal(f.actions.filter(action => action.type === 'LAUNCH_TERMINAL_TOOL').length, 2);
    assert.equal(f.stateRef.current.terminals.length, 2);
    assert.equal(opened.ready, true);
  } finally { f.dispose(); }
});
await test('detaching a split keeps the session controllable; closing it prunes the layout', async () => {
  const f = fixture();
  try {
    for (const [id, tool, folderPath] of [['manual', 'terminal', 'a'], ['first', 'claude', 'b'], ['second', 'codex', 'c']]) {
      f.dispatch({ type: 'ADD_TERMINAL', session: { id, tool, folderPath, isHidden: id === 'manual' } });
    }
    f.dispatch({ type: 'OPEN_SESSION_SPLIT', id: 'second', targetId: 'first', edge: 'right' });
    const generation = f.api.getTerminalObserver('second').generation;
    f.dispatch({ type: 'CLOSE_SESSION_SPLIT', id: 'second' });
    assert.equal((await f.execute('terminal_read_screen', { sessionId: 'second', generation })).generation, generation, 'detach keeps the session controllable');
    assert.equal(f.writes.length, 0, 'detach does not send kill or input');
    f.dispatch({ type: 'OPEN_SESSION_SPLIT', id: 'second', targetId: 'first', edge: 'right' });
    f.dispatch({ type: 'REMOVE_TERMINAL', id: 'second' });
    assert.equal(f.stateRef.current.terminals.some(tab => tab.id === 'second'), false);
    assert.equal(f.stateRef.current.sessionSplit.type, 'leaf', 'real close also prunes its layout reference');
  } finally { f.dispose(); }
});
await test('reordering and focus cannot redirect input or discard terminal sessions', async () => {
  const f = fixture();
  try {
    for (const id of ['first', 'second']) f.dispatch({ type: 'ADD_TERMINAL', session: { id, tool: 'claude', folderPath: id } });
    const target = { sessionId: 'second', generation: f.api.getTerminalObserver('second').generation };
    f.dispatch({ type: 'SET_ACTIVE_TERMINAL', id: 'first' });
    f.dispatch({ type: 'REORDER_TAB', tabId: 'second', beforeId: 'first' });
    assert.deepEqual(Array.from(f.stateRef.current.terminals, tab => tab.id), ['second', 'first']);
    f.dispatch({ type: 'SET_SETTINGS_OPEN', open: true });
    const text = 'Fix the login button in D:\\用户项目. Keep its label exactly "登录". Run: npm test';
    const result = await f.execute('terminal_send', { ...target, text });
    assert.equal(result.written, true);
    assert.ok(f.writes.length === 2 && f.writes.every(write => write.sessionId === 'second'));
    assert.equal(f.writes[0].data, text);
    f.dispatch({ type: 'SET_ACTIVE_TERMINAL', id: 'first' });
    assert.equal(f.stateRef.current.settingsOpen, false, 'switching tabs leaves the settings page');
    assert.equal(f.stateRef.current.activeTerminalId, 'first');
    assert.equal(f.stateRef.current.terminals.length, 2);
    assert.equal(f.api.getTerminalObserver('second').generation, target.generation);
  } finally { f.dispose(); }
});
await test('ordering survives hidden tabs, restart and launch; new terminals append once', async () => {
  const f = fixture();
  try {
    for (const id of ['first', 'hidden']) f.dispatch({ type: 'ADD_TERMINAL', session: { id, tool: null, folderPath: id, isHidden: id === 'hidden' } });
    f.dispatch({ type: 'REORDER_TAB', tabId: 'hidden', beforeId: 'first' });
    const order = () => Array.from(f.api.getTabOrder(f.stateRef.current));
    f.dispatch({ type: 'RESTART_TERMINAL', id: 'first', newId: 'restarted' });
    assert.deepEqual(order(), ['hidden', 'restarted']);
    f.dispatch({ type: 'LAUNCH_TERMINAL_TOOL', id: 'restarted', tool: 'terminal', cwd: 'chosen' });
    assert.deepEqual(order(), ['hidden', 'restarted']);
    f.dispatch({ type: 'SET_TERMINAL_HIDDEN', id: 'hidden', isHidden: false });
    assert.deepEqual(order(), ['hidden', 'restarted']);
    f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'new', tool: null, folderPath: null } });
    assert.deepEqual(order(), ['hidden', 'restarted', 'new']);
    for (const action of [{ type: 'REORDER_TAB', tabId: 'missing', beforeId: 'new' }, { type: 'REORDER_TAB', tabId: 'new', beforeId: 'missing' }]) {
      const previous = f.stateRef.current; f.dispatch(action); assert.equal(f.stateRef.current, previous);
    }
    for (const id of ['restarted', 'hidden', 'new']) f.dispatch({ type: 'REMOVE_TERMINAL', id });
    const replacement = f.stateRef.current.terminals[0];
    assert.equal(replacement.tool, null);
    assert.deepEqual(order(), [replacement.id]);
  } finally { f.dispose(); }
});
await test('stale generations, cancellation and arbitrary IPC are rejected before mutations', async () => {
  const f = fixture();
  try {
    f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'tab', tool: 'terminal', folderPath: 'a' } });
    const stale = f.api.getTerminalObserver('tab').generation;
    f.mount('tab');
    await assert.rejects(f.execute('terminal_send', { sessionId: 'tab', generation: stale, text: 'stale' }), /关闭或重启/);
    const current = f.api.getTerminalObserver('tab');
    await assert.rejects(f.execute('fs_delete', { sessionId: 'tab', generation: current.generation }), /不支持/);
    f.cancel();
    await assert.rejects(f.execute('sessions_open', { tool: 'claude', cwd: 'a' }), /取消/);
    assert.equal(f.writes.length, 0);
    assert.equal(f.stateRef.current.terminals.length, 1);
  } finally { f.dispose(); }
});
await test('read_screen exposes the actual target tool, directory and interface language for project preparation', async () => {
  const f = fixture();
  try {
    f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'project', tool: 'codex', folderPath: 'D:\\Project' } });
    const observer = f.api.getTerminalObserver('project');
    const screen = await f.execute('terminal_read_screen', { sessionId: 'project', generation: observer.generation });
    assert.equal(screen.tool, 'codex'); assert.equal(screen.cwd, 'D:\\Project'); assert.equal(screen.language, 'zh-CN');
    assert.equal(screen.generation, observer.generation);
    assert.equal(f.writes.length, 0);
  } finally { f.dispose(); }
});

await test('a prepared directory that differs from the live target rejects both prompt and key before any PTY write', async () => {
  const f = fixture();
  try {
    f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'project', tool: 'claude', folderPath: 'D:\\Project' } });
    const generation = f.api.getTerminalObserver('project').generation;
    await assert.rejects(f.execute('terminal_send', { sessionId: 'project', generation, expectedCwd: 'D:\\Other', text: 'Do the prepared task' }), /工作目录/);
    await assert.rejects(f.execute('terminal_key', { sessionId: 'project', generation, expectedCwd: 'D:\\Other', key: 'Enter' }), /工作目录/);
    assert.equal(f.writes.length, 0);
  } finally { f.dispose(); }
});

await test('normalized Windows directory identities accept extended paths, casing and separators', async () => {
  const f = fixture();
  try {
    f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'project', tool: 'claude', folderPath: 'D:\\Project' } });
    const generation = f.api.getTerminalObserver('project').generation;
    const result = await f.execute('terminal_send', { sessionId: 'project', generation, expectedCwd: '\\\\?\\d:\\PROJECT\\', text: 'Use the prepared project' });
    assert.equal(result.written, true);
    assert.equal(f.writes.length, 2); assert.equal(f.writes[0].data, 'Use the prepared project'); assert.equal(f.writes[1].data, '\r');
    f.dispatch({ type: 'SET_TERMINAL_CWD', id: 'project', path: '/Project' });
    await assert.rejects(f.execute('terminal_send', { sessionId: 'project', generation, expectedCwd: '/project', text: 'Do not mix Unix projects' }), /工作目录/);
    assert.equal(f.writes.length, 2, 'Unix directory identity must remain case-sensitive');
  } finally { f.dispose(); }
});

await test('a directory changed while reading the screen rejects the prepared task before any PTY write', async () => {
  const f = fixture();
  try {
    f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'project', tool: 'claude', folderPath: 'D:\\Project' } });
    const observer = f.api.getTerminalObserver('project');
    const read = observer.readScreen;
    observer.readScreen = async (...args) => {
      const screen = await read(...args);
      f.dispatch({ type: 'SET_TERMINAL_CWD', id: 'project', path: 'D:\\Other' });
      return screen;
    };
    await assert.rejects(f.execute('terminal_send', { sessionId: 'project', generation: observer.generation, expectedCwd: 'D:\\Project', text: 'Do the prepared task' }), /工作目录|改变/);
    assert.equal(f.writes.length, 0);
  } finally { f.dispose(); }
});

await test('a directory changed during the paste delay cannot submit Enter to a different project', async () => {
  const f = fixture();
  try {
    f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'project', tool: 'claude', folderPath: 'D:\\Project' } });
    const generation = f.api.getTerminalObserver('project').generation;
    const operation = f.execute('terminal_send', { sessionId: 'project', generation, expectedCwd: 'D:\\Project', text: 'Do the prepared task' });
    const rejected = assert.rejects(operation, /工作目录|改变/);
    while (f.writes.length === 0) await new Promise(resolve => setTimeout(resolve, 1));
    f.dispatch({ type: 'SET_TERMINAL_CWD', id: 'project', path: 'D:\\Other' });
    await rejected;
    assert.equal(f.writes.length, 1, 'the already pasted text must never be followed by Enter');
    assert.equal(f.writes[0].data, 'Do the prepared task');
  } finally { f.dispose(); }
});
console.log(`\n${passed} orchestration executor integration tests passed.`);
