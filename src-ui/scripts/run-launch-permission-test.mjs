/** The start page card's permission (方案一) with `node scripts/run-launch-permission-test.mjs`. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/launch-permission.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const store = new Map();
const localStorage = { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, localStorage, JSON });
const { launchPermission, setLaunchPermission, launchToolData, markLaunchPermission, takeLaunchPermission, codexApproval, isLaunchTool } = module.exports;

assert.equal(launchPermission('claude'), '', 'unset: the tool keeps its own default');
assert.equal(launchToolData('claude'), undefined, 'no launch flags until a choice is made');
setLaunchPermission('claude', 'plan');
assert.equal(launchPermission('claude'), 'plan');
assert.equal(launchToolData('claude'), '{"permission":"plan"}');
assert.equal(launchPermission('codex'), '', 'each tool keeps its own choice');
store.set('coffee:claude-launch-permission', 'readOnly');
assert.equal(launchPermission('claude'), '', "another tool's value is not Claude's");
setLaunchPermission('claude', '');
assert.equal(store.has('coffee:claude-launch-permission'), false, 'back to the default clears it');

setLaunchPermission('codex', 'dangerFullAccess');
markLaunchPermission('tab-1', 'codex');
assert.equal(takeLaunchPermission('tab-1'), 'dangerFullAccess', 'a desktop conversation picks it up once');
assert.equal(takeLaunchPermission('tab-1'), undefined, 'and only once');
setLaunchPermission('codex', '');
markLaunchPermission('tab-2', 'codex');
assert.equal(takeLaunchPermission('tab-2'), undefined, 'the default applies nothing');

assert.equal(codexApproval('dangerFullAccess'), 'never');
assert.equal(codexApproval('workspaceWrite'), 'on-request');
assert.ok(isLaunchTool('claude') && isLaunchTool('codex') && !isLaunchTool('opencode') && !isLaunchTool(null));
console.log('OK: the card remembers a permission per tool, hands a terminal its flags and a conversation one apply');
