#!/bin/sh
# Coffee CLI — macOS / Linux Installer / Updater
# Usage: curl -fsSL https://coffeecli.com/install.sh | sh

set -e

REPO="edison7009/Coffee-CLI"
API="https://api.github.com/repos/$REPO/releases/latest"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
GRAY='\033[0;90m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

echo ""
echo "  ${CYAN}Coffee CLI Installer${RESET}"
echo "  ${GRAY}────────────────────${RESET}"

# Fetch latest release JSON
echo "  ${GRAY}Fetching latest release...${RESET}"
RELEASE=$(curl -fsSL "$API")
# Parse tag_name — prefer jq when available, fall back to grep+sed
if command -v jq >/dev/null 2>&1; then
  LATEST_TAG=$(echo "$RELEASE" | jq -r '.tag_name')
else
  LATEST_TAG=$(echo "$RELEASE" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/' | head -1)
fi
LATEST_VER=$(echo "$LATEST_TAG" | sed 's/^v//')
echo "  ${GREEN}Latest : $LATEST_TAG${RESET}"

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

  # Apple Silicon only (no Intel build in CI)
  if [ "$ARCH" = "arm64" ]; then
    PATTERN="aarch64.dmg"
  else
    echo "  ${YELLOW}Note: No native Intel build available. Running via Rosetta 2.${RESET}"
    PATTERN="aarch64.dmg"
  fi

  URL=$(echo "$RELEASE" | grep '"browser_download_url"' | grep "$PATTERN" | sed -E 's/.*"([^"]+)".*/\1/' | head -1)
  if [ -z "$URL" ]; then
    echo "  ${RED}ERROR: No macOS DMG found in release assets.${RESET}"
    exit 1
  fi

  TMP="/tmp/coffee-cli.dmg"
  FILENAME=$(basename "$URL")
  echo "  ${GRAY}Downloading $FILENAME...${RESET}"
  curl -fsSL "$URL" -o "$TMP"

  echo "  ${GRAY}Mounting DMG...${RESET}"
  MOUNT=$(hdiutil attach "$TMP" -nobrowse -quiet | tail -1 | awk '{print $NF}')
  APP=$(find "$MOUNT" -name "*.app" -maxdepth 1 | head -1)

  echo "  ${GRAY}Installing to /Applications...${RESET}"
  cp -R "$APP" /Applications/
  hdiutil detach "$MOUNT" -quiet
  rm "$TMP"

  echo ""
  echo "  ${GREEN}Done! Coffee CLI $LATEST_TAG installed.${RESET}"
  echo "  ${GRAY}Launch it from /Applications or Spotlight.${RESET}"

# ── Linux ──────────────────────────────────────────────────────────────────────
elif [ "$OS" = "Linux" ]; then

  # Detect installed version — prefer package manager to avoid launching the GUI binary
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
    URL=$(echo "$RELEASE" | grep '"browser_download_url"' | grep "amd64.deb" | sed -E 's/.*"([^"]+)".*/\1/' | head -1)
    if [ -n "$URL" ]; then
      TMP="/tmp/coffee-cli.deb"
      FILENAME=$(basename "$URL")
      echo "  ${GRAY}Downloading $FILENAME...${RESET}"
      curl -fsSL "$URL" -o "$TMP"
      echo "  ${GRAY}Installing (requires sudo)...${RESET}"
      sudo dpkg -i "$TMP"
      rm "$TMP"
      echo ""
      echo "  ${GREEN}Done! Coffee CLI $LATEST_TAG installed.${RESET}"
      exit 0
    fi
  fi

  # AppImage fallback
  URL=$(echo "$RELEASE" | grep '"browser_download_url"' | grep "amd64.AppImage" | sed -E 's/.*"([^"]+)".*/\1/' | head -1)
  if [ -z "$URL" ]; then
    echo "  ${RED}ERROR: No Linux package found in release assets.${RESET}"
    exit 1
  fi

  DEST="$HOME/.local/bin/coffee-cli"
  mkdir -p "$HOME/.local/bin"
  FILENAME=$(basename "$URL")
  echo "  ${GRAY}Downloading $FILENAME...${RESET}"
  curl -fsSL "$URL" -o "$DEST"
  chmod +x "$DEST"

  echo ""
  echo "  ${GREEN}Done! Coffee CLI $LATEST_TAG installed to $DEST${RESET}"
  echo "  ${GRAY}Make sure ~/.local/bin is in your PATH.${RESET}"

else
  echo "  ${RED}Unsupported OS: $OS${RESET}"
  exit 1
fi

echo ""
