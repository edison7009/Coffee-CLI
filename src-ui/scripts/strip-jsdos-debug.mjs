// Post-build cleanup: removes js-dos files that are dead weight in production.
//
// 1. wdosbox-x.* — DOSBox-X enhanced engine. We only call `emulators.dosboxWorker`
//    in DosPlayer.tsx, which loads wdosbox.wasm. The -x variant is never fetched.
// 2. *.map / *.symbols — source maps and wasm symbol files. Only loaded by DevTools
//    or on wasm crashes; never fetched during normal play.
//
// Saves ~9.9 MB uncompressed (~5-6 MB in installer). Cross-platform: pure Node fs.

import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'js-dos');

if (!existsSync(root)) {
  console.error(`[strip-jsdos-debug] ${root} not found — skipping (did vite build run?)`);
  process.exit(0);
}

const dosboxXFiles = [
  'emulators/wdosbox-x.wasm',
  'emulators/wdosbox-x.js',
  'emulators/wdosbox-x.js.symbols',
];

let totalBytes = 0;
const removed = [];

function tryRemove(rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  const size = statSync(abs).size;
  rmSync(abs, { force: true });
  totalBytes += size;
  removed.push({ rel, size });
}

for (const f of dosboxXFiles) tryRemove(f);

function walkAndStrip(dir) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walkAndStrip(abs);
    } else if (name.endsWith('.map') || name.endsWith('.symbols')) {
      const size = st.size;
      rmSync(abs, { force: true });
      totalBytes += size;
      removed.push({ rel: abs.slice(root.length + 1).replace(/\\/g, '/'), size });
    }
  }
}
walkAndStrip(root);

const mb = (totalBytes / 1024 / 1024).toFixed(2);
console.log(`[strip-jsdos-debug] removed ${removed.length} files, ${mb} MB total`);
for (const { rel, size } of removed) {
  console.log(`  - ${rel} (${(size / 1024).toFixed(1)} KB)`);
}
