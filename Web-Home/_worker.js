// Cloudflare Pages Function — coffeecli.com
// Uses env.ASSETS to serve CF Pages static files directly.
//
// Routes:
//   /download/<platform>   → visitors in mainland China: redirect to the CNB /
//                            GitCode mirror when it holds this version;
//                            everyone else (and any mirror miss): proxy the
//                            GitHub Release asset. ?source=github|cnb|gitcode
//                            forces one source (for testing).
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

// A mirror's manifest, cached in KV for 5 minutes (a failed fetch is cached
// as null for 2 minutes so a slow mirror can't stall every download).
async function getMirrorManifest(env, mirror) {
  const key = `mirror-manifest-${mirror.id}`
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

async function getLatestAssets(env) {
  // Cache key bumped to v2 after changing the `version` field shape
  // (strip leading "v"). Old v1 entries would otherwise linger in KV
  // for up to an hour after deploy.
  const cacheKey = "latest-release-v2"
  // Separate "last known good" key with no TTL. Used as a stale
  // fallback when the GitHub API call fails (rate limit, outage).
  // Without this, a single 60/hr unauthenticated rate-limit hit on
  // the shared CF Worker IP pool turns every install attempt into a
  // 502 until the next hour rolls over.
  const stableKey = "latest-release-stable-v2"
  if (env.KV) {
    const cached = await env.KV.get(cacheKey)
    if (cached) return JSON.parse(cached)
  }

  let res
  try {
    res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "User-Agent": "CoffeeCLI-Worker" }
    })
  } catch (e) {
    if (env.KV) {
      const stale = await env.KV.get(stableKey)
      if (stale) return JSON.parse(stale)
    }
    throw e
  }
  if (!res.ok) {
    if (env.KV) {
      const stale = await env.KV.get(stableKey)
      if (stale) return JSON.parse(stale)
    }
    throw new Error(`GitHub API ${res.status}`)
  }

  const release = await res.json()
  const assets = {}
  for (const [platform, match] of Object.entries(PLATFORM_PATTERNS)) {
    const asset = release.assets.find(a => match(a.name))
    if (asset) assets[platform] = {
      url: asset.browser_download_url,
      name: asset.name,
      // Strip the leading "v" from the git tag name so `version` is a
      // clean semver. install.ps1 / install.sh prepend their own "v"
      // when displaying, and compare against the Windows registry
      // DisplayVersion field (which has no "v"). Returning "v1.0.7"
      // here produced "vv1.0.7" in the UI and broke the up-to-date
      // check (registry "1.0.7" != API "v1.0.7" → infinite "upgrade").
      version: release.tag_name.replace(/^v/, '')
    }
  }

  if (env.KV) {
    const payload = JSON.stringify(assets)
    await env.KV.put(cacheKey, payload, { expirationTtl: 3600 })
    // Stable copy has no TTL — only ever overwritten by a successful
    // fetch, never expires on its own. Worst case during a long
    // outage: users see the previous release until GitHub recovers.
    await env.KV.put(stableKey, payload)
  }
  return assets
}

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

    // ── everything else → CF Pages static files ──────────────────────────────
    return env.ASSETS.fetch(request)
  }
}
