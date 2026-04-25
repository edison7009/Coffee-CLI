// Cloudflare Pages Function — coffeecli.com
// Uses env.ASSETS to serve CF Pages static files directly.
//
// Routes:
//   /version.json          → dynamic version report (honors ?platform=)
//   /download/<platform>   → proxy GitHub Release assets
//   /play/<file>           → proxy GitHub game-assets Release
//   /*                     → CF Pages static files (env.ASSETS)

const REPO = "edison7009/Coffee-CLI"
const GAME_ASSETS_BASE = `https://github.com/${REPO}/releases/download/game-assets`

const PLATFORM_PATTERNS = {
  "windows":        (name) => name.endsWith("x64-setup.exe"),
  "macos-arm":      (name) => name.includes("aarch64") && name.endsWith(".dmg"),
  "macos-intel":    (name) => name.includes("x64") && name.endsWith(".dmg"),
  "linux-deb":      (name) => name.endsWith("amd64.deb"),
  "linux-appimage": (name) => name.endsWith("amd64.AppImage"),
}

async function getLatestAssets(env) {
  // Cache key bumped to v2 after changing the `version` field shape
  // (strip leading "v"). Old v1 entries would otherwise linger in KV
  // for up to an hour after deploy.
  const cacheKey = "latest-release-v2"
  if (env.KV) {
    const cached = await env.KV.get(cacheKey)
    if (cached) return JSON.parse(cached)
  }

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { "User-Agent": "CoffeeCLI-Worker" }
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)

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
    await env.KV.put(cacheKey, JSON.stringify(assets), { expirationTtl: 3600 })
  }
  return assets
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const { pathname } = url

    // ── /version.json ────────────────────────────────────────────────────────
    // Dynamic version report. Derived from the same GitHub latest-release
    // call we already cache for /download, so there is zero extra round-trip
    // when /version.json is hit immediately before /download/<platform>.
    //
    // Why this matters: the install scripts (install.ps1 / install.sh) read
    // this URL to decide whether an upgrade is available. If it reports the
    // new tag BEFORE that platform's installer is uploaded to GitHub
    // Releases (a 15-20 min CI build window), the user sees "Upgrading..."
    // immediately followed by a download 404. Gating the advertised version
    // behind actual asset availability eliminates that race.
    //
    // Query:
    //   ?platform=<windows|macos-arm|macos-intel|linux-deb|linux-appimage>
    //     → returns the tag of the latest release where THAT platform's
    //       asset is present. If the latest release hasn't published that
    //       platform yet, falls back to reporting an empty version so the
    //       client treats it as "no upgrade available yet".
    //   (no query) → returns the latest release tag as-is (may point at an
    //                in-flight release; kept for backward compat and
    //                non-platform-specific consumers).
    if (pathname === "/version.json") {
      try {
        const assets = await getLatestAssets(env)
        const platform = url.searchParams.get("platform")
        let version = ""
        if (platform) {
          // Only advertise the new version to a platform once its asset
          // exists. Prevents install scripts from chasing a phantom release.
          version = assets[platform]?.version ?? ""
        } else {
          // No platform filter: return any version seen in assets (all
          // entries share release.tag_name, so pick the first available).
          const first = Object.values(assets)[0]
          version = first?.version ?? ""
        }
        return new Response(JSON.stringify({ version }), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            // Short cache so a freshly-completed CI build shows up within a
            // minute, without hammering the GitHub API from every install.
            "Cache-Control": "public, max-age=60",
            "Access-Control-Allow-Origin": "*",
          }
        })
      } catch (e) {
        return new Response(JSON.stringify({ version: "", error: e.message }), {
          status: 502,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        })
      }
    }

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

      const fileRes = await fetch(asset.url, {
        headers: { "User-Agent": "CoffeeCLI-Worker" }
      })
      return new Response(fileRes.body, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${asset.name}"`,
          "Content-Length": fileRes.headers.get("Content-Length") || "",
          "X-Coffee-Version": asset.version,
          "Cache-Control": "no-store",
        }
      })
    }

    // ── /play/<file> ─────────────────────────────────────────────────────────
    const playMatch = pathname.match(/^\/play\/([^/]+\.jsdos)$/)
    if (playMatch) {
      const filename = playMatch[1]
      const upstream = `${GAME_ASSETS_BASE}/${filename}`
      const fileRes = await fetch(upstream, {
        headers: { "User-Agent": "CoffeeCLI-Worker" }
      })
      if (!fileRes.ok) return new Response(`Game not found: ${filename}`, { status: fileRes.status })
      return new Response(fileRes.body, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": fileRes.headers.get("Content-Length") || "",
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
        }
      })
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
