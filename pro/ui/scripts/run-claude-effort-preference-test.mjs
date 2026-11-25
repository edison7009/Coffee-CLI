import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/lib/claude-session.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'native-fixture', setup(builder) {
    builder.onResolve({ filter: /(?:^react$|\/tauri$|^@tauri-apps\/api\/event$)/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'react' ? 'export function useSyncExternalStore() {}' : args.path.includes('/event') ? 'export async function listen() { return () => {}; }' : 'export const invoke = globalThis.nativeInvoke;' }));
  } }],
});
const storage = new Map();
function fixture({ levels = ['low', 'medium', 'high'], reject = false, rejectRestore = false, failReadback = false, storageBlocked = false, holdHigh } = {}) {
  const sessions = new Map(), calls = [];
  let finishClose;
  const closed = new Promise(resolve => { finishClose = resolve; });
  const nativeInvoke = async (command, args) => {
    if (command === 'get_tool_control') return {};
    if (command === 'claude_session_close') { finishClose(); return; }
    calls.push({ command, ...args });
    if (command === 'claude_session_start') {
      sessions.set(args.id, { effort: 'medium' });
      return { sessionId: args.id, initialization: { models: [{ value: 'opus', resolvedModel: 'opus-resolved', supportsEffort: !!levels.length, supportedEffortLevels: levels }] }, history: { data: '', cursor: 0 } };
    }
    const session = sessions.get(args.id), request = args.request;
    if (request.subtype === 'get_settings') {
      if (failReadback && session.effort === 'high') throw new Error('Readback failed');
      return { applied: { model: 'opus-resolved', effort: session.effort }, effective: {} };
    }
    if (reject && request.settings?.effortLevel === 'high') throw new Error('Rejected effort');
    if (rejectRestore && request.settings?.effortLevel === 'low') throw new Error('Policy rejects the saved effort');
    if (holdHigh && request.settings?.effortLevel === 'high') await holdHigh;
    if (request.subtype === 'apply_flag_settings') session.effort = request.settings.effortLevel;
    return {};
  };
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, nativeInvoke, crypto: { randomUUID }, setTimeout, clearTimeout,
    localStorage: {
      getItem: key => { if (storageBlocked) throw new Error('Storage blocked'); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (storageBlocked) throw new Error('Storage blocked'); storage.set(key, value); },
    },
  });
  return { api: module.exports, calls, closed };
}
async function start(h, id, resumeToken) {
  const release = h.api.retainClaudeSession(id, null, resumeToken);
  for (let i = 0; i < 100 && !h.api.getClaudeSession(id).ready; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.api.getClaudeSession(id).ready, true);
  return release;
}
const h = fixture(), release = await start(h, 'first');
try {
  assert.equal(h.api.getClaudeSession('first').effort, 'medium', 'first launch respects the CLI default');
  await h.api.controlClaude('first', { subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } });
  const reopened = fixture(), close = await start(reopened, 'new');
  try { assert.equal(reopened.api.getClaudeSession('new').effort, 'low', 'a fresh app instance restores the confirmed selection'); }
  finally { close(); }
  const resumed = fixture(), closeResumed = await start(resumed, 'resumed', 'existing-conversation');
  try { assert.equal(resumed.api.getClaudeSession('resumed').effort, 'low', 'reopening a conversation also restores the saved preference'); }
  finally { closeResumed(); }
  const restricted = fixture({ rejectRestore: true }), closeRestricted = await start(restricted, 'restricted');
  try {
    assert.equal(restricted.api.getClaudeSession('restricted').effort, 'medium', 'a rejected optional preference keeps the actual CLI selection usable');
    assert.equal(restricted.calls.filter(call => call.command === 'claude_session_start').length, 1, 'a policy rejection cannot cause startup retries');
  } finally { closeRestricted(); }
  for (const options of [{ levels: ['medium', 'high'] }, { levels: [] }, { storageBlocked: true }]) {
    const other = fixture(options), closeOther = await start(other, 'other');
    try {
      assert.equal(other.api.getClaudeSession('other').effort, 'medium');
      assert.equal(other.calls.some(call => call.request?.subtype === 'apply_flag_settings'), false, 'unsupported or unavailable preferences leave CLI settings intact');
    } finally { closeOther(); }
  }
  for (const options of [{ reject: true }, { failReadback: true }]) {
    const other = fixture(options), closeOther = await start(other, 'failed');
    try {
      const before = [...storage];
      await assert.rejects(other.api.controlClaude('failed', { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } }));
      assert.deepEqual([...storage], before, 'an unconfirmed selection never replaces the saved preference');
    } finally { closeOther(); }
  }
  let finishHigh;
  const holdHigh = new Promise(resolve => { finishHigh = resolve; });
  const closing = fixture({ holdHigh }), closeClosing = await start(closing, 'closing');
  const beforeClose = [...storage];
  const pending = closing.api.controlClaude('closing', { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } });
  closeClosing();
  await closing.closed;
  finishHigh();
  await pending;
  assert.deepEqual([...storage], beforeClose, 'a response from a closed session cannot overwrite the saved preference');
  console.log('Claude effort persistence, compatibility and failure handling passed');
} finally { release(); }
