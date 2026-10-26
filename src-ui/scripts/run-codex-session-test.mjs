// Exercise the real reducer and session store; mock only the native transport.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const calls = [], deferred = [];
let listener, delayStart = false, delayTurn = false;
const historyUser = { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Earlier question' }] };
const historyAnswer = { id: 'a', type: 'agentMessage', text: 'Earlier answer' };
const thread = id => ({ thread: { id: `thread-${id}`, turns: id === 'history' ? [{ id: 'restored', status: 'completed', items: [historyUser, historyAnswer] }] : [] }, turnsBackwardsCursor: id === 'history' ? 'older' : null, model: 'test-model', reasoningEffort: 'medium', sandbox: { type: 'readOnly' }, approvalPolicy: 'on-request', models: [{ id: 'test', model: 'test-model', displayName: 'Test', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] });
globalThis.__codexBridge = {
  listen: async (_name, fn) => { listener = fn; return () => {}; },
  invoke: async (name, args) => {
    calls.push({ name, ...args });
    if (name === 'get_tool_control') return { ready: true, agents: [{ tool: 'codex', enabled: args.kind === 'computer', conflict: false }] };
    if (name === 'codex_session_start') {
      if (delayStart) return new Promise(resolve => deferred.push(() => resolve(thread(args.id))));
      return thread(args.id);
    }
    if (args.method === 'skills/list') return {data:[{skills:[{name:'test-skill',path:'D:/skills/test/SKILL.md',enabled:true},{name:'disabled',path:'D:/disabled',enabled:false}]}]};
    if (args.method === 'mcpServerStatus/list') return {data:[{name:args.params.cursor?'second':'first'}],nextCursor:args.params.cursor?null:'next'};
    if (args.method === 'review/start') return {turn:{id:'review-turn'}};
    if (args.method === 'thread/compact/start') return {};
    if (args.method === 'turn/start') {
      if (delayTurn) return new Promise(resolve => deferred.push(() => resolve({ turn: { id: 'new-turn', status: 'inProgress' } })));
      return { turn: { id: 'new-turn', status: 'inProgress' } };
    }
    if (args.method === 'thread/turns/list') return { data: [{ id: 'restored', status: 'completed', items: [historyUser, { id: 'tool', type: 'commandExecution', status: 'completed', aggregatedOutput: 'Earlier execution' }, historyAnswer] }, { id: 'old', status: 'completed', items: [historyUser] }], nextCursor: null };
    return {};
  },
};
const result = await build({
  stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), contents: `export * from './src/lib/codex-protocol';export * from './src/lib/codex-session';export {useSessionControls} from './src/lib/session-controls'`, loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'transport', setup(b) {
    b.onResolve({ filter: /^react$|^\.\.\/tauri$|^@tauri-apps\/api\/event$/ }, args => ({ path: args.path, namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents: args.path === 'react' ? 'export function useSyncExternalStore(_subscribe,snapshot){return snapshot()}' : args.path.includes('event') ? 'export const listen=globalThis.__codexBridge.listen' : 'export const invoke=globalThis.__codexBridge.invoke' }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const { emptyCodexState, reduceCodexEvent, restoreCodexTurns } = api;
let state = { ...emptyCodexState(), nativeId: 'thread-a', ready: true };
const event = (method, params, id) => ({ method, params: { threadId: 'thread-a', ...params }, ...(id === undefined ? {} : { id }) });
const reduce = (method, params, id) => { state = reduceCodexEvent(state, event(method, params, id)); };
reduce('turn/started', { turn: { id: 't' } });
reduce('error', { turnId: 't', willRetry: true, error: { message: 'Connection lost; reconnecting' } });
assert.equal(state.error, undefined, 'automatic retry is not a final failure');
assert.equal(state.busy, true);
reduce('item/started', { turnId: 't', item: { id: 'answer', type: 'agentMessage', text: '' } });
reduce('item/agentMessage/delta', { turnId: 't', itemId: 'answer', delta: 'Hello ' });
reduce('item/agentMessage/delta', { turnId: 't', itemId: 'answer', delta: 'Coffee' });
assert.equal(state.messages[0].content, 'Hello Coffee');
assert.equal(reduceCodexEvent(state, { method: 'turn/started', params: { threadId: 'other', turn: { id: 'wrong' } } }), state);
reduce('item/fileChange/requestApproval', { turnId: 't' }, 7);
reduce('item/fileChange/requestApproval', { turnId: 't' }, '7');
reduce('serverRequest/resolved', { requestId: 7 });
assert.deepEqual(state.requests.map(r => r.id), ['7']);
reduce('item/started', { turnId: 't', item: { id: 'patch', type: 'fileChange', changes: [], status: 'inProgress' } });
reduce('item/fileChange/patchUpdated', { turnId: 't', itemId: 'patch', changes: [{ path: 'a.ts', diff: '+fixed' }] });
assert.equal(state.messages.at(-1).content, 'a.ts\n+fixed');
reduce('turn/completed', { turn: { id: 't', status: 'interrupted', durationMs: 1234 } });
assert.equal(state.busy, false);
assert.equal(state.error, undefined);
assert.equal(state.requests.length, 0);
assert.equal(state.messages.at(-1).item.status, 'interrupted');
assert.equal(state.messages[0].content, 'Hello Coffee', 'stop preserves partial output');
reduce('turn/started', { turn: { id: 'failed-turn' } });
reduce('error', { turnId: 'failed-turn', willRetry: false, error: { message: 'Final transport failure' } });
assert.equal(state.error, 'Final transport failure', 'a non-retrying error stays visible');
reduce('turn/completed', { turn: { id: 'failed-turn', status: 'failed', error: { message: 'Real failure' } } });
assert.equal(state.error, 'Real failure');
const restored = restoreCodexTurns([{ id: 'restore', status: 'inProgress', items: [{ id: 'exec', type: 'commandExecution', status: 'completed', aggregatedOutput: 'Done' }, { id: 'reply', type: 'agentMessage', text: 'Streaming' }] }]);
assert.equal(restored[0].partial, false);
assert.equal(restored[1].partial, true);
console.log('ok stream, thread isolation, native request IDs, file patches, stop and real errors');

const flush = () => new Promise(resolve => setTimeout(resolve, 5));
const live = id => api.useCodexSession(id);
const emit = (id, method, params = {}, nativeId) => {
  const generation = calls.find(c => c.name === 'codex_session_start' && c.id === id).generation;
  listener({ payload: { id, generation, event: { method, params: { threadId: `thread-${id}`, ...params }, ...(nativeId === undefined ? {} : { id: nativeId }) } } });
};
const releases = [api.retainCodexSession('a', 'D:/Test'), api.retainCodexSession('b', 'D:/Test', 'resume-id')];
await flush();
assert.deepEqual(api.useSessionControls('a'), ['computer'], 'native session startup captures configured capabilities');
await api.runCodexCommand('a','skills');
const mcp=await api.runCodexCommand('a','mcp');assert.deepEqual(mcp.data.map(s=>s.name),['first','second']);
await api.runCodexCommand('b','review');assert.equal(live('b').busy,true);assert.equal(live('b').turnId,'review-turn');
const review=calls.find(c=>c.method==='review/start');assert.deepEqual(review.params,{threadId:'thread-b',delivery:'inline',target:{type:'uncommittedChanges'}});
await assert.rejects(api.runCodexCommand('b','compact'),/not ready/);
emit('b','turn/completed',{turn:{id:'review-turn',status:'completed'}});
await api.runCodexCommand('b','compact');assert.equal(live('b').busy,true);emit('b','turn/started',{turn:{id:'compact-turn'}});emit('b','turn/completed',{turn:{id:'compact-turn',status:'completed'}});assert.equal(live('b').busy,false);
console.log('ok native review/compaction lifecycle, busy guard and paginated MCP catalog');

releases.push(api.retainCodexSession('history', null, 'resume-history')); await flush();
await api.loadCodexHistory('history');
assert.deepEqual(live('history').messages.map(m => m.id), ['old:u', 'restored:u', 'restored:tool', 'restored:a'], 'hydrating summary history preserves native item order');
assert.equal(live('history').historyCursor, null);
assert.equal(live('a').ready, true);
assert.equal(calls.find(c => c.name === 'codex_session_start' && c.id === 'b').resumeToken, 'resume-id');
listener({ payload: { id: 'a', generation: 'obsolete', event: event('turn/started', { turn: { id: 'wrong' } }) } });
assert.equal(live('a').busy, false);
delayTurn = true;
const send = api.sendCodexMessage('a', 'Hello "D:/test image.png"');
assert.equal(live('a').busy, true);
assert.equal(await api.sendCodexMessage('a', 'duplicate'), false);
await api.interruptCodex('a');
assert.equal(live('a').interrupting, true);
assert.equal(calls.filter(c => c.method === 'turn/interrupt').length, 0, 'stop waits for the new turn identity');
emit('a', 'turn/started', { turn: { id: 'new-turn' } });
assert.equal(calls.filter(c => c.method === 'turn/interrupt').length, 1, 'turn notification unblocks a queued stop before the start acknowledgement');
deferred.shift()(); await send;
const stopCalls = calls.filter(c => c.method === 'turn/interrupt');
assert.equal(stopCalls.length, 1);
assert.equal(stopCalls[0].params.turnId, 'new-turn');
assert.equal(stopCalls[0].params.threadId, 'thread-a');
assert.equal(live('b').busy, false);
const startCall = calls.find(c => c.method === 'turn/start');
assert.deepEqual(startCall.params.input[1], { type: 'localImage', path: 'D:/test image.png' });
emit('a', 'item/fileChange/requestApproval', { turnId: 'new-turn' }, 12);
assert.equal(live('a').requests.length, 1);
assert.equal(calls.filter(c => c.name === 'codex_session_respond').length, 0, 'approval is never automatic');
await api.respondCodex('a', 12, { decision: 'decline' });
assert.equal(calls.at(-1).requestId, 12);
assert.equal(calls.at(-1).response.decision, 'decline');
emit('a', 'turn/completed', { turn: { id: 'new-turn', status: 'interrupted' } });
assert.equal(live('a').busy, false);
assert.equal(startCall.params.sandboxPolicy, undefined, 'untouched permissions inherit native settings');
delayTurn = false;
await api.sendCodexMessage('a','$test-skill check this');assert.deepEqual(calls.filter(c=>c.method==='turn/start').at(-1).params.input.at(-1),{type:'skill',name:'test-skill',path:'D:/skills/test/SKILL.md'});emit('a','turn/completed',{turn:{id:'new-turn',status:'completed'}});
api.configureCodex('a', { sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'on-request' });
await api.sendCodexMessage('a', 'Test workspace permissions');
assert.equal(calls.filter(c => c.method === 'turn/start').at(-1).params.sandboxPolicy.type, 'workspaceWrite');
assert.equal(calls.filter(c => c.method === 'turn/start').at(-1).params.approvalPolicy, 'on-request');
api.configureCodex('a', { sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never' });
assert.equal(live('a').sandbox.type, 'workspaceWrite', 'a running turn cannot change permissions');
emit('a', 'turn/completed', { turn: { id: 'new-turn', status: 'completed' } });
api.configureCodex('a', { sandbox: { type: 'readOnly' }, approvalPolicy: 'on-request' });
await api.sendCodexMessage('a', 'Test read-only permissions');
assert.equal(calls.filter(c => c.method === 'turn/start').at(-1).params.sandboxPolicy.type, 'readOnly');
emit('a', 'coffee/exit', { code: 1, detail: 'Missing package' });
assert.deepEqual(api.useSessionControls('a'), [], 'capability badges clear when the native process exits');
assert.equal(live('a').ready, false);
assert.equal(live('a').error, 'Missing package');
delayStart = true;
releases.push(api.retainCodexSession('exit-race', null)); await flush();
emit('exit-race', 'coffee/exit', { code: 1 });
deferred.shift()(); await flush();
assert.equal(live('exit-race').ready, false, 'late initialization cannot revive a dead process');
releases.forEach(fn => fn()); await new Promise(resolve => setTimeout(resolve, 350));
assert.deepEqual(api.useSessionControls('b'), [], 'closing a tab clears its capability badges');
assert.deepEqual(new Set(calls.filter(c => c.name === 'codex_session_close').map(c => c.id)), new Set(['a', 'b', 'history', 'exit-race']));
delete globalThis.__codexBridge;
console.log('ok independent sessions, stale events, immediate stop, attachments, approval and process lifecycle');
