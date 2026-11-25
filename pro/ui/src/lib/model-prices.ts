// List prices for the models the tools run, in USD per million tokens, to estimate what a turn cost when the tool
// does not report it. The table ships with the app and is refreshed every few days from the same places as the version
// manifest: the two download mirrors, then the website (all rebuilt from the public models.dev catalogue). A turn
// priced from it is an estimate at list price, which a relay or a subscription may not charge.
import BUNDLED from './model-prices.json';

export interface Price { input: number; output: number; cache_read?: number; cache_write?: number }
export interface ModelPrice extends Price { tiers?: (Price & { size: number })[] }
export interface PriceTable { source?: string; models: Record<string, ModelPrice> }
/** A turn's or request's tokens. `input` excludes cached and cache-written tokens, as the tools report it. */
export interface TokenUsage { input: number; output: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number }

export const PRICE_SOURCES = [
  'https://cnb.cool/echobird/coffee-cli-releases/-/git/raw/main/prices.json',
  'https://api.gitcode.com/api/v5/repos/edison7009/coffee-cli-releases/raw/prices.json?ref=main',
  'https://coffeecli.com/prices.json',
] as const;
const STORAGE_KEY = 'cc-model-prices';
const REFRESH_AFTER = 3 * 24 * 60 * 60 * 1000;

const valid = (table: unknown): table is PriceTable => {
  const models = (table as PriceTable | null)?.models;
  return !!models && typeof models === 'object' && Object.values(models).some(m => typeof m?.input === 'number' && typeof m?.output === 'number');
};

let table: PriceTable = BUNDLED as PriceTable;
let fetchedAt = 0;
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { fetchedAt?: number; table?: unknown } | null;
  if (saved && valid(saved.table)) { table = saved.table; fetchedAt = saved.fetchedAt ?? 0; }
} catch { /* Best-effort operation; failure is non-fatal. */ }

let refreshing: Promise<void> | null = null;
/** Fetches the published table when the cached one is a few days old. Failures keep the current table. */
export function refreshModelPrices(now = Date.now()): Promise<void> {
  if (now - fetchedAt < REFRESH_AFTER) return Promise.resolve();
  refreshing ??= (async () => {
    // In order, as for the version manifest: the first source that serves a well-formed table wins.
    for (const url of PRICE_SOURCES) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        const next: unknown = response.ok ? await response.json() : null;
        if (!valid(next)) continue;
        table = next; fetchedAt = now;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ fetchedAt, table })); } catch { /* Best-effort operation; failure is non-fatal. */ }
        return;
      } catch { /* Offline or blocked: try the next source; the bundled or cached table stays. */ }
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** For tests: price from a given table. */
export function setModelPrices(next: PriceTable): void { table = next; }

/**
 * The list price of a model as a tool names it: provider prefixes (`anthropic/…`), context suffixes (`…[1m]`) and
 * dated snapshots (`…-20251001`) fall back to the plain id.
 */
export function modelPrice(model: string | undefined): ModelPrice | undefined {
  let id = (model ?? '').trim().toLowerCase();
  if (!id) return undefined;
  id = id.replace(/\[[^\]]*\]$/, '');
  const candidates = [id, id.slice(id.lastIndexOf('/') + 1)];
  for (const candidate of [...candidates]) candidates.push(candidate.replace(/-\d{8}$/, ''), candidate.replace(/-latest$/, ''));
  for (const candidate of candidates) { const price = table.models[candidate]; if (price) return price; }
  return undefined;
}

/**
 * What a request cost at list price, or undefined for a model with no price. A prompt (input, cached and
 * cache-written tokens together) over a tier's size is billed whole at that tier. Cache reads and writes fall back to
 * the input price when unlisted; an hour-long cache write costs twice the input price.
 */
export function costOf(model: string | undefined, usage: TokenUsage): number | undefined {
  const price = modelPrice(model);
  if (!price) return undefined;
  const cacheRead = usage.cacheRead ?? 0, cacheWrite = usage.cacheWrite ?? 0, cacheWrite1h = Math.min(usage.cacheWrite1h ?? 0, cacheWrite);
  const prompt = usage.input + cacheRead + cacheWrite;
  const tier = price.tiers?.filter(t => prompt > t.size).at(-1) ?? price;
  return (usage.input * tier.input + usage.output * tier.output + cacheRead * (tier.cache_read ?? tier.input)
    + (cacheWrite - cacheWrite1h) * (tier.cache_write ?? tier.input) + cacheWrite1h * tier.input * 2) / 1_000_000;
}
