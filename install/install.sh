#!/bin/sh
# Coffee CLI — macOS / Linux Installer / Updater
# Usage:   curl -fsSL https://coffeecli.com/install.sh | sh
# License: AGPL-3.0-or-later (https://github.com/edison7009/Coffee-CLI/blob/main/LICENSE)

set -e

# Resolve version and binary via coffeecli.com (CF-hosted, China-accessible).
# /version.json?platform=<p> returns the latest release tag ONLY when that
# platform's asset has been uploaded to GitHub Releases. If CI is still
# mid-build (mac ARM usually finishes first, Linux/Windows take longer),
# the endpoint reports an empty version for the not-yet-ready platforms.
# That prevents the earlier race where the version bumped instantly but
# the per-platform binary took another 15 min to appear.
# /download/<platform> is a CF Worker route that proxies the matching
# GitHub Release asset. Keeps the install path off api.github.com so the
# script doesn't stall on a blocked or slow GitHub API from mainland
# networks.
VERSION_BASE="https://coffeecli.com/version.json"
DOWNLOAD_BASE="https://coffeecli.com/download"
# Direct GitHub Releases fallback used when coffeecli.com is unreachable
# (CF Worker outage, GitHub API rate limit on the shared Worker IP pool,
# DNS issues). The user's own IP has its own 60/h anonymous quota and
# won't share that pool, so this is meaningfully more reliable for the
# single-user case.
GITHUB_API="https://api.github.com/repos/edison7009/Coffee-CLI/releases/latest"

# Resolve escape sequences via printf at assignment time so the
# variables hold real ESC bytes. Plain '\033[...m' string literals
# only render when the shell's `echo` interprets backslash escapes
# (sh/dash do, bash does not unless -e). Users piping the script
# through `| bash` would otherwise see literal "\033[0;36m" output.
CYAN=$(printf '\033[0;36m')
GREEN=$(printf '\033[0;32m')
GRAY=$(printf '\033[0;90m')
YELLOW=$(printf '\033[0;33m')
RED=$(printf '\033[0;31m')
RESET=$(printf '\033[0m')

echo ""
echo "  ${CYAN}Coffee CLI Installer${RESET}"
echo "  ${GRAY}────────────────────${RESET}"

OS=$(uname -s)
ARCH=$(uname -m)

# Detect the concrete platform slug we'll hit on both /version.json and
# /download. Picking this before the version lookup lets the server tell
# us precisely whether OUR platform's installer is ready yet, rather than
# reporting that SOME platform has a new release and then failing at
# download time.
PLATFORM=""
if [ "$OS" = "Darwin" ]; then
  # macOS only publishes a native arm64 build; Intel Macs run it via Rosetta.
  PLATFORM="macos-arm"
elif [ "$OS" = "Linux" ]; then
  # We ship amd64 and arm64 Linux artifacts. Pick the slug based on
  # `uname -m`. Anything outside the two known arch families (armv7,
  # riscv64, ppc64le …) fails fast — without this guard those would
  # request an amd64 asset, get 404, and curl's --retry-all-errors
  # would burn five retry attempts on a request that can never succeed.
  case "$ARCH" in
    x86_64|amd64)
      LINUX_ARCH="amd64"
      ;;
    aarch64|arm64)
      LINUX_ARCH="arm64"
      ;;
    *)
      echo "  ${RED}Unsupported Linux architecture: $ARCH${RESET}"
      echo "  ${YELLOW}Coffee CLI currently ships amd64 and arm64 Linux builds only.${RESET}"
      echo "  ${YELLOW}Open an issue: https://github.com/edison7009/Coffee-CLI/issues${RESET}"
      exit 1
      ;;
  esac
  if command -v dpkg > /dev/null 2>&1; then
    if [ "$LINUX_ARCH" = "arm64" ]; then
      PLATFORM="linux-arm64-deb"
    else
      PLATFORM="linux-deb"
    fi
  else
    if [ "$LINUX_ARCH" = "arm64" ]; then
      PLATFORM="linux-arm64-appimage"
    else
      PLATFORM="linux-appimage"
    fi
  fi
else
  echo "  ${RED}Unsupported OS: $OS${RESET}"
  exit 1
fi

# Pattern that picks our platform's asset out of the GitHub release.
# Mirrors the matchers in Web-Home/_worker.js — keep the two in sync.
case "$PLATFORM" in
  macos-arm)            ASSET_GREP='aarch64[^"]*\.dmg' ;;
  macos-intel)          ASSET_GREP='x64[^"]*\.dmg' ;;
  linux-deb)            ASSET_GREP='amd64\.deb' ;;
  linux-appimage)       ASSET_GREP='amd64\.AppImage' ;;
  linux-arm64-deb)      ASSET_GREP='arm64\.deb' ;;
  linux-arm64-appimage) ASSET_GREP='aarch64\.AppImage' ;;
esac

FALLBACK_DOWNLOAD_URL=""

# Parse version from version.json — minimal JSON, no jq required
echo "  ${GRAY}Fetching latest version...${RESET}"
VERSION_JSON=$(curl -fsSL "$VERSION_BASE?platform=$PLATFORM" 2>/dev/null || true)
LATEST_VER=$(echo "$VERSION_JSON" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')

# coffeecli.com unreachable (CF Worker 502 / network) → fall back to
# api.github.com directly. This pulls the latest release JSON, extracts
# tag_name for the version and the matching asset's browser_download_url
# for the later download step (so we don't hit coffeecli.com a second
# time and fail again).
if [ -z "$LATEST_VER" ] || [ "$LATEST_VER" = "$VERSION_JSON" ]; then
  echo "  ${GRAY}Trying GitHub directly...${RESET}"
  GH_JSON=$(curl -fsSL -H "User-Agent: CoffeeCLI-Install" "$GITHUB_API" 2>/dev/null || true)
  if [ -n "$GH_JSON" ]; then
    GH_TAG=$(echo "$GH_JSON" | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')
    LATEST_VER=$(echo "$GH_TAG" | sed 's/^v//')
    if [ -n "$ASSET_GREP" ]; then
      FALLBACK_DOWNLOAD_URL=$(echo "$GH_JSON" | grep -oE "\"browser_download_url\"[[:space:]]*:[[:space:]]*\"[^\"]*${ASSET_GREP}\"" | head -1 | sed -E 's/.*"(https[^"]*)"$/\1/')
      # GitHub returned a release tag, but our platform's asset hasn't
      # been uploaded yet (mid-CI). Reset LATEST_VER so the "try again
      # in 10 minutes" branch below fires, instead of advertising a
      # version we can't actually deliver.
      if [ -z "$FALLBACK_DOWNLOAD_URL" ]; then
        LATEST_VER=""
      fi
    fi
  fi
fi

# Empty `version` = the installer for this platform isn't out yet (CI
# probably still running for a just-tagged release). Show an explicit
# "come back later" message and pause so the window doesn't auto-close
# on the user before they read it (some launch flows spawn a fresh
# terminal that closes the moment the script returns).
if [ -z "$LATEST_VER" ] || [ "$LATEST_VER" = "$VERSION_JSON" ]; then
  echo ""
  echo "  ${YELLOW}A new version of Coffee CLI was just released.${RESET}"
  echo "  ${YELLOW}The server is currently redeploying.${RESET}"
  echo "  ${YELLOW}Please try again in about 10 minutes.${RESET}"
  echo ""
  # Read from /dev/tty since stdin is consumed by `curl | sh`. If no tty
  # is attached (CI / redirected), skip the prompt and exit silently.
  if [ -r /dev/tty ]; then
    printf "  ${GRAY}Press Enter to close...${RESET}"
    read _ < /dev/tty
    echo ""
  fi
  exit 0
fi
echo "  ${GREEN}Latest : v$LATEST_VER${RESET}"

# ── macOS ──────────────────────────────────────────────────────────────────────
if [ "$OS" = "Darwin" ]; then

  # Detect installed version
  INSTALLED_VER=""
  APP_PATH="/Applications/Coffee CLI.app"
  if [ -d "$APP_PATH" ]; then
    INSTALLED_VER=$(defaults read "$APP_PATH/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)
  fi

  if [ -n "$INSTALLED_VER" ]; then
    echo "  ${GRAY}Installed: v$INSTALLED_VER${RESET}"
    if [ "$INSTALLED_VER" = "$LATEST_VER" ]; then
      echo ""
      echo "  ${GREEN}Coffee CLI is already up to date (v$INSTALLED_VER).${RESET}"
      echo ""
      exit 0
    fi
    echo "  ${YELLOW}Upgrading v$INSTALLED_VER  →  v$LATEST_VER ...${RESET}"
  else
    echo "  ${GRAY}Not installed — performing fresh install...${RESET}"
  fi

  if [ "$ARCH" != "arm64" ]; then
    echo "  ${YELLOW}Note: No native Intel build available. Running via Rosetta 2.${RESET}"
  fi

  URL="${FALLBACK_DOWNLOAD_URL:-$DOWNLOAD_BASE/macos-arm}"
  TMP="/tmp/coffee-cli.dmg"

  echo "  ${GRAY}Downloading...${RESET}"
  if ! curl -fL --progress-bar --retry 5 --retry-all-errors --retry-delay 2 -C - "$URL" -o "$TMP"; then
    echo ""
    echo "  ${RED}Download failed.${RESET}"
    echo "  ${YELLOW}The macOS installer may still be uploading. Retry in ~5 min.${RESET}"
    echo ""
    exit 1
  fi

  echo "  ${GRAY}Mounting DMG...${RESET}"
  # Grab the /Volumes/... mountpoint directly. `awk '{print $NF}'` breaks
  # when the volume name has spaces (e.g. "Coffee CLI 1.6.4"), since $NF
  # only captures the last whitespace-delimited token.
  MOUNT=$(hdiutil attach "$TMP" -nobrowse -quiet | grep -oE '/Volumes/[^	]+' | tail -1)
  if [ -z "$MOUNT" ] || [ ! -d "$MOUNT" ]; then
    echo "  ${RED}Failed to mount DMG.${RESET}"
    rm -f "$TMP"
    exit 1
  fi
  APP=$(find "$MOUNT" -maxdepth 1 -name "*.app" | head -1)
  if [ -z "$APP" ]; then
    echo "  ${RED}No .app bundle found inside DMG.${RESET}"
    hdiutil detach "$MOUNT" -quiet || true
    rm -f "$TMP"
    exit 1
  fi

  echo "  ${GRAY}Installing to /Applications...${RESET}"
  cp -R "$APP" /Applications/
  hdiutil detach "$MOUNT" -quiet
  rm "$TMP"

  # Strip the com.apple.quarantine xattr that curl-downloaded files
  # inherit. On Apple Silicon macOS 14+, Gatekeeper silently refuses
  # to launch adhoc-signed apps that still carry quarantine — clicking
  # the dock icon does nothing, no error dialog. Removing the xattr
  # tells LaunchServices the user has explicitly opted to trust this
  # binary (equivalent to right-click → Open the first time).
  xattr -dr com.apple.quarantine "/Applications/Coffee CLI.app" 2>/dev/null || true

  echo ""
  echo "  ${GREEN}Done! Coffee CLI v$LATEST_VER installed.${RESET}"
  echo "  ${GRAY}Launch it from /Applications or Spotlight.${RESET}"

# ── Linux ──────────────────────────────────────────────────────────────────────
elif [ "$OS" = "Linux" ]; then

  # Detect installed version — prefer package manager
  INSTALLED_VER=""
  if command -v dpkg > /dev/null 2>&1; then
    INSTALLED_VER=$(dpkg -s coffee-cli 2>/dev/null | grep '^Version:' | sed 's/Version: //' || true)
  fi
  if [ -z "$INSTALLED_VER" ] && command -v rpm > /dev/null 2>&1; then
    INSTALLED_VER=$(rpm -q --queryformat '%{VERSION}' coffee-cli 2>/dev/null || true)
  fi

  if [ -n "$INSTALLED_VER" ]; then
    echo "  ${GRAY}Installed: v$INSTALLED_VER${RESET}"
    if [ "$INSTALLED_VER" = "$LATEST_VER" ]; then
      echo ""
      echo "  ${GREEN}Coffee CLI is already up to date (v$INSTALLED_VER).${RESET}"
      echo ""
      exit 0
    fi
    echo "  ${YELLOW}Upgrading v$INSTALLED_VER  →  v$LATEST_VER ...${RESET}"
  else
    echo "  ${GRAY}Not installed — performing fresh install...${RESET}"
  fi

  # Prefer .deb if dpkg is available, fall back to AppImage
  if command -v dpkg > /dev/null 2>&1; then
    TMP="/tmp/coffee-cli.deb"
    echo "  ${GRAY}Downloading .deb package...${RESET}"
    if ! curl -fL --progress-bar --retry 5 --retry-all-errors --retry-delay 2 -C - "${FALLBACK_DOWNLOAD_URL:-$DOWNLOAD_BASE/linux-deb}" -o "$TMP"; then
      echo ""
      echo "  ${RED}Download failed.${RESET}"
      echo "  ${YELLOW}The Linux .deb may still be uploading. Retry in ~5 min.${RESET}"
      echo ""
      exit 1
    fi
    echo "  ${GRAY}Installing (requires sudo)...${RESET}"
    sudo dpkg -i "$TMP"
    rm "$TMP"
    echo ""
    echo "  ${GREEN}Done! Coffee CLI v$LATEST_VER installed.${RESET}"
    exit 0
  fi

  # AppImage fallback
  DEST="$HOME/.local/bin/coffee-cli"
  mkdir -p "$HOME/.local/bin"
  echo "  ${GRAY}Downloading AppImage...${RESET}"
  if ! curl -fL --progress-bar --retry 5 --retry-all-errors --retry-delay 2 -C - "${FALLBACK_DOWNLOAD_URL:-$DOWNLOAD_BASE/linux-appimage}" -o "$DEST"; then
    echo ""
    echo "  ${RED}Download failed.${RESET}"
    echo "  ${YELLOW}The AppImage may still be uploading. Retry in ~5 min.${RESET}"
    echo ""
    exit 1
  fi
  chmod +x "$DEST"

  echo ""
  echo "  ${GREEN}Done! Coffee CLI v$LATEST_VER installed to $DEST${RESET}"
  echo "  ${GRAY}Make sure ~/.local/bin is in your PATH.${RESET}"

fi

echo ""
