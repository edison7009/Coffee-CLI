// A sub-task's opening instruction (src/orchestration.rs worker_prompt) is recognised and split into its task.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/worker-prompt.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports });
const { parseWorkerPrompt } = module.exports;

// Shaped exactly as worker_prompt writes it.
const prompt = (id, task) => `You are a worker assigned from the parent session inside Coffee CLI. Task ID: ${id}. Work only on the task below and in the current project. Other workers may be editing it: coordinate file ownership and preserve their changes. Do not launch additional workers or change permissions.\n\nUse a POSIX shell.\nFinish with a concise final response describing changes, verification and remaining work.\n/usr/bin/coffee-worker complete --outcome succeeded --summary "What changed"\n\nTASK\n${task}`;

const parsed = parseWorkerPrompt(prompt('t_8f2c', '检查终端配色在浅色主题下的文字对比度。\n\n不要修改设置页文案。'));
assert.equal(parsed.id, 't_8f2c');
assert.equal(parsed.task, '检查终端配色在浅色主题下的文字对比度。\n\n不要修改设置页文案。', 'the task keeps its own paragraphs');
assert.ok(parsed.instructions.startsWith('You are a worker') && !parsed.instructions.includes('\nTASK\n'), 'the instructions stop before the task');
assert.equal(parseWorkerPrompt(prompt('0f9a1e7c-2b3d-4e5f-8a9b-0c1d2e3f4a5b', 'Review only')).id, '0f9a1e7c-2b3d-4e5f-8a9b-0c1d2e3f4a5b');
// A task that itself has a TASK line stays whole: the split is at the instruction's own (first) marker.
assert.equal(parseWorkerPrompt(prompt('t1', 'Rename the TASK column.\n\nTASK\nthen update tests')).task, 'Rename the TASK column.\n\nTASK\nthen update tests');
assert.equal(parseWorkerPrompt('Please check the TASK below\n\nTASK\nfix it'), null, 'an ordinary message is the user\'s');
assert.equal(parseWorkerPrompt(prompt('t2', '   ')), null, 'no task, no card');
console.log('worker prompt: ok');
