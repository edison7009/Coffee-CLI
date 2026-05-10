#!/usr/bin/env bash
# Coffee CLI Playwright wrapper — runs `@playwright/cli playwright-cli` via npx,
# so no global install is required. Auto-injects --session if PLAYWRIGHT_CLI_SESSION
# is set in the environment and the user didn't pass --session explicitly.
set -euo pipefail

if ! command -v npx >/dev/null 2>&1; then
  echo "playwright skill: 'npx' not found on PATH. Install Node.js (>= 18) from https://nodejs.org/" >&2
  exit 1
fi

has_session_flag="false"
for arg in "$@"; do
  case "$arg" in
    --session|--session=*)
      has_session_flag="true"
      break
      ;;
  esac
done

cmd=(npx --yes --package @playwright/cli playwright-cli)
if [[ "${has_session_flag}" != "true" && -n "${PLAYWRIGHT_CLI_SESSION:-}" ]]; then
  cmd+=(--session "${PLAYWRIGHT_CLI_SESSION}")
fi
cmd+=("$@")

exec "${cmd[@]}"
