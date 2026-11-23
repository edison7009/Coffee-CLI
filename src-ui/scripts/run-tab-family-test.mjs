// Sub-windows sit under their parent's number instead of in the tab strip / rail (lib/tab-family.ts).
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/tab-family.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'stub-tauri', setup(b) { b.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'tauri', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const commands = {};', loader: 'js' })); } }] });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, process, console });
const { tabFamilies, familyState } = module.exports;
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

const tabs = [
  { id: 'p', tool: 'claude', toolTitle: 'Parent' },
  { id: 'w1', tool: 'claude', agentStatus: 'working' },
  { id: 'w2', tool: 'codex', parentId: 'p', toolTitle: 'Legacy child', agentStatus: 'wait_input' },
  { id: 'orphan', tool: 'claude' },
  { id: 'free', tool: 'claude' },
  { id: 'blank', tool: null, parentId: 'p' },
];
const tasks = [
  { id: 't1', parentId: 'p', sessionId: 'w1', title: 'Check contrast', phase: 'running', activity: 'working', question: null },
  { id: 't2', parentId: 'gone', sessionId: 'orphan', title: 'Parent closed', phase: 'running', activity: 'working', question: null },
  { id: 't3', parentId: 'p', sessionId: 'free', title: 'Detached', phase: 'closed', detached: true, question: null },
];
const { children, childIds } = tabFamilies(tabs, tasks);
same([...childIds].sort(), ['w1', 'w2'], 'workers and parentId children sit under their parent');
same(children.get('p').map(kid => [kid.id, kid.title, kid.state]), [['w1', 'Check contrast', 'working'], ['w2', 'Legacy child', 'waiting']]);
assert.ok(!childIds.has('orphan'), 'a worker whose parent tab is gone stays a tab of its own');
assert.ok(!childIds.has('free'), 'a detached worker is an independent tab');
assert.ok(!childIds.has('blank'), 'an empty placeholder tab is not a sub-window');
assert.equal(familyState(children.get('p')), 'waiting', 'one waiting on you outranks one at work');
assert.equal(familyState([{ state: 'starting' }, { state: 'idle' }]), 'working');
assert.equal(familyState([{ state: 'completed' }]), 'idle');
console.log('tab family: ok');
