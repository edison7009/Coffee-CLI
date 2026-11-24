import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const built = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/acp-session.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'], plugins: [{ name: 'boundary', setup(b) {
  b.onResolve({ filter: /(^|\/)(tauri|session-mirror|notify-prompts|session-replies|bridge)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
  b.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({ path: 'event', namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: `
    export const REMOTE=false; export const invoke=(name,args)=>globalThis.bridge.invoke(name,args);
    export const listen=async(name,fn)=>{globalThis.bridge.listener=fn;return()=>{}};
    export const mirrorSource=()=>()=>{},dropMirrorSource=()=>{},mirrorCall=()=>{},mirrorTarget=()=>()=>{},registerMirrorActions=()=>{};
    export const markPromptSubmitted=()=>{},recordSessionReply=()=>{};
  ` }));
} }] });
const calls = [], starts = [], prompts = [], configs = [], timers = new Map();
let timerId = 0;
const bridge = { listener: null, invoke(name, args) {
  calls.push({ name, ...args });
  if (name === 'acp_session_start') return new Promise(resolve => starts.push({ ...args, resolve }));
  if (name === 'acp_session_request' && args.method === 'session/prompt') return new Promise(resolve => prompts.push(resolve));
  if (name === 'acp_session_request' && args.method === 'session/set_config_option') return new Promise(resolve => configs.push({ ...args.params, resolve }));
  return Promise.resolve(null);
} };
const module = { exports: {} };
runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), Date, JSON, console, crypto: { randomUUID }, bridge,
  setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); } });
const api = module.exports;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/antigravity-turn.json', import.meta.url), 'utf8'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const fireClose = () => { for (const [id, timer] of [...timers]) if (timer.ms === 300) { timers.delete(id); timer.fn(); } };
const event = (start, value) => bridge.listener({ payload: { id: start.id, generation: start.generation, event: value } });

// StrictMode remount retains exactly one native process.
const release = api.retainAcpSession('tab', 'antigravity', '/project'); await tick();
release(); const releaseAgain = api.retainAcpSession('tab', 'antigravity', '/project'); fireClose();
assert.equal(starts.length, 1);
assert.equal(starts[0].tool, 'antigravity', 'the tab starts its own tool\'s ACP server');
starts[0].resolve(fixture.session); await tick(); assert.equal(api.getAcpConnection('tab').ready, true);
assert.equal(await api.sendAcpMessage('tab', 'first'), true);
await api.abortAcp('tab');
assert.equal(calls.filter(c => c.method === 'session/cancel').length, 1, 'cancellation also reaches a model/network wait immediately');
event(starts[0], { method: 'session/update', params: { sessionId: fixture.session.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } } }); await tick();
assert.equal(calls.filter(c => c.method === 'session/cancel').length, 2, 'ignored pre-start cancellation is reasserted at native activity');
await api.abortAcp('tab'); assert.equal(calls.filter(c => c.method === 'session/cancel').length, 2);
prompts.shift()({ stopReason: 'cancelled' }); await tick(); assert.equal(api.getAcpConnection('tab').state.interrupted, true);
await api.sendAcpMessage('tab', 'second'); await api.sendAcpMessage('tab', 'steer');
prompts.shift()({ stopReason: 'end_turn' }); await tick(); assert.equal(api.getAcpConnection('tab').state.busy, true, 'steering reply does not settle an active prompt');
prompts.shift()({ stopReason: 'end_turn' }); await tick(); assert.equal(api.getAcpConnection('tab').state.busy, false);
const firstSetting = api.setAcpConfig('tab', 'model', 'claude-sonnet-4-6');
const secondSetting = api.setAcpConfig('tab', 'mode', 'plan'); await tick();
assert.equal(configs.length, 1, 'rapid settings changes serialize native readbacks');
const promptCount = calls.filter(c => c.method === 'session/prompt').length;
const sendAfterSettings = api.sendAcpMessage('tab', 'after the selected model is applied'); await tick();
assert.equal(calls.filter(c => c.method === 'session/prompt').length, promptCount, 'sending waits for the selected model and mode readbacks');
const selected = structuredClone(fixture.session.configOptions); selected.find(c => c.id === 'model').currentValue = 'claude-sonnet-4-6';
configs.shift().resolve({ configOptions: selected }); await firstSetting; await tick();
assert.equal(configs[0].configId, 'mode'); selected.find(c => c.id === 'mode').currentValue = 'plan';
configs.shift().resolve({ configOptions: selected }); await secondSetting;
assert.equal(api.getAcpConnection('tab').state.configOptions.find(c => c.id === 'mode').currentValue, 'plan');
assert.equal(await sendAfterSettings, true); prompts.shift()({ stopReason: 'end_turn' }); await tick();
await api.sendAcpMessage('tab', 'third');
event(starts[0], { type: 'coffee_exit', detail: 'process disconnected' });
prompts.shift()({ stopReason: 'end_turn' }); await tick();
assert.equal(api.getAcpConnection('tab').state.error, 'process disconnected', 'a late completion cannot erase a process exit');
releaseAgain(); fireClose(); await tick();
assert.equal(api.getAcpConnection('tab'), undefined);

// Late startup/exit and old generations cannot resurrect a closed tab or a new process.
const releasePending = api.retainAcpSession('tab', 'antigravity', '/project', 'resume'); await tick();
const pending = starts.at(-1); releasePending(); fireClose(); await tick();
assert.ok(calls.some(c => c.name === 'acp_session_close' && c.generation === pending.generation));
const releaseNew = api.retainAcpSession('tab', 'antigravity', '/project'); await tick(); const latest = starts.at(-1);
pending.resolve(fixture.session); await tick(); assert.equal(api.getAcpConnection('tab').ready, false);
event(pending, { type: 'coffee_exit', detail: 'stale exit' }); assert.equal(api.getAcpConnection('tab').state.error, undefined);
event(latest, { type: 'coffee_exit', detail: 'early exit' }); latest.resolve(fixture.session); await tick();
assert.equal(api.getAcpConnection('tab').ready, false); assert.equal(api.getAcpConnection('tab').state.error, 'early exit');
releaseNew(); fireClose(); await tick();
const releaseQueued = api.retainAcpSession('queued', 'qwen', '/project'); await tick();
starts.at(-1).resolve(fixture.session); await tick();
const queuedSetting = api.setAcpConfig('queued', 'model', 'gemini-3.8-flash'); await tick();
const queuedSend = api.sendAcpMessage('queued', 'never send after close');
releaseQueued(); fireClose(); await tick();
configs.shift().resolve({ configOptions: fixture.session.configOptions }); await queuedSetting;
assert.equal(await queuedSend, false);
assert.equal(calls.some(c => c.id === 'queued' && c.method === 'session/prompt'), false);
console.log('Antigravity lifecycle: remount ownership, early cancel, steering, close during startup, late replies, generation and exit isolation passed');
