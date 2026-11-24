// 工作式 / 代码式 (src/lib/layout-mode.ts): a first start opens 工作式, someone who already used Coffee CLI
// keeps 代码式, the choice sticks once made, and 工作式 only starts tools that have a desktop conversation.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/layout-mode.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports });
const { readLayoutMode, workLaunchable } = module.exports;

const storage = (values = {}) => {
  const data = new Map(Object.entries(values));
  return { data, getItem: key => data.has(key) ? data.get(key) : null, setItem: (key, value) => data.set(key, String(value)) };
};

const fresh = storage();
assert.equal(readLayoutMode(fresh), 'work', 'a first start opens 工作式');
assert.equal(fresh.data.get('cc-layout'), 'work', 'and remembers it');
fresh.data.set('cc-shape', 'basalt');
assert.equal(readLayoutMode(fresh), 'work', 'a saved choice never flips once the app writes its other settings');

const returning = storage({ 'cc-shape': 'carbon', 'cc-theme': 'oat' });
assert.equal(readLayoutMode(returning), 'code', 'an existing user keeps the workspace they know');
assert.equal(returning.data.get('cc-layout'), 'code');

assert.equal(readLayoutMode(storage({ 'cc-layout': 'code' })), 'code');
assert.equal(readLayoutMode(storage({ 'cc-layout': 'work', 'cc-shape': 'soft' })), 'work');
assert.equal(readLayoutMode(storage({ 'cc-layout': 'sideways', 'cc-lang': 'en' })), 'code', 'an unknown value falls back like a missing one');
const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
assert.equal(readLayoutMode(broken), 'code', 'unreadable storage keeps the full workspace');

for (const tool of ['claude', 'codex', 'opencode', 'pi', 'dsh', 'antigravity']) assert.ok(workLaunchable(tool), `${tool} has a desktop conversation`);
for (const tool of ['terminal', 'kimicode', 'qwen', 'remote', null, undefined, '']) assert.ok(!workLaunchable(tool), `${tool} is not started in 工作式`);

console.log('layout mode: ok');
