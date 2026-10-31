// Real session stores and Agent executor; only native process transport is isolated.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const compiled = await build({
  stdin: { resolveDir: root, contents: `export * from './src/lib/agent-tools'; export * from './src/lib/claude-session'; export * from './src/lib/codex-session'; export * from './src/lib/dsh-session'; export { reducer } from './src/store/app-state';` },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'],
  plugins: [{ name: 'desktop-transport', setup(builder) {
    builder.onLoad({ filter: /app-state\.tsx$/ }, async ({ path }) => ({ contents: `${await readFile(path, 'utf8')}\nexport { reducer };`, loader: 'tsx' }));
    builder.onLoad({ filter: /[/\\]tauri\.ts$/ }, () => ({ loader: 'js', contents: `
      export const invoke=(name,args)=>globalThis.bridge.invoke(name,args);
      export const commands={listTools:()=>invoke('list_tools'),checkToolsInstalled:()=>invoke('check_tools_installed'),tierTerminalKill:id=>invoke('tier_terminal_kill',{id}),tierTerminalInput:(id,data)=>invoke('tier_terminal_input',{id,data})};
    ` }));
    builder.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({ path: 'event', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: 'export const listen=(name,fn)=>globalThis.bridge.listen(name,fn);' }));
  } }],
});
const listeners = new Map(), calls = [], releases = [], actions = [];
let failSend = false, failSettings = false, cancelled = false, onPending;
const emit = (name, id, event) => {
  const start = calls.findLast(call => call.name === `${name.split('-')[0]}_session_start` && call.id === id);
  listeners.get(name)?.({ payload: { id, generation: start.generation, event } });
};
const stateRef = { current: { terminals: [], activeTerminalId: null, tabOrder: [], agentPages: [], agentPageActive: null, currentLang: 'en' } };
const module = { exports: {} };
runInNewContext(compiled.outputFiles[0].text, {
  module, exports: module.exports, require: createRequire(import.meta.url), console, Date, performance, setTimeout, clearTimeout,
  crypto: { randomUUID }, window: {}, localStorage: { getItem: () => null }, requestAnimationFrame: () => {},
  bridge: {
    listen: async (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); },
    invoke: async (name, args = {}) => {
      calls.push({ name, ...args });
      if (name === 'list_tools') return [{ id: 'claude', displayName: 'Claude Code' }, { id: 'codex', displayName: 'Codex CLI' }, { id: 'dsh', displayName: 'DeepSeek Harness' }];
      if (name === 'agent_validate_directory') return args.path;
      if (name === 'claude_session_start') return { sessionId: `native-${args.id}`, initialization: {}, history: { data: JSON.stringify({ type: 'assistant', message: { id: 'seed', content: [{ type: 'text', text: 'Existing Claude answer' }] } }), cursor: 42 } };
      if (name === 'codex_session_start') return { thread: { id: `native-${args.id}`, turns: [{ id: 'previous', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'Existing Codex answer' }, { id: 'command', type: 'commandExecution', status: 'completed', command: 'npm test', aggregatedOutput: 'Tests passed' }] }] }, turnsBackwardsCursor: 'older', models: [] };
      if (name === 'dsh_session_start') return { sessionId: `native-${args.id}`, route: { provider: 'deepseek-account', model: 'deepseek-flash' }, models: [], commands: false };
      if (name === 'dsh_session_request') { if (failSend) throw Error('lost reply'); return { messageId: 'message' }; }
      if (name === 'claude_session_history') return { data: JSON.stringify({ type: 'assistant', message: { id: 'older', content: [{ type: 'text', text: 'Older Claude history' }] } }), cursor: 0 };
      if (name === 'claude_session_control') {
        if (args.request.subtype === 'get_settings' && failSettings) throw Error('Settings readback unavailable');
        if (args.request.subtype === 'interrupt') emit('claude-session-event', args.id, { type: 'result', subtype: 'success', result: 'Interrupted' });
        return { applied: {}, effective: {} };
      }
      if (name === 'claude_session_send') { if (failSend) throw Error('lost reply'); return; }
      if (name === 'codex_session_request') {
        if (args.method === 'thread/turns/list') return { data: [{ id: 'older', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'Older Codex history' }] }], nextCursor: null };
        if (args.method === 'turn/start') { if (failSend) throw Error('lost reply'); return { turn: { id: 'agent-turn' } }; }
        if (args.method === 'turn/interrupt') emit('codex-session-event', args.id, { method: 'turn/completed', params: { threadId: `native-${args.id}`, turn: { id: args.params.turnId, status: 'interrupted' } } });
        return {};
      }
      if (name.endsWith('_session_close')) return;
      throw Error(`Unexpected native call ${name}`);
    },
  },
});
const api = module.exports;
const mount = tab => releases.push(tab.tool === 'dsh' ? api.retainDshSession(tab.id, tab.folderPath) : tab.tool === 'claude' ? api.retainClaudeSession(tab.id, tab.folderPath) : api.retainCodexSession(tab.id, tab.folderPath));
const dispatch = action => {
  actions.push(action); stateRef.current = api.reducer(stateRef.current, action);
  if (action.type === 'LAUNCH_TERMINAL_TOOL') mount(stateRef.current.terminals.find(tab => tab.id === action.id));
};
const executor = api.createAgentToolExecutor({ stateRef, dispatch, pending: async () => { onPending?.(); return !cancelled; }, isCancelled: () => cancelled });
const execute = (name, args = {}) => executor({ requestId: 'request', name, arguments: args });
const target = async id => { const session = (await execute('sessions_list')).sessions.find(s => s.sessionId === id); return { sessionId: id, generation: session.generation }; };
const finish = tool => tool === 'claude' ? emit('claude-session-event', tool, { type: 'result', subtype: 'success', result: 'Done' }) : emit('codex-session-event', tool, { method: 'turn/completed', params: { threadId: 'native-codex', turn: { id: 'agent-turn', status: 'completed' } } });
const lineText = screen => screen.lines.map(line => line.text).join('\n');
const waitReady = async id => {
  for (let i = 0; i < 100; i++) {
    if ((await execute('sessions_list')).sessions.find(s => s.sessionId === id)?.ready) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('fixture session did not start');
};
try {
  for (const tool of ['claude', 'codex']) {
    const tab = { id: tool, tool, folderPath: `D:/${tool}`, claudeMode: 'conversation', codexMode: 'conversation' };
    dispatch({ type: 'ADD_TERMINAL', session: tab }); mount(tab); await waitReady(tool);
  }
  const starts = () => calls.filter(call => call.name.endsWith('_session_start')).length;
  assert.equal(starts(), 2);
  for (const tool of ['claude', 'codex']) {
    const args = await target(tool);
    const listed = (await execute('sessions_list')).sessions.find(s => s.sessionId === tool);
    assert.equal(listed.mode, 'desktop'); assert.equal(listed.ready, true);
    dispatch({ type: 'OPEN_AGENT_PAGE', page: 'agent' });
    const screen = await execute('terminal_read_screen', args);
    assert.equal(screen.source, 'desktop-session'); assert.equal(screen.nativeSessionId, `native-${tool}`);
    assert.ok(lineText(screen).includes(`Existing ${tool === 'claude' ? 'Claude' : 'Codex'} answer`));
    if (tool === 'codex') assert.ok(lineText(screen).includes('npm test') && lineText(screen).includes('Tests passed'));
    const history = await execute('terminal_read_scrollback', { ...args, startRow: 0, limit: 200 });
    assert.ok(lineText(history).includes(`Older ${tool === 'claude' ? 'Claude' : 'Codex'} history`));
    assert.equal(history.hasOlder, false);
    const result = await execute('terminal_send', { ...args, text: 'Update the existing task' });
    assert.equal(result.written, true); assert.equal(result.screen.busy, true);
    const sent = calls.findLast(call => call.name === (tool === 'claude' ? 'claude_session_send' : 'codex_session_request') && (tool === 'claude' || call.method === 'turn/start'));
    assert.equal(sent.id, tool);
    assert.equal(sent.generation, calls.find(call => call.name === `${tool}_session_start`).generation);
    if (tool === 'codex') assert.equal(sent.params.threadId, 'native-codex');
    await assert.rejects(execute('terminal_send', { ...args, text: 'Duplicate' }), /正在执行/);
    const interrupted = await execute('terminal_key', { ...args, key: 'CtrlC' });
    assert.equal(interrupted.written, true); assert.equal(interrupted.screen.busy, false);
    assert.ok(lineText(interrupted.screen).includes('Existing'));
    dispatch({ type: 'SET_GAMBIT_DRAFT', id: tool, draft: 'local unfinished input' });
    await assert.rejects(execute('terminal_send', { ...args, text: 'Conflicting task' }), /本地未提交/);
    dispatch({ type: 'SET_GAMBIT_DRAFT', id: tool, draft: '' });
    if (tool === 'claude') emit('claude-session-event', tool, { type: 'control_request', request_id: 'approval', request: { subtype: 'can_use_tool' } });
    else emit('codex-session-event', tool, { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'native-codex', turnId: 'agent-turn' } });
    assert.equal((await execute('terminal_read_screen', args)).pendingRequests.length, 1);
    for (const key of ['Enter', 'Escape', 'Tab', 'Up']) await assert.rejects(execute('terminal_key', { ...args, key }), /仅支持/);
    await assert.rejects(execute('terminal_send', { ...args, text: 'Bypass request' }), /等待用户/);
    finish(tool);
    let checks = 0;
    onPending = () => { if (++checks === 2) dispatch({ type: 'SET_GAMBIT_DRAFT', id: tool, draft: 'typed during dispatch' }); };
    await assert.rejects(execute('terminal_send', { ...args, text: 'Conflicting task' }), /本地未提交/);
    onPending = undefined; dispatch({ type: 'SET_GAMBIT_DRAFT', id: tool, draft: '' });
    failSend = true;
    await assert.rejects(execute('terminal_send', { ...args, text: 'Uncertain delivery' }), error => error.uncertain === true);
    failSend = false; finish(tool);
  }
  const beforeAutomatic = api.getClaudeSession('claude').messages.length;
  const notification = '<task-notification>\nAutomatic delegated results\n</task-notification>';
  assert.equal(await api.sendClaudeMessage('claude', notification, 'batch-1'), true);
  assert.equal(calls.findLast(call => call.name === 'claude_session_send').orchestrationDelivery, 'batch-1');
  assert.equal(api.getClaudeSession('claude').messages.length, beforeAutomatic, 'automatic task data is not shown as a user message');
  emit('claude-session-event', 'claude', {type:'user',uuid:'automatic-input',message:{content:notification}});
  assert.equal(api.getClaudeSession('claude').messages.length, beforeAutomatic, 'native task notifications remain hidden from user history');
  finish('claude');
  failSend = true;
  assert.equal(await api.sendClaudeMessage('claude', notification, 'superseded-batch'), false);
  assert.equal(api.getClaudeSession('claude').error, undefined, 'a rejected automatic continuation does not display a new user-facing error');
  failSend = false;
  assert.equal(starts(), 2, 'reading, history, sending, interrupting and conflicts never start replacement processes');
  assert.equal(actions.some(action => action.type === 'LAUNCH_TERMINAL_TOOL'), false, 'existing sessions never create another tab');
  assert.equal(calls.some(call => call.name.startsWith('tier_terminal')), false, 'desktop control never writes to a PTY');
  assert.equal(calls.some(call => call.name.endsWith('_session_respond')), false, 'Agent never approves native requests');
  emit('claude-session-event', 'claude', { type: 'assistant', message: { id: 'large', content: [{ type: 'text', text: 'x'.repeat(12000) }] } });
  const bounded = await execute('terminal_read_screen', await target('claude'));
  assert.equal(bounded.truncated, true); assert.ok(bounded.lines.every(line => line.text.length < 1100));
  assert.ok((await execute('terminal_read_scrollback', { ...await target('claude'), limit: 2 })).lines.length <= 2);
  await execute('terminal_send', { ...await target('claude'), text: 'Task that must remain interruptible' });
  failSettings = true;
  await assert.rejects(api.controlClaude('claude', { subtype: 'set_model', model: 'changed' }));
  failSettings = false;
  assert.equal((await execute('terminal_read_screen', await target('claude'))).ready, false);
  assert.equal((await execute('terminal_key', { ...await target('claude'), key: 'CtrlC' })).screen.busy, false, 'a settings readback failure must not prevent interruption of an active turn');
  emit('codex-session-event', 'codex', { method: 'coffee/exit', params: { detail: 'Fixture process exited' } });
  const disconnected = await target('codex');
  assert.equal((await execute('terminal_read_screen', disconnected)).ready, false);
  assert.ok(lineText(await execute('terminal_read_screen', disconnected)).includes('Existing Codex answer'));
  const beforeDisconnected = calls.length;
  await assert.rejects(execute('terminal_send', { ...disconnected, text: 'Do not reconnect' }), /断开/);
  await assert.rejects(execute('terminal_key', { ...disconnected, key: 'CtrlC' }), /断开/);
  assert.equal(calls.length, beforeDisconnected, 'disconnected reads and rejected input cannot reconnect or send');
  const old = await target('claude');
  releases.shift()(); await new Promise(resolve => setTimeout(resolve, 350));
  mount(stateRef.current.terminals.find(tab => tab.id === 'claude')); await waitReady('claude');
  await assert.rejects(execute('terminal_send', { ...old, text: 'Stale target' }), /关闭或重启/);
  const args = await target('claude');
  let checks = 0;
  onPending = () => { if (++checks === 2) cancelled = true; };
  await assert.rejects(execute('terminal_send', { ...args, text: 'Cancelled' }), /取消/);
  cancelled = false; onPending = undefined;
  checks = 0;
  onPending = () => { if (++checks === 2) dispatch({ type: 'SET_TERMINAL_CWD', id: 'claude', path: 'D:/other' }); };
  await assert.rejects(execute('terminal_send', { ...args, expectedCwd: 'D:/claude', text: 'Wrong workspace' }), /工作目录/);
  onPending = undefined;
  for (const tool of ['claude', 'codex']) {
    const args = await target(tool); await execute('sessions_close', args);
    assert.ok(calls.some(call => call.name === `${tool}_session_close` && call.id === tool));
    await assert.rejects(execute('terminal_read_screen', args), /关闭或重启/);
  }
  for (const tool of ['claude', 'codex']) {
    const opened = await execute('sessions_open', { tool, cwd: 'D:/selected' });
    assert.equal(opened.ready, true); assert.equal(opened.mode, 'desktop');
    assert.equal(stateRef.current.terminals.find(tab => tab.id === opened.sessionId)[`${tool}Mode`], 'conversation');
    await execute('sessions_close', { sessionId: opened.sessionId, generation: opened.generation });
  }
  // DeepSeek Harness has no interrupt call: CtrlC restarts its runtime into the same Session under a new generation.
  const dshTab = { id: 'dsh', tool: 'dsh', folderPath: 'D:/dsh' };
  dispatch({ type: 'ADD_TERMINAL', session: dshTab }); mount(dshTab); await waitReady('dsh');
  const dshArgs = await target('dsh');
  assert.equal((await execute('sessions_list')).sessions.find(s => s.sessionId === 'dsh').mode, 'desktop');
  const dshEvent = event => emit('dsh-session-event', 'dsh', { method: 'session.event', params: { sessionId: 'native-dsh', event } });
  dshEvent({ type: 'tool/call', seq: 1, time: 1, data: { turn: 1, callId: 'call', name: 'pwsh', arguments: '{"command":"npm test"}' } });
  dshEvent({ type: 'tool/result', seq: 2, time: 2, data: { turn: 1, message: { toolCallId: 'call', content: [{ type: 'text', text: 'Tests passed' }] } } });
  const dshScreen = await execute('terminal_read_screen', dshArgs);
  assert.equal(dshScreen.source, 'desktop-session'); assert.equal(dshScreen.nativeSessionId, 'native-dsh');
  assert.ok(lineText(dshScreen).includes('npm test') && lineText(dshScreen).includes('Tests passed'));
  const dshSent = await execute('terminal_send', { ...dshArgs, text: 'Update the existing task' });
  assert.equal(dshSent.written, true); assert.equal(dshSent.screen.busy, true);
  const dshPrompt = calls.findLast(call => call.name === 'dsh_session_request');
  assert.equal(dshPrompt.method, 'session/prompt'); assert.equal(dshPrompt.params.contentBlocks[0].text, 'Update the existing task');
  await assert.rejects(execute('terminal_send', { ...dshArgs, text: 'Duplicate' }), /正在执行/);
  emit('dsh-session-event', 'dsh', { id: 'coffee-1', method: 'approval/request', params: { toolName: 'write', requestId: 'coffee-1' } });
  const dshWaiting = await execute('terminal_read_screen', dshArgs);
  assert.equal(dshWaiting.status, 'wait_input'); assert.equal(JSON.stringify(dshWaiting.pendingRequests), JSON.stringify([{ id: 'coffee-1', kind: 'approval/request' }]));
  const dshStarts = calls.filter(call => call.name === 'dsh_session_start').length;
  assert.equal((await execute('terminal_key', { ...dshArgs, key: 'CtrlC' })).written, true);
  assert.equal(calls.filter(call => call.name === 'dsh_session_start').length, dshStarts + 1);
  assert.equal(calls.findLast(call => call.name === 'dsh_session_start').resumeToken, 'native-dsh');
  await assert.rejects(execute('terminal_read_screen', dshArgs), /关闭或重启/);
  const dshResumed = await target('dsh');
  assert.equal((await execute('terminal_read_screen', dshResumed)).status, 'idle');
  await execute('sessions_close', dshResumed);
  assert.ok(calls.some(call => call.name === 'dsh_session_close' && call.generation === calls.findLast(start => start.name === 'dsh_session_start').generation));
  const dshOpened = await execute('sessions_open', { tool: 'dsh', cwd: 'D:/selected' });
  assert.equal(dshOpened.ready, true); assert.equal(dshOpened.mode, 'desktop');
  await execute('sessions_close', { sessionId: dshOpened.sessionId, generation: dshOpened.generation });
  console.log('OK: same-session desktop observation, tool output, history, dispatch, interruption, close, permissions, local drafts, stale generations, cancellation, workspace changes, uncertain delivery and desktop open defaults');
} finally { releases.forEach(release => release()); await new Promise(resolve => setTimeout(resolve, 350)); }
