// Cloudflare Pages Function — coffeecli.com
// Replaces the standalone CF Worker. Uses env.ASSETS to serve CF Pages
// static files directly (no GitHub raw proxying for lang-packs).
//
// Routes:
//   /download/<platform>   → proxy GitHub Release assets
//   /play/<file>           → proxy GitHub game-assets Release
//   /lang-packs/<path>     → serve from CF Pages static files (Web-Home/lang-packs/)
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
  const cacheKey = "latest-release"
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
      version: release.tag_name
    }
  }

  if (env.KV) {
    await env.KV.put(cacheKey, JSON.stringify(assets), { expirationTtl: 3600 })
  }
  return assets
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)

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
          "Cache-Control": "public, max-age=86400",
          "Access-Control-Allow-Origin": "*",
        }
      })
    }

    // ── /lang-packs/<path> ───────────────────────────────────────────────────
    // Serve directly from CF Pages static assets (Web-Home/lang-packs/).
    // No GitHub raw proxy — files are bundled in the Pages deployment.
    if (pathname.startsWith("/lang-packs/")) {
      const assetRes = await env.ASSETS.fetch(request)
      if (assetRes.status === 200) {
        // Force correct Content-Type for .ps1 and .sh so PowerShell/bash
        // receives text, not application/octet-stream.
        const ext = pathname.split(".").pop()
        const ct = ext === "ps1" || ext === "sh" ? "text/plain; charset=utf-8"
                 : ext === "json"                 ? "application/json; charset=utf-8"
                 : assetRes.headers.get("Content-Type") || "text/plain"
        return new Response(assetRes.body, {
          status: 200,
          headers: {
            "Content-Type": ct,
            "Cache-Control": "public, max-age=300",
          }
        })
      }
      return new Response(`Not found: ${pathname}`, { status: 404 })
    }

    // ── everything else → CF Pages static files ──────────────────────────────
    return env.ASSETS.fetch(request)
  }
}
