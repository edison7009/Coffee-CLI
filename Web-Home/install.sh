#!/bin/sh
# Coffee CLI — macOS / Linux Installer / Updater
# Usage: curl -fsSL https://coffeecli.com/install.sh | sh

set -e

# Resolve version and binary via coffeecli.com (CF-hosted, China-accessible).
# /version.json is served from Web-Home; /download/<platform> is a CF Worker
# route that proxies the matching GitHub Release asset. Keeps the install
# path off api.github.com so the script doesn't stall on a blocked or slow
# GitHub API from mainland networks.
VERSION_URL="https://coffeecli.com/version.json"
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

# Parse version from version.json — minimal JSON, no jq required
echo "  ${GRAY}Fetching latest version...${RESET}"
VERSION_JSON=$(curl -fsSL "$VERSION_URL")
LATEST_VER=$(echo "$VERSION_JSON" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
if [ -z "$LATEST_VER" ] || [ "$LATEST_VER" = "$VERSION_JSON" ]; then
  echo "  ${RED}ERROR: Failed to parse version from $VERSION_URL${RESET}"
  exit 1
fi
echo "  ${GREEN}Latest : v$LATEST_VER${RESET}"

OS=$(uname -s)
ARCH=$(uname -m)

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
  curl -fsSL "$URL" -o "$TMP"

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
    curl -fsSL "$DOWNLOAD_BASE/linux-deb" -o "$TMP"
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
  curl -fsSL "$DOWNLOAD_BASE/linux-appimage" -o "$DEST"
  chmod +x "$DEST"

  echo ""
  echo "  ${GREEN}Done! Coffee CLI v$LATEST_VER installed to $DEST${RESET}"
  echo "  ${GRAY}Make sure ~/.local/bin is in your PATH.${RESET}"

else
  echo "  ${RED}Unsupported OS: $OS${RESET}"
  exit 1
fi

echo ""
