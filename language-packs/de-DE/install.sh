#!/bin/sh
# Coffee CLI Language Pack Installer — Deutsch
# Usage: curl -fsSL https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/language-packs/de-DE/install.sh | sh

set -e

LANG_CODE="de-DE"
LANG_LABEL="Deutsch"
REPO_URL="https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/language-packs/de-DE"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
GRAY='\033[0;90m'
RED='\033[0;31m'
RESET='\033[0m'

echo ""
echo "  ${CYAN}Coffee CLI Language Pack — ${LANG_LABEL}${RESET}"
echo "  ${GRAY}─────────────────────────────────${RESET}"

# 1. Find npm Claude Code
if ! command -v npm >/dev/null 2>&1; then
  echo "  ${RED}ERROR: npm not installed. Install Node.js first.${RESET}"
  exit 1
fi
NPM_ROOT=$(npm root -g 2>/dev/null)
CLI_PATH="$NPM_ROOT/@anthropic-ai/claude-code/cli.js"
if [ ! -f "$CLI_PATH" ]; then
  echo "  ${RED}ERROR: Claude Code not installed via npm.${RESET}"
  echo "  ${GRAY}Install it from the Coffee Installer menu first (option 1).${RESET}"
  exit 1
fi

# 2. Get Claude Code version for backup tagging
CLAUDE_VERSION=$(node -e "console.log(require('$NPM_ROOT/@anthropic-ai/claude-code/package.json').version)" 2>/dev/null || echo "unknown")
echo "  ${GRAY}Detected Claude Code v${CLAUDE_VERSION}${RESET}"

COFFEE_DIR="$HOME/.coffee-cli"
BACKUP_DIR="$COFFEE_DIR/backups"
BACKUP="$BACKUP_DIR/cli-${CLAUDE_VERSION}.js"
mkdir -p "$BACKUP_DIR"

# 3. Backup original (only if no backup exists for this version)
if [ ! -f "$BACKUP" ]; then
  echo "  ${GRAY}Backing up original cli.js...${RESET}"
  cp "$CLI_PATH" "$BACKUP"
fi

# 4. Always start from pristine backup (so re-install is idempotent + clean)
echo "  ${GRAY}Restoring pristine cli.js from backup...${RESET}"
cp "$BACKUP" "$CLI_PATH"

# 5. Download patcher + dictionary to temp dir
TMP=$(mktemp -d 2>/dev/null || mktemp -d -t coffee-langpack)
trap 'rm -rf "$TMP"' EXIT INT TERM
echo "  ${GRAY}Downloading patcher and dictionary...${RESET}"
curl -fsSL -o "$TMP/patch-cli.js" "$REPO_URL/patch-cli.js"
curl -fsSL -o "$TMP/cli-translations.json" "$REPO_URL/cli-translations.json"

# 6. Apply patch
echo "  ${GRAY}Applying ${LANG_LABEL} patch...${RESET}"
COUNT=$(node "$TMP/patch-cli.js" "$CLI_PATH" "$TMP/cli-translations.json")

# 7. Mark active language
mkdir -p "$COFFEE_DIR"
printf "%s" "$LANG_CODE" > "$COFFEE_DIR/active-language"

echo ""
echo "  ${GREEN}✓ Applied ${COUNT} translations${RESET}"
echo "  ${GREEN}Claude Code is now in ${LANG_LABEL}.${RESET}"
echo "  ${GRAY}Run 'claude' to start. To revert, run the uninstall script.${RESET}"
echo ""
