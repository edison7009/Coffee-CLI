// Cloudflare Pages Function — coffeecli.com
// Uses env.ASSETS to serve CF Pages static files directly.
//
// Routes:
//   /download/<platform>   → visitors in mainland China: redirect to the CNB /
//                            GitCode mirror when it holds this version;
//                            everyone else (and any mirror miss): proxy the
//                            GitHub Release asset. ?source=github|cnb|gitcode
//                            forces one source (for testing).
//   /                      → first visit: 302 to the visitor's language page
//                            (/zh/, /ja/, …) from Accept-Language; once they
//                            pick a language the coffee_lang cookie decides.
//                            English (and crawlers) stay on /.
//   /*                     → CF Pages static files (env.ASSETS)
//                            (includes /version.json — bumped by hand at
//                             release time; install scripts and the in-app
//                             update check both read it from here.)

const REPO = "edison7009/Coffee-CLI"

// Asset filenames follow `Coffee.CLI_<version>_<OS>_<arch>.<ext>`
// starting v1.9.2 (CI rename step). Pre-v1.9.2 filenames had no OS
// label and used inconsistent arch slugs (amd64 / x86_64 / aarch64);
// we keep the legacy patterns as a fallback so the worker still
// resolves correctly if someone manually republishes an older tag.
const PLATFORM_PATTERNS = {
  "windows": (name) =>
    name.endsWith("Windows_x64-setup.exe") || name.endsWith("x64-setup.exe"),
  "windows-msi": (name) =>
    name.endsWith("Windows_x64.msi") || /_x64(_[^_]+)?\.msi$/.test(name),
  "macos-arm": (name) =>
    name.endsWith("macOS_arm64.dmg") || (name.includes("aarch64") && name.endsWith(".dmg")),
  "macos-intel": (name) =>
    // Tauri-bundler v2 maps x86_64-apple-darwin to `_x64.dmg`; CI then
    // renames to `Coffee.CLI_<ver>_macOS_x64.dmg`. Match both so a
    // manually-published Tauri output still resolves.
    name.endsWith("macOS_x64.dmg") || name.endsWith("_x64.dmg"),
  "linux-deb": (name) =>
    name.endsWith("Linux_x64.deb") || name.endsWith("amd64.deb"),
  "linux-rpm": (name) =>
    name.endsWith("Linux_x64.rpm") || name.endsWith("x86_64.rpm"),
  "linux-appimage": (name) =>
    name.endsWith("Linux_x64.AppImage") || name.endsWith("amd64.AppImage"),
  "linux-arm64-deb": (name) =>
    name.endsWith("Linux_arm64.deb") || name.endsWith("arm64.deb"),
  "linux-arm64-rpm": (name) =>
    name.endsWith("Linux_arm64.rpm") || name.endsWith("aarch64.rpm"),
  "linux-arm64-appimage": (name) =>
    name.endsWith("Linux_arm64.AppImage") || name.endsWith("aarch64.AppImage"),
}

// Download-only mirrors in mainland China, filled by
// .github/workflows/mirror-release.yml. Each holds the latest installers plus
// manifest.json ({ version, files: { <asset name>: { size, sha256 } } }).
const MIRRORS = [
  {
    id: "cnb",
    manifest: "https://cnb.cool/echobird/coffee-cli-releases/-/git/raw/main/manifest.json",
    file: (name) => `https://cnb.cool/echobird/coffee-cli-releases/-/git/raw/main/${encodeURIComponent(name)}`,
  },
  {
    id: "gitcode",
    manifest: "https://api.gitcode.com/api/v5/repos/edison7009/coffee-cli-releases/raw/manifest.json?ref=main",
    file: (name) => `https://api.gitcode.com/api/v5/repos/edison7009/coffee-cli-releases/raw/${encodeURIComponent(name)}?ref=main`,
  },
]

// A mirror's manifest, cached for 5 minutes in memory (and KV when bound);
// a failed fetch is cached as null for 2 minutes so a slow mirror can't
// stall every download.
const mirrorCache = new Map() // id -> { at, manifest } (per isolate, when no KV)

async function getMirrorManifest(env, mirror) {
  const key = `mirror-manifest-${mirror.id}`
  const mem = mirrorCache.get(mirror.id)
  if (mem && Date.now() - mem.at < (mem.manifest ? 300000 : 120000)) return mem.manifest
  if (env.KV) {
    const cached = await env.KV.get(key)
    if (cached) return JSON.parse(cached).manifest
  }
  let manifest = null
  try {
    const res = await fetch(mirror.manifest, {
      headers: { "User-Agent": "CoffeeCLI-Worker" },
      signal: AbortSignal.timeout(4000),
    })
    if (res.ok) {
      const data = await res.json()
      if (data && typeof data.version === "string" && data.files && typeof data.files === "object") manifest = data
    }
  } catch (e) {
    manifest = null
  }
  mirrorCache.set(mirror.id, { at: Date.now(), manifest })
  if (env.KV) {
    await env.KV.put(key, JSON.stringify({ manifest }), { expirationTtl: manifest ? 300 : 120 })
  }
  return manifest
}

// The first mirror (in order) that holds exactly this release's asset.
async function findMirror(env, asset, only) {
  for (const mirror of MIRRORS) {
    if (only && mirror.id !== only) continue
    const m = await getMirrorManifest(env, mirror)
    const entry = m && m.version === asset.version && m.files[asset.name]
    if (entry) return { mirror, size: entry.size }
  }
  return null
}

// Asset names CI publishes for each platform (`Coffee.CLI_<version>_<suffix>`).
const PLATFORM_SUFFIX = {
  "windows": "Windows_x64-setup.exe",
  "windows-msi": "Windows_x64.msi",
  "macos-arm": "macOS_arm64.dmg",
  "macos-intel": "macOS_x64.dmg",
  "linux-deb": "Linux_x64.deb",
  "linux-rpm": "Linux_x64.rpm",
  "linux-appimage": "Linux_x64.AppImage",
  "linux-arm64-deb": "Linux_arm64.deb",
  "linux-arm64-rpm": "Linux_arm64.rpm",
  "linux-arm64-appimage": "Linux_arm64.AppImage",
}

function assetsFor(version, available) {
  const assets = {}
  for (const [platform, suffix] of Object.entries(PLATFORM_SUFFIX)) {
    const name = `Coffee.CLI_${version}_${suffix}`
    if (available && !available.has(name)) continue
    assets[platform] = {
      url: `https://github.com/${REPO}/releases/download/v${version}/${encodeURIComponent(name)}`,
      name,
      version,
    }
  }
  return assets
}

// The latest release's assets, WITHOUT the GitHub API: the unauthenticated
// API allows 60 calls/hour per IP and Cloudflare's shared egress IPs exhaust
// it almost permanently, which made most downloads fail with 502. Instead:
//   version — this site's own /version.json (bumped when a release is
//             published, see .github/workflows/bump-version-json.yml);
//   names   — the fixed CI naming, narrowed to files a mirror manifest
//             lists for that version when one is reachable.
// Kept per isolate for 5 minutes. The API is only a last resort.
let latestCache = null // { at, assets }

async function getLatestAssets(env) {
  if (latestCache && Date.now() - latestCache.at < 5 * 60 * 1000) return latestCache.assets

  let version = null
  try {
    const res = await env.ASSETS.fetch(new Request("https://coffeecli.com/version.json"))
    if (res.ok) {
      const v = (await res.json()).version
      if (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v.replace(/^v/, ""))) version = v.replace(/^v/, "")
    }
  } catch (e) { /* fall through */ }

  let assets = null
  if (version) {
    let available = null
    for (const mirror of MIRRORS) {
      const m = await getMirrorManifest(env, mirror)
      if (m && m.version === version) { available = new Set(Object.keys(m.files)); break }
    }
    assets = assetsFor(version, available)
  } else {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "User-Agent": "CoffeeCLI-Worker" },
    })
    if (!res.ok) throw new Error(`GitHub API ${res.status}`)
    const release = await res.json()
    const tag = release.tag_name.replace(/^v/, "")
    assets = {}
    for (const [platform, match] of Object.entries(PLATFORM_PATTERNS)) {
      const asset = release.assets.find(a => match(a.name))
      if (asset) assets[platform] = { url: asset.browser_download_url, name: asset.name, version: tag }
    }
  }
  latestCache = { at: Date.now(), assets }
  return assets
}

// Homepage languages: dictionary code → path (same table as js/main.js and
// scripts/build-web-i18n.mjs).
const LANG_PATH = {
  "en": "/", "zh": "/zh/", "zh-TW": "/zh-hant/", "ja": "/ja/", "ko": "/ko/",
  "es": "/es/", "fr": "/fr/", "de": "/de/", "pt": "/pt/", "ru": "/ru/",
}

// The first supported language in Accept-Language, by q-value then order.
// Traditional Chinese for zh-TW / zh-HK / zh-MO / zh-Hant, Simplified otherwise.
function langFromAcceptLanguage(header) {
  const ranked = (header || "").split(",").map((part, i) => {
    const [tag, ...params] = part.trim().toLowerCase().split(";")
    const q = params.map(p => p.trim()).find(p => p.startsWith("q="))
    return { tag, q: q ? parseFloat(q.slice(2)) || 0 : 1, i }
  }).filter(e => e.tag && e.q > 0).sort((a, b) => b.q - a.q || a.i - b.i)
  for (const { tag } of ranked) {
    if (tag === "zh" || tag.startsWith("zh-")) {
      return /^zh-(tw|hk|mo|hant)\b/.test(tag) ? "zh-TW" : "zh"
    }
    const base = tag.split("-")[0]
    if (LANG_PATH[base]) return base
  }
  return "en"
}

function cookieLang(header) {
  const m = (header || "").match(/(?:^|;\s*)coffee_lang=([^;]*)/)
  if (!m) return null
  let v
  try { v = decodeURIComponent(m[1]) } catch (e) { return null }
  return LANG_PATH[v] ? v : null
}

const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|lighthouse/i

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const { pathname } = url

    // ── /download/<platform> ─────────────────────────────────────────────────
    const dlMatch = pathname.match(/^\/download\/([a-z0-9-]+)$/)
    if (dlMatch) {
      const platform = dlMatch[1]
      if (!PLATFORM_PATTERNS[platform]) {
        return new Response(
          `Unknown platform "${platform}". Available: ${Object.keys(PLATFORM_PATTERNS).join(", ")}`,
          { status: 400 }
        )
      }

      let assets
      try {
        assets = await getLatestAssets(env)
      } catch (e) {
        return new Response(`Failed to fetch release info: ${e.message}`, { status: 502 })
      }

      const asset = assets[platform]
      if (!asset) {
        return new Response(`No asset found for "${platform}"`, { status: 404 })
      }

      // Mainland China: send the browser / installer straight to a domestic
      // mirror that has this exact version (fast there, and no long proxy
      // through Cloudflare). Falls through to the proxy below on any miss.
      const source = url.searchParams.get("source") || ""
      const country = request.cf && request.cf.country
      const wantMirror = source === "cnb" || source === "gitcode" || (source !== "github" && country === "CN")
      if (wantMirror) {
        const hit = await findMirror(env, asset, source === "cnb" || source === "gitcode" ? source : "")
        if (hit) {
          return new Response(null, {
            status: 302,
            headers: {
              "Location": hit.mirror.file(asset.name),
              "Cache-Control": "no-store",
              "X-Coffee-Version": asset.version,
              "X-Coffee-Source": hit.mirror.id,
              "X-Coffee-Size": String(hit.size),
            },
          })
        }
      }

      // Proxy the asset so the download stays on coffeecli.com (reachable
      // where github.com is slow). If GitHub's CDN answers badly for this
      // edge — or the subrequest throws — retry once, then send the browser
      // straight to the GitHub asset instead of surfacing a bare 502.
      let fileRes = null
      for (let attempt = 0; attempt < 2 && !(fileRes && fileRes.ok && fileRes.body); attempt++) {
        try {
          fileRes = await fetch(asset.url, {
            headers: { "User-Agent": "CoffeeCLI-Worker" },
            redirect: "follow",
          })
        } catch (e) {
          fileRes = null
        }
      }
      if (!fileRes || !fileRes.ok || !fileRes.body) {
        return new Response(null, {
          status: 302,
          headers: { "Location": asset.url, "Cache-Control": "no-store", "X-Coffee-Version": asset.version },
        })
      }
      const headers = {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${asset.name}"`,
        "X-Coffee-Version": asset.version,
        "Cache-Control": "no-store",
      }
      const len = fileRes.headers.get("Content-Length")
      if (len) headers["Content-Length"] = len
      return new Response(fileRes.body, { status: 200, headers })
    }

    // ── /lang-packs/<path> → 410 Gone ────────────────────────────────────────
    // Language pack infrastructure was retired. Intercept at the Worker so
    // edge-cached 200 responses from the pre-deletion era are replaced. The
    // 410 status tells HTTP clients the resource is permanently gone.
    if (pathname.startsWith("/lang-packs/")) {
      return new Response(
        "Coffee CLI language packs have been retired.\n" +
        "See Coffee 101 for installation and usage guides:\n" +
        "  https://coffeecli.com/courses/claude-code\n",
        {
          status: 410,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          }
        }
      )
    }

    // ── / → the visitor's language ───────────────────────────────────────────
    // Crawlers are never redirected, so / stays the indexable English page
    // (the language pages are linked from it through hreflang).
    if (pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      const ua = request.headers.get("User-Agent") || ""
      const lang = BOT_UA.test(ua)
        ? "en"
        : cookieLang(request.headers.get("Cookie")) || langFromAcceptLanguage(request.headers.get("Accept-Language"))
      if (lang !== "en") {
        return new Response(null, {
          status: 302,
          headers: {
            "Location": LANG_PATH[lang] + url.search,
            "Cache-Control": "private, no-store",
            "Vary": "Accept-Language, Cookie",
          },
        })
      }
      const res = await env.ASSETS.fetch(request)
      const out = new Response(res.body, res)
      out.headers.append("Vary", "Accept-Language, Cookie")
      return out
    }

    // ── everything else → CF Pages static files ──────────────────────────────
    return env.ASSETS.fetch(request)
  }
}
