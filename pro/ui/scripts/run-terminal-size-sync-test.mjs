/** Run the terminal-size coordinator fixtures with `node scripts/run-terminal-size-sync-test.mjs`. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testFile = join(here, '..', 'src', 'lib', 'terminal-size-sync.test.ts');
const temp = mkdtempSync(join(tmpdir(), 'coffee-terminal-size-test-'));
const entryFile = join(temp, 'entry.mjs');
const outFile = join(temp, 'out.mjs');

try {
  writeFileSync(
    entryFile,
    `import { main } from ${JSON.stringify(testFile)};\nawait main();\n`,
  );
  await build({
    entryPoints: [entryFile],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: outFile,
    logLevel: 'warning',
  });
  execFileSync(process.execPath, [outFile], { stdio: 'inherit' });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
