/**
 * Remote AI CLI agents catalog.
 * Mirrors game-catalog.ts architecture for consistency.
 *
 * Does NOT include built-in utilities (installer, terminal) - those are bundled
 * client-side. This catalog only lists remotely-manageable AI CLI tools.
 */

export interface RemoteAgentEntry {
  /** Stable ID, matches /^[a-z][a-z0-9-]{1,20}$/. Used for icon lookup and spawn key. */
  id: string;
  /** Display name (brand, not localised). */
  name: string;
  /** PTY spawn binary name. Backend validates against strict whitelist. */
  binary: string;
  /** PTY spawn args. Usually []. */
  args: string[];
  /** Remote icon URL (https, coffeecli.com or trusted origin). */
  icon: string;
}

interface AgentCatalogJson {
  version: number;
  updated?: string;
  agents: RemoteAgentEntry[];
}

const CATALOG_URL = 'https://coffeecli.com/agents/catalog.json';
const CACHE_KEY = 'coffee_agents_catalog_cache';

let _cache: AgentCatalogJson | null = null;
let _inflight: Promise<AgentCatalogJson> | null = null;

function loadFromLocalStorage(): AgentCatalogJson | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.agents)) return parsed as AgentCatalogJson;
    return null;
  } catch {
    return null;
  }
}

function fetchCatalogJson(fresh: boolean): Promise<AgentCatalogJson> {
  if (!fresh && _cache) return Promise.resolve(_cache);
  if (!_inflight) {
    // Cache-bust query param on fresh fetches to dodge CDN/browser cache.
    const url = fresh ? `${CATALOG_URL}?t=${Date.now()}` : CATALOG_URL;
    _inflight = fetch(url)
      .then(r => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d: AgentCatalogJson) => {
        _cache = d;
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch {}
        return d;
      })
      .catch(() => {
        // Network failure - fall back to last known cache, else empty.
        const fallback = loadFromLocalStorage();
        if (fallback) {
          _cache = fallback;
          return fallback;
        }
        return { version: 0, agents: [] } as AgentCatalogJson;
      })
      .finally(() => {
        _inflight = null;
      });
  }
  return _inflight;
}

/**
 * Fetch the remote agents catalog. Returns cached copy on network failure,
 * or an empty array if nothing is cached yet.
 *
 * @param opts.fresh - If true, bypass module cache and hit network with a
 *   cache-bust query param. Use when user-facing UX needs latest data
 *   (e.g. opening the Library view).
 */
export async function fetchAgentsCatalog(opts?: { fresh?: boolean }): Promise<RemoteAgentEntry[]> {
  const json = await fetchCatalogJson(opts?.fresh ?? false);
  return json.agents;
}

/**
 * Synchronous read of the localStorage-cached catalog, for use as initial
 * React state to avoid fallback-to-remote content flicker on mount.
 * Returns [] if no cache.
 */
export function getCachedAgentsCatalog(): RemoteAgentEntry[] {
  return loadFromLocalStorage()?.agents ?? [];
}
