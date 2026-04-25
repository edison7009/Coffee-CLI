#!/bin/sh
# Coffee CLI in-app installer is retired. This stub redirects to Coffee 101
# (the Claude Code course on coffeecli.com) which is the new home for all
# install + usage guides. Kept here so old `curl | sh` invocations and
# v1.4.2-and-earlier app clients land on a friendly page instead of 404.
#
# Usage (deprecated): curl -fsSL https://coffeecli.com/agent-tools-installer.sh | sh

URL="https://coffeecli.com/courses/claude-code"

printf '\n'
printf "  Coffee CLI's one-click installer has been retired.\n"
printf '\n'
printf "  Visit Coffee 101 for installation and usage guides:\n"
printf "  %s\n" "$URL"
printf '\n'

case "$(uname -s)" in
  Darwin) open "$URL" 2>/dev/null || true ;;
  Linux)  xdg-open "$URL" 2>/dev/null || true ;;
  MINGW*|CYGWIN*|MSYS*) start "$URL" 2>/dev/null || true ;;
esac
