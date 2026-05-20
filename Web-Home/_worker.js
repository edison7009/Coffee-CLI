// Cloudflare Pages Function — coffeecli.com
// Uses env.ASSETS to serve CF Pages static files directly.
//
// Routes:
//   /download/<platform>   → proxy GitHub Release assets
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
