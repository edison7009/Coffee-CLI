#!/usr/bin/env bash
#
# build-free-code.sh — Clone and build the free-code sidecar binary
#
# Usage:
#   ./scripts/build-free-code.sh [--target linux|macos|windows]
#
# Prerequisites:
#   - Bun >= 1.3.11 (https://bun.sh)
#   - Git
#
# Output:
#   Compiled binary placed in ./binaries/free-code[.exe]
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ROOT_DIR/.free-code-build"
BINARIES_DIR="$ROOT_DIR/binaries"

REPO_URL="https://github.com/paoloanzn/free-code.git"
BRANCH="main"

echo "═══════════════════════════════════════════════════════"
echo "  Coffee CLI — Free Code Sidecar Builder"
echo "═══════════════════════════════════════════════════════"

# ── 1. Check prerequisites ──────────────────────────────────

if ! command -v bun &> /dev/null; then
  echo "❌ Bun is not installed. Install it:"
  echo "   curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

BUN_VERSION=$(bun --version 2>/dev/null || echo "0.0.0")
echo "✅ Bun version: $BUN_VERSION"

if ! command -v git &> /dev/null; then
  echo "❌ Git is not installed."
  exit 1
fi

# ── 2. Clone or update free-code ────────────────────────────

if [ -d "$BUILD_DIR" ]; then
  echo "📦 Updating existing free-code checkout..."
  cd "$BUILD_DIR"
  git fetch origin "$BRANCH" --depth=1
  git reset --hard "origin/$BRANCH"
else
  echo "📦 Cloning free-code..."
  git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$BUILD_DIR"
  cd "$BUILD_DIR"
fi

# ── 3. Install dependencies ────────────────────────────────

echo "📥 Installing dependencies..."
bun install

# ── 4. Compile standalone binary ────────────────────────────

echo "🔨 Compiling free-code binary..."
bun run compile

# ── 5. Copy to binaries directory ───────────────────────────

mkdir -p "$BINARIES_DIR"

# Detect OS for correct binary name
case "$(uname -s)" in
  Linux*)   BINARY_NAME="free-code" ;;
  Darwin*)  BINARY_NAME="free-code" ;;
  MINGW*|MSYS*|CYGWIN*) BINARY_NAME="free-code.exe" ;;
  *)        BINARY_NAME="free-code" ;;
esac

if [ -f "$BUILD_DIR/dist/cli" ]; then
  cp "$BUILD_DIR/dist/cli" "$BINARIES_DIR/$BINARY_NAME"
  chmod +x "$BINARIES_DIR/$BINARY_NAME"
elif [ -f "$BUILD_DIR/dist/cli.exe" ]; then
  cp "$BUILD_DIR/dist/cli.exe" "$BINARIES_DIR/$BINARY_NAME"
else
  echo "❌ Compiled binary not found in dist/"
  echo "   Expected: $BUILD_DIR/dist/cli or $BUILD_DIR/dist/cli.exe"
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ Free Code binary ready!"
echo "  📁 $BINARIES_DIR/$BINARY_NAME"
echo "  📏 $(du -h "$BINARIES_DIR/$BINARY_NAME" | cut -f1)"
echo "═══════════════════════════════════════════════════════"
