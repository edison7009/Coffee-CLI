#!/bin/sh
# Coffee CLI — macOS / Linux Installer / Updater
# Usage: curl -fsSL https://coffeecli.com/install.sh | sh

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

CYAN='\033[0;36m'
GREEN='\033[0;32m'
GRAY='\033[0;90m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

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
  if command -v dpkg > /dev/null 2>&1; then
    PLATFORM="linux-deb"
  else
    PLATFORM="linux-appimage"
  fi
else
  echo "  ${RED}Unsupported OS: $OS${RESET}"
  exit 1
fi

# Parse version from version.json — minimal JSON, no jq required
echo "  ${GRAY}Fetching latest version...${RESET}"
VERSION_JSON=$(curl -fsSL "$VERSION_BASE?platform=$PLATFORM")
LATEST_VER=$(echo "$VERSION_JSON" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/')

# Empty `version` = the installer for this platform isn't out yet (CI
# probably still running for a just-tagged release). Report gracefully
# instead of trying to download something that 404s.
if [ -z "$LATEST_VER" ] || [ "$LATEST_VER" = "$VERSION_JSON" ]; then
  echo "  ${YELLOW}Latest : ($PLATFORM installer not yet published)${RESET}"
  echo ""
  echo "  ${YELLOW}The $PLATFORM build for the newest release is still being${RESET}"
  echo "  ${YELLOW}compiled by CI (takes ~15-20 min after a new tag).${RESET}"
  echo "  ${YELLOW}Please try again in about 15 minutes.${RESET}"
  echo ""
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

  URL="$DOWNLOAD_BASE/macos-arm"
  TMP="/tmp/coffee-cli.dmg"

  echo "  ${GRAY}Downloading...${RESET}"
  if ! curl -fsSL "$URL" -o "$TMP"; then
    echo ""
    echo "  ${RED}Download failed.${RESET}"
    echo "  ${YELLOW}The macOS installer may still be uploading. Retry in ~5 min.${RESET}"
    echo ""
    exit 1
  fi

  echo "  ${GRAY}Mounting DMG...${RESET}"
  MOUNT=$(hdiutil attach "$TMP" -nobrowse -quiet | tail -1 | awk '{print $NF}')
  APP=$(find "$MOUNT" -name "*.app" -maxdepth 1 | head -1)

  echo "  ${GRAY}Installing to /Applications...${RESET}"
  cp -R "$APP" /Applications/
  hdiutil detach "$MOUNT" -quiet
  rm "$TMP"

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
    if ! curl -fsSL "$DOWNLOAD_BASE/linux-deb" -o "$TMP"; then
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
  if ! curl -fsSL "$DOWNLOAD_BASE/linux-appimage" -o "$DEST"; then
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
