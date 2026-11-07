#!/usr/bin/env node
// Refreshes the model price table from the public models.dev catalogue.
//
// The full catalogue is several megabytes and covers hundreds of providers; the
// app only needs list prices for the models its tools run, keyed by model id.
// This trims it to the first-party providers below and writes the same table
// to the website (served as coffeecli.com/prices.json, reachable from China)
// and to the app bundle (the fallback when the site cannot be reached).
//
//   node scripts/refresh-prices.mjs            fetch and write both files
//   node scripts/refresh-prices.mjs <file>     read a saved catalogue instead
//
// Exit code 0 always means the files were written (possibly unchanged); a
// fetch or shape failure exits non-zero and writes nothing.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://models.dev/api.json';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUTS = [join(root, 'Web-Home', 'prices.json'), join(root, 'src-ui', 'src', 'lib', 'model-prices.json')];

// First-party providers, most authoritative first: when two list the same id,
// the earlier one's price wins.
export const PROVIDERS = [
  'anthropic', 'openai', 'google', 'xai', 'deepseek', 'mistral',
  'moonshotai', 'moonshotai-cn', 'zhipuai', 'zai', 'alibaba', 'alibaba-cn',
  'minimax', 'xiaomi', 'stepfun', 'volcengine',
];

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** One price in USD per million tokens, keeping only what billing needs. */
function price(cost) {
  const out = {};
  for (const key of ['input', 'output', 'cache_read', 'cache_write']) {
    const value = number(cost?.[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The trimmed table: { source, models: { "<id>": { input, output, cache_read?, cache_write?, tiers? } } }. */
export function trim(catalogue) {
  const models = {};
  for (const provider of PROVIDERS) {
    for (const [id, model] of Object.entries(catalogue?.[provider]?.models ?? {})) {
      const key = id.toLowerCase();
      if (models[key] || !model?.cost) continue;
      const base = price(model.cost);
      if (base.input === undefined || base.output === undefined) continue;
      // Some models charge more once a request's prompt passes a size.
      const tiers = (Array.isArray(model.cost.tiers) ? model.cost.tiers : [])
        .map(tier => ({ size: number(tier?.tier?.size), ...price(tier) }))
        .filter(tier => tier.size && tier.input !== undefined && tier.output !== undefined)
        .sort((a, b) => a.size - b.size);
      models[key] = tiers.length ? { ...base, tiers } : base;
    }
  }
  const sorted = Object.fromEntries(Object.keys(models).sort().map(key => [key, models[key]]));
  return { source: 'models.dev', models: sorted };
}

async function main() {
  const file = process.argv[2];
  const catalogue = file ? JSON.parse(readFileSync(file, 'utf8')) : await (await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) })).json();
  const table = trim(catalogue);
  const count = Object.keys(table.models).length;
  // A catalogue that lost its main providers is a broken fetch, not a price change.
  if (count < 50 || !Object.keys(table.models).some(id => id.startsWith('claude-'))) {
    throw new Error(`refusing a price table of ${count} models`);
  }
  const text = JSON.stringify(table, null, 1) + '\n';
  for (const output of OUTPUTS) writeFileSync(output, text);
  console.log(`prices: ${count} models`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(error.message ?? error); process.exit(1); });
}
