// Where the client learns about releases: the domestic download mirrors
// (CNB, GitCode — filled by .github/workflows/mirror-release.yml) first, then
// the website. Every source answers with the same shape:
//   { version, releaseDate?, releaseNotes?, files? }
// The mirrors are listed first so visitors in mainland China never depend on
// GitHub or Cloudflare; the website stays as the fallback (and is the only
// source older clients know about).
//
// The Windows self-update download (src/update_sources.rs) uses the same
// mirrors and verifies the installer against the mirror's manifest.

export const MANIFEST_SOURCES = [
  'https://cnb.cool/echobird/coffee-cli-releases/-/git/raw/main/manifest.json',
  'https://api.gitcode.com/api/v5/repos/edison7009/coffee-cli-releases/raw/manifest.json?ref=main',
  'https://coffeecli.com/version.json',
] as const;

export interface UpdateManifest {
  version: string;
  releaseDate?: string;
  releaseNotes?: string;
}

const SEMVER = /^\d+\.\d+\.\d+$/;

export function isNewerVersion(remote: string, local: string): boolean {
  const r = remote.split('.').map(Number), l = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) !== (l[i] ?? 0)) return (r[i] ?? 0) > (l[i] ?? 0);
  }
  return false;
}

function asManifest(body: unknown): UpdateManifest | null {
  if (!body || typeof body !== 'object') return null;
  const m = body as Record<string, unknown>;
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) return null;
  return {
    version: m.version,
    releaseDate: typeof m.releaseDate === 'string' ? m.releaseDate
      : typeof m.publishedAt === 'string' ? m.publishedAt : undefined,
    releaseNotes: typeof m.releaseNotes === 'string' ? m.releaseNotes : undefined,
  };
}

// One source, bounded by its own timeout and by the caller's signal.
async function fetchOne(url: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<UpdateManifest | null> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const onAbort = () => timeout.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, { signal: timeout.signal, cache: 'no-store' });
    if (!response.ok) return null;
    return asManifest(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// The newest release any source reports. All sources are asked at once, so a
// lagging mirror cannot hide a release and a dead one cannot slow the check.
export async function fetchLatestManifest(signal?: AbortSignal, timeoutMs = 8000): Promise<UpdateManifest | null> {
  const results = await Promise.all(MANIFEST_SOURCES.map(url => fetchOne(url, signal, timeoutMs)));
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  let best: UpdateManifest | null = null;
  for (const m of results) {
    if (m && (!best || isNewerVersion(m.version, best.version))) best = m;
  }
  return best;
}

// Release notes for exactly `version`, from the first source (in order) that
// has them.
export async function fetchNotesForVersion(version: string, signal: AbortSignal, timeoutMs = 8000): Promise<string> {
  for (const url of MANIFEST_SOURCES) {
    const m = await fetchOne(url, signal, timeoutMs);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (m?.version === version && m.releaseNotes?.trim()) return m.releaseNotes;
  }
  return '';
}
