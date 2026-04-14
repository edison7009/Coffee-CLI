/** A single game entry, already localised for the catalog language it lives in. */
export interface RemoteGameEntry {
  id: string;
  file: string;      // e.g. "pal.jsdos"
  title: string;     // localised display name
  icon: string;      // absolute URL on coffeecli.com
  download: string;  // absolute download URL (GitHub releases)
}

interface GameCatalogJson {
  version: number;
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
  const { catalogs } = json;
  return catalogs[lang]
    ?? catalogs[lang.split('-')[0]]
    ?? catalogs['default']
    ?? [];
}
