// Web 端 over http://<LAN address> (not a secure context): ids still work.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const result = await build({ entryPoints: [fileURLToPath(new URL('../src/remote/bridge.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, console, URLSearchParams, TextEncoder, TextDecoder, setTimeout, clearTimeout });
const { ensureRandomUUID } = module.exports;

// An insecure context: getRandomValues, no randomUUID.
const insecure = { getRandomValues: array => webcrypto.getRandomValues(array) };
ensureRandomUUID(insecure);
const ids = new Set(Array.from({ length: 500 }, () => insecure.randomUUID()));
assert.equal(ids.size, 500, 'ids are unique');
for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

// A secure context keeps the browser's own.
const native = () => 'native';
const secure = { getRandomValues: insecure.getRandomValues, randomUUID: native };
ensureRandomUUID(secure);
assert.equal(secure.randomUUID, native);
ensureRandomUUID(undefined);
console.log('ok Web 端 ids without a secure context (RFC 4122 v4, unique, native kept)');
