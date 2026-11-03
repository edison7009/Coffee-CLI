/** Run the open-tab restore fixtures with `node scripts/run-open-tabs-test.mjs`. */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testFile = join(here, '..', 'src', 'lib', 'open-tabs.test.ts');
const temp = mkdtempSync(join(tmpdir(), 'coffee-open-tabs-test-'));
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
