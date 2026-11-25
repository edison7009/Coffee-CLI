/** A worker reopened from history comes back as the desktop conversation it ran as: `node scripts/run-restored-worker-test.mjs`. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/restored-worker.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports });
const { restoredWorkerSession } = module.exports;

const task = tool => ({ sessionId: 's1', tool, cwd: '/project', nativeId: 'native-1', title: 'Worker' });
const antigravity = restoredWorkerSession(task('antigravity'));
assert.equal(antigravity.acpMode, 'conversation', 'an ACP worker reopens as its desktop conversation, not a terminal');
assert.equal(antigravity.resumeToken, 'native-1');
assert.equal(antigravity.strictCwd, true);
assert.equal(restoredWorkerSession(task('claude')).claudeMode, 'conversation');
assert.equal(restoredWorkerSession(task('codex')).codexMode, 'conversation');
assert.equal(restoredWorkerSession(task('claude')).acpMode, undefined);
console.log('OK: a worker reopened from history keeps the desktop conversation it ran as, ACP tools included');
