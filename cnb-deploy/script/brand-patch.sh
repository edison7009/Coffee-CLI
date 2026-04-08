#!/bin/bash
# Coffee Code Brand Patch Script
# Run after each upstream merge to reapply branding
# Usage: bash script/brand-patch.sh

set -e

echo "=== Coffee Code Brand Patch ==="
echo ""

# 1. Package name: opencode → coffee-code
echo "[1/6] Patching package name..."
sed -i 's/"name": "opencode"/"name": "coffee-code"/g' packages/opencode/package.json 2>/dev/null || true

# 2. Binary name: opencode → coffeecode (in package.json bin field)
echo "[2/6] Patching binary entry..."
# Note: bin field uses "coffeecode" (no hyphen) for filesystem compatibility
sed -i 's/"opencode": ".\/bin\/opencode"/"coffeecode": ".\/bin\/coffeecode"/g' packages/opencode/package.json 2>/dev/null || true

# 3. CLI script name
echo "[3/6] Patching CLI script name..."
if [ -f packages/opencode/bin/opencode ]; then
  mv packages/opencode/bin/opencode packages/opencode/bin/coffeecode 2>/dev/null || true
fi

# 4. Config directory: .opencode → .coffee-code
echo "[4/6] Patching config directory..."
find packages/opencode/src -name "*.ts" -exec sed -i 's/\.opencode/\.coffee-code/g' {} + 2>/dev/null || true

# 5. Internal references: opencode → coffeecode (env vars, process names)
echo "[5/6] Patching internal references..."
find packages/opencode/src -name "*.ts" -exec sed -i 's/OPENCODE_/COFFEECODE_/g' {} + 2>/dev/null || true
find packages/opencode/src -name "*.ts" -exec sed -i "s/process.env.OPENCODE/process.env.COFFEECODE/g" {} + 2>/dev/null || true

# 6. SDK package names
echo "[6/6] Patching SDK references..."
find packages -name "package.json" -exec sed -i 's/@opencode-ai/@coffeecode-ai/g' {} + 2>/dev/null || true
find packages -name "*.ts" -exec sed -i 's/@opencode-ai/@coffeecode-ai/g' {} + 2>/dev/null || true
find sdks -name "package.json" -exec sed -i 's/@opencode-ai/@coffeecode-ai/g' {} + 2>/dev/null || true
find sdks -name "*.ts" -exec sed -i 's/@opencode-ai/@coffeecode-ai/g' {} + 2>/dev/null || true

echo ""
echo "=== Brand patch complete ==="
echo "Changes applied:"
echo "  - Package name: coffee-code"
echo "  - Binary: coffeecode"
echo "  - Config dir: .coffee-code"
echo "  - Env prefix: COFFEECODE_"
echo "  - SDK scope: @coffeecode-ai"
echo ""
echo "Remember to run 'bun install' after patching."
