import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const compiled = await build({
  // The desktop session clients mark a send through notify-prompts; one bundle shares its state.
  stdin: { resolveDir: fileURLToPath(new URL('../src/lib/', import.meta.url)), contents: "export * from './notify-sound'; export { markPromptSubmitted } from './notify-prompts';", loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  define: { 'process.env.NODE_ENV': '"production"' },
});

function fixture({ platform = 'Win32', native = true, failNative = false, disabled = [], chosen = '', focused = true } = {}) {
  const calls = [], timers = new Map();
  let nextTimer = 0, contexts = 0, notes = 0, chosenPlays = 0;
  class AudioContext {
    state = 'running'; currentTime = 0; destination = {};
    constructor() { contexts++; }
    createOscillator() {
      return { frequency: {}, connect() { return this; }, start() { notes++; }, stop() {} };
    }
    async decodeAudioData() { if (chosen === 'broken') throw new Error('Undecodable'); return {}; }
    createBufferSource() { return { connect() { return this; }, start() { chosenPlays++; }, stop() {} }; }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return this; } };
    }
  }
  const module = { exports: {} };
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, AudioContext,
    navigator: { platform }, console: { warn() {} }, document: { hasFocus: () => focused },
    localStorage: { getItem: key => disabled.includes(key) ? 'false' : null },
    window: {
      ...(native ? { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } }, async invoke(command, args) {
        calls.push({ command, kind: args.kind });
        if (failNative) throw new Error('Native playback unavailable');
        if (command === 'notify_sound_read') return new ArrayBuffer(chosen ? 8 : 0);
      } } } : {}),
      setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
      clearTimeout(id) { timers.delete(id); },
    },
  });
  return {
    api: module.exports, calls, contexts: () => contexts, notes: () => notes, chosenPlays: () => chosenPlays,
    status(tool, agentStatus) { module.exports.initNotifySound([{ id: 'session', tool, agentStatus }]); },
    settle() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); },
  };
}

for (const tool of ['claude', 'codex', 'omp', 'kimicode', 'opencode']) {
  const f = fixture();
  f.status(tool, 'idle');
  f.api.markNotifySoundPromptSubmitted('session', tool);
  f.status(tool, 'working'); f.status(tool, 'idle'); f.settle();
  assert.deepEqual(f.calls, [{ command: 'play_notify_sound', kind: 'done' }], `${tool} completion uses native playback`);
  assert.equal(f.contexts(), 0, 'Windows notifications work without a WebView AudioContext');
}

// Desktop conversations mark the send in their session client, not through the terminal.
for (const tool of ['codex', 'opencode', 'pi']) {
  const f = fixture();
  f.status(tool, 'idle');
  f.api.markPromptSubmitted('session');
  f.status(tool, 'working'); f.status(tool, 'idle'); f.settle();
  assert.deepEqual(f.calls, [{ command: 'play_notify_sound', kind: 'done' }], `${tool} desktop completion chimes after a sent prompt`);
}

for (const tool of ['codex', 'kimicode', 'opencode']) {
  const f = fixture();
  f.status(tool, 'working'); f.status(tool, 'idle'); f.settle();
  assert.equal(f.calls.length, 0, `${tool} startup remains silent`);
}

for (const tool of ['claude', 'codex', 'opencode']) {
  const f = fixture();
  const update = agentStatus => f.api.initNotifySound([{ id: 'child', tool, parentId: 'parent', agentStatus }]);
  update('working'); update('idle'); f.settle();
  assert.equal(f.calls.length, 0, `${tool} child completion is silent`);
  update('working'); update('wait_input'); update('wait_input'); f.settle();
  assert.deepEqual(f.calls.map(call => call.kind), ['wait'], `${tool} child permission prompts still notify once without a local user submission`);
  update('idle'); f.settle();
  assert.equal(f.calls.length, 1, 'resuming after permission never adds a child completion sound');
  const firstPrompt = fixture();
  const prompt = [{ id: 'child', tool, parentId: 'parent', agentStatus: 'wait_input' }];
  firstPrompt.api.initNotifySound(prompt); firstPrompt.api.initNotifySound(prompt);
  assert.deepEqual(firstPrompt.calls.map(call=>call.kind),['wait'], `${tool} requests approval even when it is the first observed child status`);
}

const team = fixture();
let tasks = [{ id: 'task', sessionId: 'child', parentId: 'parent', tool: 'codex', phase: 'running' }];
const teamStatus = (parent, child = 'idle') => team.api.initNotifySound([
  { id: 'parent', tool: 'claude', agentStatus: parent },
  { id: 'child', tool: 'codex', parentId: tasks[0].detached ? undefined : 'parent', agentStatus: child },
], tasks);
teamStatus('working', 'working'); teamStatus('idle', 'working'); team.settle();
assert.equal(team.calls.length, 0, 'coordinator pauses are silent while workers run');
tasks = [{ ...tasks[0], phase: 'completed', resultDelivery: 'pending' }];
teamStatus('working'); teamStatus('idle'); team.settle();
assert.equal(team.calls.length, 0, 'undelivered results do not sound like a final summary');
tasks = [{ ...tasks[0], resultDelivery: 'claimed' }];
teamStatus('working', 'working'); teamStatus('idle', 'working'); teamStatus('idle', 'working'); team.settle();
assert.deepEqual(team.calls.map(call => call.kind), ['done'], 'the final coordinator summary sounds once');
tasks = [{ ...tasks[0], detached: true }];
team.api.markNotifySoundPromptSubmitted('child', 'codex');
teamStatus('idle', 'working'); teamStatus('idle', 'idle'); team.settle();
assert.deepEqual(team.calls.map(call => call.kind), ['done', 'done'], 'independent sessions regain their normal completion sound');

const lateTeam = fixture();
lateTeam.status('claude', 'working'); lateTeam.status('claude', 'idle');
lateTeam.api.initNotifySound([{ id: 'session', tool: 'claude', agentStatus: 'idle' }], [{ parentId: 'session', sessionId: 'new-child', phase: 'starting' }]);
lateTeam.settle();
assert.equal(lateTeam.calls.length, 0, 'a newly observed child cancels a queued premature parent chime');

const untrackedTeam = fixture();
const untrackedStatus = parentStatus => untrackedTeam.api.initNotifySound([
  { id: 'parent', tool: 'claude', agentStatus: parentStatus },
  { id: 'child', tool: 'claude', parentId: 'parent', agentStatus: 'working' },
]);
untrackedStatus('working'); untrackedStatus('idle'); untrackedTeam.settle();
assert.equal(untrackedTeam.calls.length, 0, 'an active child stays silent and blocks premature parent completion before task metadata arrives');

const preview = fixture();
preview.api.playNotifySound('done'); preview.api.playNotifySound('wait');
assert.deepEqual(preview.calls.map(call => call.kind), ['done', 'wait'], 'both preview buttons use the native path');
assert.equal(preview.contexts(), 0);

const waiting = fixture();
waiting.status('claude', 'working'); waiting.status('claude', 'idle'); waiting.status('claude', 'wait_input'); waiting.settle();
assert.deepEqual(waiting.calls.map(call => call.kind), ['wait'], 'permission cancels a premature completion chime');

const muted = fixture({ disabled: ['cc-sound-done', 'cc-sound-wait'] });
muted.status('claude', 'working'); muted.status('claude', 'wait_input'); muted.status('claude', 'idle'); muted.settle();
assert.equal(muted.calls.length, 0, 'notification sound switches remain effective');

const disconnected = fixture();
disconnected.api.markNotifySoundPromptSubmitted('session', 'opencode');
disconnected.status('opencode', 'working'); disconnected.status('opencode', 'idle');
disconnected.status('opencode', undefined); disconnected.settle();
assert.equal(disconnected.calls.length, 0, 'losing authoritative status cancels pending completion');
disconnected.status('opencode', 'working'); disconnected.status('opencode', undefined);
disconnected.status('opencode', 'idle'); disconnected.settle();
assert.equal(disconnected.calls.length, 0, 'reconnecting idle does not complete a stale turn');
disconnected.status('opencode', 'working'); disconnected.status('opencode', 'idle'); disconnected.settle();
assert.deepEqual(disconnected.calls.map(call => call.kind), ['done'], 'a fresh complete turn still notifies after reconnect');

for (const options of [{ platform: 'MacIntel' }, { platform: 'Linux x86_64' }, { native: false }]) {
  const f = fixture(options);
  f.api.playNotifySound('done');
  await new Promise(resolve => setImmediate(resolve));
  f.api.playNotifySound('wait');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.command === 'play_notify_sound').length, 0);
  assert.equal(f.notes(), 10, 'other platforms and browser previews retain both synthesized chimes');
}
{
  const f = fixture({ platform: 'MacIntel', chosen: 'sound' });
  f.api.playNotifySound('done');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([f.chosenPlays(), f.notes()], [1, 0], 'a chosen file replaces the chime');
  const broken = fixture({ platform: 'MacIntel', chosen: 'broken' });
  broken.api.playNotifySound('done');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([broken.chosenPlays(), broken.notes()], [0, 6], 'a file that cannot play falls back to the chime');
  const superseded = fixture({ platform: 'MacIntel', chosen: 'sound' });
  superseded.api.playNotifySound('done'); superseded.api.playNotifySound('wait');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(superseded.chosenPlays(), 1, 'a file decoded after a newer sound began stays silent');
}

const fallback = fixture({ failNative: true });
fallback.api.playNotifySound('done');
await new Promise(resolve => setImmediate(resolve));
assert.equal(fallback.notes(), 6, 'native errors retain the WebAudio fallback');
console.log('Notification sound tests passed (completion, preview, permissions, mute and platform routing).');

{
  // A background window flashes for approval and completion even with every sound muted.
  const f = fixture({ focused: false, disabled: ['cc-sound-wait', 'cc-sound-done'] });
  f.status('claude', 'idle'); f.status('claude', 'working'); f.status('claude', 'wait_input');
  f.status('claude', 'working'); f.status('claude', 'idle'); f.settle();
  await new Promise(resolve => setTimeout(resolve, 50));
  const attention = f.calls.filter(call => call.command === 'plugin:window|request_user_attention');
  assert.equal(attention.length, 2, 'wait and done each request attention');
  assert.ok(!f.calls.some(call => call.command === 'play_notify_sound'), 'muted sounds stay silent');
  const focused = fixture();
  focused.status('claude', 'idle'); focused.status('claude', 'working'); focused.status('claude', 'wait_input');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(!focused.calls.some(call => call.command === 'plugin:window|request_user_attention'), 'a focused window is not flashed');
  console.log('notify attention: ok');
}
