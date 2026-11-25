/**
 * Runs the terminal-interaction parser fixtures.
 *
 * The project has no test framework installed, so this bundles the fixture +
 * parser with the already-present esbuild devDependency and executes it in
 * Node. Usage (from src-ui/):
 *
 *   node scripts/run-terminal-interaction-test.mjs
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testFile = join(here, '..', 'src', 'lib', 'terminal-interaction.test.ts');

const tmp = mkdtempSync(join(tmpdir(), 'coffee-interaction-test-'));
const entryFile = join(tmp, 'entry.mjs');
const outFile = join(tmp, 'out.mjs');

writeFileSync(
  entryFile,
  `import { main } from ${JSON.stringify(testFile)};\nmain();\n`,
);

await build({
  entryPoints: [entryFile],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: outFile,
  logLevel: 'warning',
  // The parser's react import is only referenced from the (uncalled) hook and
  // tree-shaken out; bundle it anyway so resolution never depends on cwd.
  external: [],
});

execFileSync(process.execPath, [outFile], { stdio: 'inherit' });
