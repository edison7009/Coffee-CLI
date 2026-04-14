#!/bin/sh
# Coffee CLI — macOS / Linux Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/install/install.sh | sh

set -e

REPO="edison7009/Coffee-CLI"
API="https://api.github.com/repos/$REPO/releases/latest"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
GRAY='\033[0;90m'
RED='\033[0;31m'
RESET='\033[0m'

echo ""
echo "  ${CYAN}Coffee CLI Installer${RESET}"
echo "  ${GRAY}────────────────────${RESET}"

# Fetch latest release JSON
echo "  ${GRAY}Fetching latest release...${RESET}"
RELEASE=$(curl -fsSL "$API")
VERSION=$(echo "$RELEASE" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/' | head -1)
echo "  ${GREEN}Latest: $VERSION${RESET}"

OS=$(uname -s)
ARCH=$(uname -m)

# ── macOS ──────────────────────────────────────────────────────────────────────
if [ "$OS" = "Darwin" ]; then
  if [ "$ARCH" = "arm64" ]; then
    PATTERN="aarch64.dmg"
  else
    PATTERN="x64.dmg"
  fi

  URL=$(echo "$RELEASE" | grep '"browser_download_url"' | grep "$PATTERN" | sed -E 's/.*"([^"]+)".*/\1/' | head -1)
  if [ -z "$URL" ]; then
    echo "  ${RED}ERROR: No macOS DMG found for $ARCH in release assets.${RESET}"
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
  echo "  ${GREEN}Done! Coffee CLI $VERSION installed.${RESET}"
  echo "  ${GRAY}Launch it from /Applications or Spotlight.${RESET}"

# ── Linux ──────────────────────────────────────────────────────────────────────
elif [ "$OS" = "Linux" ]; then
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
      echo "  ${GREEN}Done! Coffee CLI $VERSION installed.${RESET}"
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
  FILENAME=$(basename "$URL")
  echo "  ${GRAY}Downloading $FILENAME...${RESET}"
  curl -fsSL "$URL" -o "$DEST"
  chmod +x "$DEST"

  echo ""
  echo "  ${GREEN}Done! Coffee CLI $VERSION installed to $DEST${RESET}"
  echo "  ${GRAY}Make sure ~/.local/bin is in your PATH.${RESET}"

else
  echo "  ${RED}Unsupported OS: $OS${RESET}"
  exit 1
fi

echo ""
