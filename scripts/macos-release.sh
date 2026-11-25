#!/usr/bin/env bash
# Coffee CLI — finish a macOS release from the .app Tauri built.
#
#   scripts/macos-release.sh <rust-target> <version> <bundle-dir>
#
# <bundle-dir> is target/<rust-target>/release/bundle; the DMG lands in
# <bundle-dir>/dmg/Coffee CLI_<version>_<aarch64|x64>.dmg (the name the
# release workflow renames from).
#
# COFFEE_MACOS_SIGNED=true — the .app carries a Developer ID signature
# (Tauri signed it with APPLE_SIGNING_IDENTITY); this script notarizes and
# staples the .app, builds the DMG, signs, notarizes and staples the DMG.
# Notarization credentials come from NOTARY_KEY_ID + NOTARY_ISSUER +
# NOTARY_KEY_PATH (App Store Connect API key) or NOTARY_APPLE_ID +
# NOTARY_PASSWORD + NOTARY_TEAM_ID — deliberately not Tauri's APPLE_* names,
# so Tauri only signs and every Apple round trip happens here, where it is
# retried without recompiling.
#
# Otherwise — ad-hoc signature WITHOUT hardened runtime: hardened runtime +
# ad-hoc + no notarization makes Gatekeeper silently kill the GUI launch.
#
# Either way the DMG is laid out by dmgbuild (scripts/dmg-settings.py) and
# every result is checked before the release workflow may upload it: right
# architecture and version, drag-to-install layout present, and for signed
# builds a Developer ID chain, hardened runtime, stapled tickets and a
# Gatekeeper pass for both the .app and the DMG.
set -euo pipefail

target=${1:?rust target required}
version=${2:?version required}
bundle=${3:?bundle directory required}
signed=${COFFEE_MACOS_SIGNED:-false}
root=$(cd "$(dirname "$0")/.." && pwd)

case "$target" in
  aarch64-apple-darwin) arch=arm64; dmg_arch=aarch64 ;;
  x86_64-apple-darwin) arch=x86_64; dmg_arch=x64 ;;
  *) echo "unsupported macOS target: $target" >&2; exit 1 ;;
esac
case "$signed" in true|false) ;; *) echo "COFFEE_MACOS_SIGNED must be true or false" >&2; exit 1 ;; esac

app="$bundle/macos/Coffee CLI.app"
test -d "$app" || { echo "::error::no .app at $app" >&2; exit 1; }
dmg="$bundle/dmg/Coffee CLI_${version}_${dmg_arch}.dmg"
scratch=$(mktemp -d)
mount="$scratch/mount"
mounted=false
cleanup() {
  if [ "$mounted" = true ]; then hdiutil detach "$mount" -quiet || hdiutil detach "$mount" -force -quiet || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT

# A Developer ID Application certificate issued by Apple — not merely any
# signature that names a team.
DEVELOPER_ID='anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'

verify_app() {
  local app=$1 exe
  exe="$app/Contents/MacOS/$(plutil -extract CFBundleExecutable raw "$app/Contents/Info.plist")"
  test "$(lipo -archs "$exe")" = "$arch" || { echo "::error::$exe is $(lipo -archs "$exe"), expected $arch" >&2; return 1; }
  test "$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")" = "$version" \
    || { echo "::error::$app is not version $version" >&2; return 1; }
  codesign --verify --deep --strict "$app"
  # Capture first: `codesign | grep -q` dies of SIGPIPE under pipefail.
  local details
  details=$(codesign -dv --verbose=4 "$app" 2>&1)
  if [ "$signed" = true ]; then
    codesign --verify --deep --strict -R="$DEVELOPER_ID" "$app"
    grep -qE 'flags=.*runtime' <<<"$details" \
      || { echo "::error::$app lacks hardened runtime" >&2; return 1; }
  else
    if grep -qE 'flags=.*runtime' <<<"$details"; then
      echo "::error::ad-hoc $app still claims hardened runtime" >&2; return 1
    fi
    if grep -q 'Sealed Resources=none' <<<"$details"; then
      echo "::error::$app has no sealed resources" >&2; return 1
    fi
  fi
}

# Apple's notary and CloudKit (stapler) services drop requests now and then;
# both are retried. A rejected submission or rejected credentials are not:
# retrying cannot fix them.
# Upload once, then wait on that one submission. A slow Apple queue (a new
# team's first submissions can take hours) is waited out, never re-uploaded:
# re-submitting only queues a duplicate behind the first.
notarize() {
  local file=$1 attempt out id="" status
  local auth=()
  if [ -n "${NOTARY_KEY_ID:-}" ]; then
    auth=(--key "$NOTARY_KEY_PATH" --key-id "$NOTARY_KEY_ID" --issuer "$NOTARY_ISSUER")
  else
    auth=(--apple-id "$NOTARY_APPLE_ID" --password "$NOTARY_PASSWORD" --team-id "$NOTARY_TEAM_ID")
  fi
  for attempt in 1 2 3; do
    echo "uploading $(basename "$file") for notarization (attempt $attempt/3)"
    out=$(xcrun notarytool submit "$file" "${auth[@]}" --output-format json 2>&1) || true
    id=$(plutil -extract id raw - <<<"$out" 2>/dev/null || true)
    [ -n "$id" ] && break
    echo "$out" >&2
    if grep -qiE 'HTTP status code: (401|403)|agreement|unauthorized|invalid credentials' <<<"$out"; then
      echo "::error::Apple rejected the notarization credentials. If it mentions an agreement, the Account Holder must accept it at developer.apple.com." >&2
      return 1
    fi
    [ "$attempt" -lt 3 ] && sleep $((attempt * 60))
  done
  [ -n "$id" ] || return 1
  echo "submission $id"
  for attempt in 1 2 3 4 5 6; do
    out=$(xcrun notarytool wait "$id" "${auth[@]}" --timeout 30m --output-format json 2>&1) || true
    status=$(plutil -extract status raw - <<<"$out" 2>/dev/null || true)
    case "$status" in
      Accepted) echo "$out"; return 0 ;;
      Invalid|Rejected)
        echo "::error::notarization of $(basename "$file") ended '$status'" >&2
        xcrun notarytool log "$id" "${auth[@]}" || true
        return 1 ;;
    esac
    echo "still in Apple's queue after $((attempt * 30)) min: $out"
  done
  echo "::error::submission $id still not processed after 3 hours" >&2
  return 1
}

staple() {
  local attempt
  for attempt in 1 2 3 4 5; do
    xcrun stapler staple "$1" && xcrun stapler validate "$1" && return 0
    echo "stapler failed for $(basename "$1") (attempt $attempt/5)" >&2
    [ "$attempt" -lt 5 ] && sleep $((attempt * 20))
  done
  return 1
}

# ── .app ────────────────────────────────────────────────────────────────
if [ "$signed" = true ]; then
  : "${APPLE_SIGNING_IDENTITY:?missing Developer ID signing identity}"
  if [ -z "${NOTARY_KEY_ID:-}" ] && [ -z "${NOTARY_APPLE_ID:-}" ]; then
    echo "::error::no notarization credentials" >&2; exit 1
  fi
  verify_app "$app"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$scratch/app.zip"
  notarize "$scratch/app.zip"
  staple "$app"
  spctl --assess --type execute --verbose=2 "$app"
else
  codesign --force --deep --sign - "$app"
  verify_app "$app"
fi

# ── DMG ─────────────────────────────────────────────────────────────────
mkdir -p "$(dirname "$dmg")"
rm -f "$dmg"
python3 -m venv "$scratch/venv"
"$scratch/venv/bin/pip" install --quiet --disable-pip-version-check "dmgbuild==1.6.5"
"$scratch/venv/bin/dmgbuild" -s "$root/scripts/dmg-settings.py" \
  -D app="$app" -D root="$root" "Coffee CLI" "$dmg"

if [ "$signed" = true ]; then
  # The DMG needs its own Developer ID signature: a notarized but unsigned
  # DMG still fails Gatekeeper's open check once a browser quarantines it.
  codesign --force --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$dmg"
  codesign --verify -R="$DEVELOPER_ID" "$dmg"
  notarize "$dmg"
  staple "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
fi

# ── What users will actually get ────────────────────────────────────────
mkdir -p "$mount"
hdiutil attach "$dmg" -readonly -nobrowse -noautoopen -mountpoint "$mount" >/dev/null
mounted=true
test "$(readlink "$mount/Applications")" = /Applications
test -s "$mount/.DS_Store"
test -s "$mount/.background.tiff"  # dmgbuild merges background.png + @2x here
verify_app "$mount/Coffee CLI.app"
if [ "$signed" = true ]; then
  xcrun stapler validate "$mount/Coffee CLI.app"
  spctl --assess --type execute "$mount/Coffee CLI.app"
fi
echo "ready: $dmg"
