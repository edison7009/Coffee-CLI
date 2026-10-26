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
  const stateRef = { current: { terminals: [], activeTerminalId: null, agentPages: [], agentPageActive: null, tabOrder: [], diffTabActive: false, diffMode: 'overlay', currentLang: 'zh-CN' } };
  const module = { exports: {} };
  let cancelled = false;
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, require, console, Date, performance, setTimeout, clearTimeout, crypto: { randomUUID },
    localStorage: { getItem: () => 'terminal', setItem() {} }, requestAnimationFrame: () => {},
    window: { __TAURI_INTERNALS__: { invoke: async (command, args) => {
      if (command === 'list_tools') return [{ id: 'claude', displayName: 'Claude Code' }, { id: 'codex', displayName: 'Codex' }];
      if (command === 'check_tools_installed') return { claude: true, codex: true };
      if (command === 'get_native_history') return [{ id: 'win', tool: 'claude', cwd: 'D:\\Project', session_token: 'resume-id' }, { id: 'unix', tool: 'claude', cwd: '/Project', session_token: 'unix-id' }];
      if (command === 'agent_validate_directory') { if (args.path === 'missing') throw new Error('Directory does not exist'); return args.path.startsWith('canonical:') ? args.path : `canonical:${args.path}`; }
      if (command === 'agent_create_directory') {
        if (args.path === 'blocked') throw new Error('Cannot create directory');
        directories.push(args.path);
        return { path: `canonical:${args.path}`, created: true };
      }
      if (command === 'agent_workspace_tool') { files.push(args); return { ok: true }; }
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
await test('directory creation does not change the workspace; subsequent open creates a visible Claude tab', async () => {
  const f = fixture();
  try {
    f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'manual', tool: 'claude', folderPath: 'old-project' } });
    const before = f.actions.length;
    const directory = await f.execute('directory_create', { path: 'new-project' });
    assert.equal(directory.path, 'canonical:new-project');
    assert.equal(f.actions.length, before);
    assert.equal(f.stateRef.current.activeTerminalId, 'manual');
    const opened = await f.execute('sessions_open', { tool: 'claude', cwd: directory.path });
    assert.equal(f.stateRef.current.activeTerminalId, opened.sessionId);
    assert.equal(f.stateRef.current.terminals.find(tab => tab.id === opened.sessionId).tool, 'claude');
    assert.equal(f.stateRef.current.terminals.find(tab => tab.id === opened.sessionId).folderPath, directory.path);
    assert.equal(f.stateRef.current.terminals.find(tab => tab.id === 'manual').folderPath, 'old-project');
    const afterOpen = f.actions.length;
    await assert.rejects(f.execute('directory_create', { path: 'blocked' }), /Cannot create/);
    assert.equal(f.actions.length, afterOpen);
    f.cancel();
    await assert.rejects(f.execute('directory_create', { path: 'cancelled-project' }), /取消/);
    assert.equal(f.directories.length, 1);
  } finally { f.dispose(); }
});
await test('engineering tools require explicit workspace, preserve terminal state and honor cancellation', async () => {
  const f = fixture();
  try {
    f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'manual', tool: 'claude', folderPath: 'old-project' } });
    const before = f.actions.length;
    for (const name of ['workspace_list', 'file_read', 'file_create', 'file_edit']) {
      await assert.rejects(f.execute(name, { path: 'code.ts' }), /工作目录/);
      await f.execute(name, { cwd: 'chosen-project', path: 'code.ts', content: '' });
    }
    assert.equal(f.files.length, 4);
    assert.ok(f.files.every(item => item.arguments.cwd === 'chosen-project'));
    assert.equal(f.actions.length, before);
    assert.equal(f.stateRef.current.activeTerminalId, 'manual');
    f.cancel();
    await assert.rejects(f.execute('file_create', { cwd: 'chosen-project', path: 'cancelled.ts', content: '' }), /取消/);
    assert.equal(f.files.length, 4);
  } finally { f.dispose(); }
});
await test('dynamic splits list real sessions and detach without terminating their lifecycle', async () => {
  const f = fixture();
  try {
    for (const [id, tool, folderPath] of [['manual', 'terminal', 'a'], ['first', 'claude', 'b'], ['second', 'codex', 'c']]) {
      f.dispatch({ type: 'ADD_TERMINAL', session: { id, tool, folderPath, isHidden: id === 'manual' } });
    }
    f.dispatch({ type: 'OPEN_SESSION_SPLIT', id: 'second', targetId: 'first', edge: 'right' });
    const result = await f.execute('sessions_list');
    assert.deepEqual(Array.from(result.sessions, item => item.sessionId), ['manual', 'first', 'second']);
    assert.equal(new Set(result.sessions.map(item => item.generation)).size, 3);
    assert.equal(result.sessions[2].cwd, 'c');
    f.dispatch({ type: 'CLOSE_SESSION_SPLIT', id: 'second' });
    assert.equal((await f.execute('sessions_list')).sessions.length, 3, 'detach keeps the session controllable');
    assert.equal(f.writes.length, 0, 'detach does not send kill or input');
    f.dispatch({ type: 'OPEN_SESSION_SPLIT', id: 'second', targetId: 'first', edge: 'right' });
    const target = result.sessions[2];
    await f.execute('sessions_close', { sessionId: target.sessionId, generation: target.generation });
    assert.equal(f.stateRef.current.terminals.some(tab => tab.id === 'second'), false);
    assert.equal(f.stateRef.current.sessionSplit.type, 'leaf', 'real close also prunes its layout reference');
  } finally { f.dispose(); }
});
await test('reordering, focus and Agent pages cannot redirect input or discard terminal sessions', async () => {
  const f = fixture();
  try {
    for (const id of ['first', 'second']) f.dispatch({ type: 'ADD_TERMINAL', session: { id, tool: 'claude', folderPath: id } });
    const target = (await f.execute('sessions_list')).sessions.find(item => item.sessionId === 'second');
    f.dispatch({ type: 'SET_ACTIVE_TERMINAL', id: 'first' });
    f.dispatch({ type: 'REORDER_TAB', tabId: 'second', beforeId: 'first' });
    assert.deepEqual(Array.from(f.stateRef.current.terminals, tab => tab.id), ['second', 'first']);
    for (const page of ['agent', 'config']) f.dispatch({ type: 'OPEN_AGENT_PAGE', page });
    f.dispatch({ type: 'REORDER_TAB', tabId: 'agent:config', beforeId: 'first' });
    const text = 'Fix the login button in D:\\用户项目. Keep its label exactly "登录". Run: npm test';
    const result = await f.execute('terminal_send', { sessionId: target.sessionId, generation: target.generation, text });
    assert.equal(result.written, true);
    assert.ok(f.writes.length === 2 && f.writes.every(write => write.sessionId === 'second'));
    assert.equal(f.writes[0].data, text);
    f.dispatch({ type: 'SET_ACTIVE_TERMINAL', id: 'first' });
    assert.equal(f.stateRef.current.agentPageActive, null);
    assert.deepEqual([...f.stateRef.current.agentPages], ['config', 'agent']);
    assert.equal(f.stateRef.current.activeTerminalId, 'first');
    assert.equal(f.stateRef.current.terminals.length, 2);
    assert.equal(f.api.getTerminalObserver('second').generation, target.generation);
    f.dispatch({ type: 'OPEN_AGENT_PAGE', page: 'config' });
    f.dispatch({ type: 'CLOSE_AGENT_PAGE', page: 'config' });
    assert.equal(f.stateRef.current.agentPageActive, 'agent');
    f.dispatch({ type: 'CLOSE_AGENT_PAGE', page: 'agent' });
    assert.equal(f.stateRef.current.agentPageActive, null);
    assert.equal(f.stateRef.current.activeTerminalId, 'first');
    assert.equal(f.stateRef.current.terminals.length, 2);
    assert.equal(f.api.getTerminalObserver('second').generation, target.generation);
  } finally { f.dispose(); }
});
await test('Agent and settings tabs move both ways between terminals without changing focus, drafts or identity', async () => {
  const f = fixture();
  try {
    for (const id of ['first', 'second']) f.dispatch({ type: 'ADD_TERMINAL', session: { id, tool: null, folderPath: id, gambitDraft: id } });
    for (const page of ['config', 'agent']) f.dispatch({ type: 'OPEN_AGENT_PAGE', page });
    const sessions = [...f.stateRef.current.terminals];
    const order = () => Array.from(f.api.getTabOrder(f.stateRef.current));
    assert.deepEqual(order(), ['first', 'second', 'agent:config', 'agent:agent']);
    f.dispatch({ type: 'REORDER_TAB', tabId: 'agent:agent', beforeId: 'first' });
    f.dispatch({ type: 'REORDER_TAB', tabId: 'agent:config', beforeId: 'second' });
    assert.deepEqual(order(), ['agent:agent', 'first', 'agent:config', 'second']);
    assert.equal(f.stateRef.current.agentPageActive, 'agent');
    assert.equal(f.stateRef.current.activeTerminalId, 'second');
    for (const session of sessions) assert.equal(f.stateRef.current.terminals.find(item => item.id === session.id), session);
    f.dispatch({ type: 'REORDER_TAB', tabId: 'agent:agent', beforeId: null });
    f.dispatch({ type: 'REORDER_TAB', tabId: 'second', beforeId: 'first' });
    assert.deepEqual(order(), ['second', 'first', 'agent:config', 'agent:agent']);
    assert.deepEqual(Array.from(f.stateRef.current.terminals, tab => tab.id), ['second', 'first']);
    for (const action of [
      { type: 'REORDER_TAB', tabId: 'missing', beforeId: 'first' },
      { type: 'REORDER_TAB', tabId: 'first', beforeId: 'missing' },
      { type: 'REORDER_TAB', tabId: 'first', beforeId: 'agent:config' },
    ]) {
      const previous = f.stateRef.current;
      f.dispatch(action); assert.equal(f.stateRef.current, previous);
    }
  } finally { f.dispose(); }
});
await test('mixed ordering survives hidden tabs, restart and launch; reopened pages and new terminals append once', async () => {
  const f = fixture();
  try {
    for (const id of ['first', 'hidden']) f.dispatch({ type: 'ADD_TERMINAL', session: { id, tool: null, folderPath: id, isHidden: id === 'hidden' } });
    for (const page of ['config', 'agent']) f.dispatch({ type: 'OPEN_AGENT_PAGE', page });
    f.dispatch({ type: 'REORDER_TAB', tabId: 'agent:config', beforeId: 'first' });
    const order = () => Array.from(f.api.getTabOrder(f.stateRef.current));
    f.dispatch({ type: 'RESTART_TERMINAL', id: 'first', newId: 'restarted' });
    assert.deepEqual(order(), ['agent:config', 'restarted', 'hidden', 'agent:agent']);
    f.dispatch({ type: 'LAUNCH_TERMINAL_TOOL', id: 'restarted', tool: 'terminal', cwd: 'chosen' });
    assert.deepEqual(order(), ['agent:config', 'restarted', 'hidden', 'agent:agent']);
    f.dispatch({ type: 'SET_TERMINAL_HIDDEN', id: 'hidden', isHidden: false });
    assert.deepEqual(order(), ['agent:config', 'restarted', 'hidden', 'agent:agent']);
    f.dispatch({ type: 'CLOSE_AGENT_PAGE', page: 'config' });
    f.dispatch({ type: 'OPEN_AGENT_PAGE', page: 'config' });
    f.dispatch({ type: 'OPEN_AGENT_PAGE', page: 'config' });
    f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'new', tool: null, folderPath: null } });
    assert.deepEqual(order(), ['restarted', 'hidden', 'agent:agent', 'agent:config', 'new']);
    for (const id of ['restarted', 'hidden', 'new']) f.dispatch({ type: 'REMOVE_TERMINAL', id });
    const replacement = f.stateRef.current.terminals[0];
    assert.equal(replacement.tool, null);
    assert.deepEqual(order(), ['agent:agent', 'agent:config', replacement.id]);
  } finally { f.dispose(); }
});
await test('stale generations, cancellation and arbitrary IPC are rejected before mutations', async () => {
  const f = fixture();
  try {
    f.dispatch({ type: 'ADD_TERMINAL', session: { id: 'tab', tool: 'terminal', folderPath: 'a' } });
    const target = (await f.execute('sessions_list')).sessions[0];
    f.mount('tab');
    await assert.rejects(f.execute('sessions_close', { sessionId: 'tab', generation: target.generation }), /关闭或重启/);
    const current = f.api.getTerminalObserver('tab');
    await assert.rejects(f.execute('fs_delete', { sessionId: 'tab', generation: current.generation }), /不支持/);
    f.cancel();
    await assert.rejects(f.execute('sessions_open', { tool: 'claude', cwd: 'a' }), /取消/);
    assert.equal(f.writes.length, 0);
    assert.equal(f.stateRef.current.terminals.length, 1);
  } finally { f.dispose(); }
});
await test('history matches canonical Windows cwd while preserving Unix case distinctions', async () => {
  const f = fixture();
  try {
    assert.equal((await f.execute('history_list', { cwd: '\\\\?\\d:\\project\\' })).sessions[0].id, 'win');
    assert.equal((await f.execute('history_list', { cwd: '/project' })).sessions.length, 0);
    assert.equal((await f.execute('history_list', { cwd: '/Project/' })).sessions[0].id, 'unix');
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
console.log(`\n${passed} Agent workspace integration tests passed.`);
