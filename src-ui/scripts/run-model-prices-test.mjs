/** Model price table and list-price estimates with `node scripts/run-model-prices-test.mjs`. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { trim } from '../../scripts/refresh-prices.mjs';

// Trimming keeps first-party prices, the first provider's on a clash, and tiers by size.
const catalogue = {
  openrouter: { models: { 'claude-x': { cost: { input: 99, output: 99 } } } },
  anthropic: { models: { 'Claude-X': { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, reasoning: 15 } }, free: { cost: { input: 0, output: 0 } }, unpriced: {} } },
  openai: { models: { 'claude-x': { cost: { input: 1, output: 1 } }, 'gpt-t': { cost: { input: 1, output: 4, tiers: [{ input: 3, output: 6, tier: { type: 'context', size: 400 } }, { input: 2, output: 5, tier: { type: 'context', size: 200 } }, { input: 9 }] } } } },
};
const trimmed = trim(catalogue);
assert.deepEqual(trimmed.models['claude-x'], { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }, 'the first-party price, without fields billing does not use');
assert.deepEqual(trimmed.models.free, { input: 0, output: 0 }, 'a free model keeps its zero price');
assert.equal(trimmed.models.unpriced, undefined);
assert.deepEqual(trimmed.models['gpt-t'].tiers.map(t => t.size), [200, 400], 'tiers sorted, incomplete ones dropped');
assert.equal(Object.keys(trimmed.models).some(id => id !== id.toLowerCase()), false);

const storage = new Map();
const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
let fetched = 0, reply = { models: { 'claude-x': { input: 5, output: 25 } } };
const asked = [];
// The first mirror is down and the second serves nonsense: the site's table is used.
const fetch = async url => { fetched++; asked.push(url); if (url.includes('cnb.cool')) throw new Error('offline'); return { ok: true, json: async () => url.includes('gitcode') ? { nonsense: true } : reply }; };
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/lib/model-prices.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, localStorage, fetch, AbortSignal, JSON, Date, Math, URL });
const { modelPrice, costOf, setModelPrices, refreshModelPrices } = module.exports;

assert.ok(modelPrice('claude-sonnet-4-5'), 'the bundled table prices current models');
setModelPrices(trimmed);
for (const name of ['claude-x', 'anthropic/claude-x', 'claude-x[1m]', 'Claude-X-20251001', 'claude-x-latest']) assert.equal(modelPrice(name)?.input, 3, name);
assert.equal(modelPrice('unknown-model'), undefined);
assert.equal(costOf('unknown-model', { input: 1, output: 1 }), undefined, 'no price, no estimate');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);
close(costOf('claude-x', { input: 1_000_000, output: 1_000_000 }), 18);
close(costOf('claude-x', { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000, cacheWrite1h: 400_000 }), 0.3 + 0.6 * 3.75 + 0.4 * 6);
close(costOf('gpt-t', { input: 100, output: 1_000_000 }), (100 * 1 + 1_000_000 * 4) / 1e6);
close(costOf('gpt-t', { input: 150, cacheRead: 100, output: 1_000_000 }), (150 * 2 + 100 * 2 + 1_000_000 * 5) / 1e6, 'a prompt over a tier is billed at it whole');

await refreshModelPrices(Date.now());
assert.equal(fetched, 3); assert.deepEqual(asked.map(u => new URL(u).host), ['cnb.cool', 'api.gitcode.com', 'coffeecli.com'], 'mirrors first, the site last');
assert.equal(modelPrice('claude-x').input, 5, 'the published table replaces the bundled one');
await refreshModelPrices(Date.now());
assert.equal(fetched, 3, 'a fresh table is not fetched again');
reply = { nonsense: true };
await refreshModelPrices(Date.now() + 4 * 24 * 3600 * 1000);
assert.equal(modelPrice('claude-x').input, 5, 'a malformed table is ignored');
assert.ok(JSON.parse(storage.get('cc-model-prices')).table.models['claude-x']);
console.log('OK: prices trim to first-party models, match tool model names, price tiers and caches, and refresh safely');
