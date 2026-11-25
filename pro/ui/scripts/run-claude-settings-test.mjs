import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

let unavailable = false;
let applied = { model: 'sonnet', effort: 'xhigh', ultracode: true };
let failNext = false;
let failReadNext = false;
const writes = [];
const invoke = async (command, args) => {
  if (command === 'claude_session_start') return { sessionId: 'native', initialization: { models: [], commands: [] }, history: { data: '', cursor: 0 }, bypassAvailable: true };
  if (command === 'claude_session_close') return;
  assert.equal(command, 'claude_session_control');
  const request = args.request;
  if (request.subtype === 'get_settings') {
    if (failReadNext || args.id === 'initial-failure') { failReadNext = false; throw new Error('Fixture settings read failed'); }
    return { applied, effective: {} };
  }
  if (failNext) { failNext = false; throw new Error('Fixture rejected settings'); }
  writes.push(request);
  if (request.subtype === 'set_model') applied = { model: request.model, effort: 'high', ultracode: false };
  else if (request.subtype === 'apply_flag_settings') {
    const settings = request.settings;
    applied = { ...applied, ...(settings.effortLevel ? { effort: settings.effortLevel } : {}), ...(typeof settings.ultracode === 'boolean' ? { ultracode: settings.ultracode } : {}) };
    // Like a CLI where workflows or the model do not allow Ultracode: asked for, but never reported active.
    if (unavailable && typeof settings.ultracode === 'boolean') applied = { ...applied, ultracode: false, ultracodeRequested: settings.ultracode, ultracodeAvailable: false };
  }
  return {};
};
const result = await build({ entryPoints: ['src/lib/claude-session.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'mock-native-session', setup(build) {
    build.onResolve({ filter: /(?:^react$|\/tauri$|^@tauri-apps\/api\/event$)/ }, args => ({ path: args.path, namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'react' ? 'export function useSyncExternalStore() {}' : args.path.includes('/event') ? 'export async function listen() { return () => {}; }' : 'export const invoke = globalThis.__claudeInvoke;' }));
  } }],
});
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, __claudeInvoke: invoke, crypto: { randomUUID }, setTimeout, clearTimeout, console });
const { retainClaudeSession, getClaudeSession, controlClaude } = module.exports;
const release = retainClaudeSession('settings', null);
try {
  for (let i = 0; i < 100 && !getClaudeSession('settings').ready; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(getClaudeSession('settings').ultracode, true);
  assert.equal(getClaudeSession('settings').effort, 'xhigh');
  assert.equal(getClaudeSession('settings').bypassAvailable, true);
  console.log('ok initialization restores actual Ultracode state');
  await controlClaude('settings', { subtype: 'apply_flag_settings', settings: { effortLevel: 'max', ultracode: false } });
  assert.equal(getClaudeSession('settings').effort, 'max'); assert.equal(getClaudeSession('settings').ultracode, false);
  console.log('ok selecting Max disables Ultracode');
  await controlClaude('settings', { subtype: 'apply_flag_settings', settings: { effortLevel: 'xhigh', ultracode: true } });
  assert.equal(getClaudeSession('settings').effort, 'xhigh'); assert.equal(getClaudeSession('settings').ultracode, true);
  console.log('ok Ultracode preserves its separate flag alongside xhigh');
  await controlClaude('settings', { subtype: 'apply_flag_settings', settings: { alwaysThinkingEnabled: false } });
  assert.equal(getClaudeSession('settings').ultracode, true); assert.equal(getClaudeSession('settings').thinking, false);
  console.log('ok unrelated thinking changes preserve Ultracode');
  unavailable = true;
  await controlClaude('settings', { subtype: 'apply_flag_settings', settings: { effortLevel: 'xhigh', ultracode: false } });
  assert.equal(getClaudeSession('settings').ultracode, false);
  await controlClaude('settings', { subtype: 'apply_flag_settings', settings: { effortLevel: 'xhigh', ultracode: true } });
  assert.equal(getClaudeSession('settings').ultracode, true, 'a switch that is on but not available still reads back as on');
  assert.equal(getClaudeSession('settings').effort, 'xhigh');
  console.log('ok Ultracode reads back as requested even when the CLI reports it unavailable');
  unavailable = false;
  await controlClaude('settings', { subtype: 'apply_flag_settings', settings: { effortLevel: 'xhigh', ultracode: true } });
  failNext = true;
  await assert.rejects(controlClaude('settings', { subtype: 'apply_flag_settings', settings: { effortLevel: 'low', ultracode: false } }));
  assert.equal(getClaudeSession('settings').ultracode, true); assert.equal(getClaudeSession('settings').effort, 'xhigh');
  console.log('ok rejected settings preserve the previous applied selection');
  await controlClaude('settings', { subtype: 'set_model', model: 'haiku' });
  assert.equal(getClaudeSession('settings').ultracode, false); assert.equal(getClaudeSession('settings').effort, 'high');
  console.log('ok model switches reconcile the actual CLI settings');
  assert.equal(writes.length, 7);
  await controlClaude('settings', { subtype: 'apply_flag_settings', settings: { effortLevel: 'xhigh', ultracode: true } });
  failReadNext = true;
  await assert.rejects(controlClaude('settings', { subtype: 'apply_flag_settings', settings: { effortLevel: 'low', ultracode: false } }));
  assert.equal(applied.ultracode, false);
  assert.equal(getClaudeSession('settings').ready, false);
  assert.match(getClaudeSession('settings').error, /Fixture settings read failed/);
  assert.equal(getClaudeSession('settings').errorKey, 'claude.error.settings_readback');
  console.log('ok settings accepted but readback failure blocks unconfirmed further actions');
  await controlClaude('settings', { subtype: 'interrupt' });
  assert.equal(getClaudeSession('settings').ready, false);
  assert.match(getClaudeSession('settings').error, /Fixture settings read failed/);
  assert.equal(getClaudeSession('settings').errorKey, 'claude.error.settings_readback');
  console.log('ok interruption remains available without hiding an unconfirmed-settings error');
  const releasePermission = retainClaudeSession('permissions', null);
  try {
    for (let i = 0; i < 100 && !getClaudeSession('permissions').ready; i++) await new Promise(resolve => setTimeout(resolve, 10));
    await controlClaude('permissions', { subtype: 'set_permission_mode', mode: 'bypassPermissions' });
    assert.equal(getClaudeSession('permissions').permissionMode, 'bypassPermissions');
    failNext = true;
    await assert.rejects(controlClaude('permissions', { subtype: 'set_permission_mode', mode: 'plan' }));
    assert.equal(getClaudeSession('permissions').permissionMode, 'bypassPermissions', 'a rejected mode change must not update the selection');
    await controlClaude('permissions', { subtype: 'set_permission_mode', mode: 'default' });
    assert.equal(getClaudeSession('permissions').permissionMode, 'default');
    console.log('ok bypass availability, actual mode control and rejected-selection rollback');
  } finally { releasePermission(); }
  const releaseFailed = retainClaudeSession('initial-failure', null);
  try {
    for (let i = 0; i < 500 && !getClaudeSession('initial-failure').error; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(getClaudeSession('initial-failure').ready, false);
    assert.match(getClaudeSession('initial-failure').error, /settings read failed/);
    console.log('ok initialization read failure cannot masquerade as an ordinary effort level');
  } finally { releaseFailed(); }
  console.log('10 Claude settings checks passed');
} finally { release(); }
