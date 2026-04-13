#!/bin/sh
# Coffee CLI Language Pack Uninstaller — Español
# Usage: curl -fsSL https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/language-packs/es-ES/uninstall.sh | sh

set -e

LANG_LABEL="Español"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
GRAY='\033[0;90m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
RESET='\033[0m'

echo ""
echo "  ${CYAN}Coffee CLI Language Pack — Uninstall ${LANG_LABEL}${RESET}"
echo "  ${GRAY}─────────────────────────────────────────${RESET}"

if ! command -v npm >/dev/null 2>&1; then
  echo "  ${RED}ERROR: npm not installed.${RESET}"
  exit 1
fi
NPM_ROOT=$(npm root -g 2>/dev/null)
CLI_PATH="$NPM_ROOT/@anthropic-ai/claude-code/cli.js"
if [ ! -f "$CLI_PATH" ]; then
  echo "  ${YELLOW}Claude Code not installed; nothing to uninstall.${RESET}"
  exit 0
fi

CLAUDE_VERSION=$(node -e "console.log(require('$NPM_ROOT/@anthropic-ai/claude-code/package.json').version)" 2>/dev/null || echo "unknown")
BACKUP="$HOME/.coffee-cli/backups/cli-${CLAUDE_VERSION}.js"

if [ ! -f "$BACKUP" ]; then
  echo "  ${YELLOW}No backup found for Claude Code v${CLAUDE_VERSION}.${RESET}"
  echo "  ${GRAY}To restore the original English version, run:${RESET}"
  echo "  ${GRAY}  npm install -g @anthropic-ai/claude-code${RESET}"
  exit 1
fi

echo "  ${GRAY}Restoring original cli.js from backup...${RESET}"
cp "$BACKUP" "$CLI_PATH"
rm -f "$HOME/.coffee-cli/active-language"

echo ""
echo "  ${GREEN}✓ Claude Code restored to original English.${RESET}"
echo ""
