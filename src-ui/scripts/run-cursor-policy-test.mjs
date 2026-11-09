// The app keeps the arrow everywhere: global.css resets every element to `cursor: default !important`,
// and only text entry and resize handles may override it. A `!important` hand or grab sneaks past the reset.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src', import.meta.url));
const allowed = new Set(['default', 'text', 'col-resize', 'row-resize', 'ns-resize', 'ew-resize']);
const offenders = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.name.endsWith('.css')) {
      const text = await readFile(path, 'utf8');
      for (const match of text.matchAll(/cursor\s*:\s*([a-z-]+)\s*!important/g)) {
        if (!allowed.has(match[1])) offenders.push(`${path.slice(root.length + 1)}:${text.slice(0, match.index).split('\n').length} cursor: ${match[1]}`);
      }
    }
  }
}
await walk(root);
assert.deepEqual(offenders, [], 'only text and resize cursors may override the arrow');
console.log('ok cursor stays an arrow outside text entry and resize handles');
