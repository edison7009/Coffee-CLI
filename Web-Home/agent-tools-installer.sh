#!/usr/bin/env bash
# Coffee CLI Agent Installer - thin bootstrap (Unix).
# Fetches the modular menu system from coffeecli.com (with jsDelivr/GitHub
# fallback) and dispatches. Keeps startup near zero; all heavy logic lives
# in remote sub-scripts so updates ship without a version bump.
#
# Usage: curl -fsSL https://coffeecli.com/agent-tools-installer.sh | bash

set -u

if [[ -z "${BASH_VERSION:-}" ]]; then
    echo "Coffee CLI installer requires bash." >&2
    exit 1
fi

# When piped via curl, stdin is the script body — reopen /dev/tty so `read`
# can prompt interactively.
if [[ ! -t 0 ]]; then
    if [[ -r /dev/tty ]]; then
        exec </dev/tty
    else
        echo "Coffee CLI installer requires an interactive terminal." >&2
        exit 1
    fi
fi

# CDN bases tried in order. CF first (fast + China), jsDelivr + GitHub as tombstone.
COFFEE_INSTALLER_BASES=(
    "https://coffeecli.com/installer"
    "https://cdn.jsdelivr.net/gh/edison7009/Coffee-CLI@main/Web-Home/installer"
    "https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/Web-Home/installer"
)

COFFEE_CACHE_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t coffee-cli)
trap 'rm -rf "$COFFEE_CACHE_DIR" 2>/dev/null' EXIT INT TERM

# coffee_cache_get <name> → prints cached file path (fetches on miss). name
# may include slashes (e.g. "i18n/menu.json"); slashes are mangled for storage.
coffee_cache_get() {
    local name="$1"
    local safe="${name//\//__}"
    local cached="$COFFEE_CACHE_DIR/$safe"
    if [[ -f "$cached" ]]; then
        printf '%s' "$cached"
        return 0
    fi
    local errors="" base url
    for base in "${COFFEE_INSTALLER_BASES[@]}"; do
        url="$base/$name"
        if curl -fsSL --max-time 8 -o "$cached.tmp" "$url" 2>/dev/null; then
            if grep -qiE '<!DOCTYPE|<html' "$cached.tmp" 2>/dev/null; then
                errors+="$url -> HTML (not a script)\n"
                rm -f "$cached.tmp"
                continue
            fi
            mv "$cached.tmp" "$cached"
            printf '%s' "$cached"
            return 0
        fi
        errors+="$url -> fetch failed\n"
    done
    printf 'Failed to fetch %s\n%b' "$name" "$errors" >&2
    return 1
}

coffee_fetch() {
    local p
    p=$(coffee_cache_get "$1") || return 1
    cat "$p"
}

coffee_source() {
    local p
    p=$(coffee_cache_get "$1") || return 1
    # shellcheck disable=SC1090
    source "$p"
}

if ! coffee_source "menu.sh"; then
    printf '\n  [Error] Could not bootstrap installer menu.\n\n' >&2
    exit 1
fi
