import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const group = process.argv[2] ?? 'unit';
if (!['unit', 'browser', 'native'].includes(group)) throw new Error(`Unknown test group: ${group}`);
const scripts = await readdir(new URL('./', import.meta.url));
const tests = scripts.filter(name => {
  if (group === 'native') return name === 'run-orchestration-runtime-test.mjs';
  if (group === 'browser') return /^run-.*-browser-test\.mjs$/.test(name);
  return (name === 'run-review-regressions.mjs' || /^run-.*-test\.mjs$/.test(name))
    && !/-(browser|live|runtime)-test\.mjs$/.test(name);
}).sort();
if (!tests.length) throw new Error(`No ${group} tests found`);
let failed = 0;
for (const name of tests) {
  console.log(`\n--- ${name} ---`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(name, import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit', timeout: 180_000,
  });
  if (result.status !== 0 || result.error) { failed++; console.error(result.error ?? `${name} exited with ${result.status}`); }
}
console.log(`\n${tests.length - failed}/${tests.length} ${group} scripts passed`);
if (failed) process.exitCode = 1;
