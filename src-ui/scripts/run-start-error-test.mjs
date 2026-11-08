/** How a desktop conversation's start error reads, with `node scripts/run-start-error-test.mjs`. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/start-error.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports });
const { startErrorText } = module.exports;
const t = (key, vars) => `${key}${vars ? JSON.stringify(vars) : ''}`;

assert.equal(startErrorText('Could not start Codex: No such file or directory (os error 2)', 'Codex CLI', t), 'conversation.tool_missing{"tool":"Codex CLI"}', 'a missing program reads as not installed');
const conflict = '2026-11-08T11:47:55.739874Z ERROR codex_core::session: Failed to create session: thread-store conflict: thread 01a1baf3 already has an active writer';
assert.equal(startErrorText(conflict, 'Codex CLI', t), 'conversation.in_use', 'a thread held by another app says it is open elsewhere');
assert.equal(startErrorText('Model not found', 'Codex CLI', t), 'Model not found', 'anything else is shown as it came');
console.log('OK: start errors read as not installed, open elsewhere, or as they came');
