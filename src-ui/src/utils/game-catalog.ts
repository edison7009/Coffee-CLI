/** A single game entry, already localised for the catalog language it lives in. */
export interface RemoteGameEntry {
  id: string;
  file: string;      // e.g. "pal.jsdos"
  title: string;     // localised display name
  icon: string;      // absolute URL on coffeecli.com
  download: string;  // absolute download URL (GitHub releases)
  dosbox_conf?: string; // remote dosbox.conf — injected at runtime via bundleUpdateConfig
}

interface GameCatalogJson {
  version: number;
  game_configs?: Record<string, { dosbox_conf?: string }>;
  catalogs: Record<string, RemoteGameEntry[]>;
}

const CATALOG_URL = 'https://coffeecli.com/play/game.json';

let _cache: GameCatalogJson | null = null;
let _inflight: Promise<GameCatalogJson> | null = null;

function fetchCatalogJson(): Promise<GameCatalogJson> {
  if (_cache) return Promise.resolve(_cache);
  if (!_inflight) {
    _inflight = fetch(CATALOG_URL)
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((d: GameCatalogJson) => { _cache = d; return _cache; })
      .catch(() => ({ version: 0, catalogs: {} }));
  }
  return _inflight;
}

/**
 * Returns the game list for the given BCP-47 language tag.
 * Falls back: exact match → language prefix → "default" → [].
 */
export async function fetchGameCatalog(lang: string): Promise<RemoteGameEntry[]> {
  const json = await fetchCatalogJson();
  const { catalogs, game_configs } = json;
  const entries = catalogs[lang]
    ?? catalogs[lang.split('-')[0]]
    ?? catalogs['default']
    ?? [];
  if (!game_configs) return entries;
  // Merge per-game remote config (dosbox_conf) into each entry
  return entries.map(e => {
    const cfg = game_configs[e.id];
    return cfg ? { ...e, ...cfg } : e;
  });
}
