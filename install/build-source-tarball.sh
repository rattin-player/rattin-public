#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Build native-app.tar.gz for upload to rattin-player/rattin-public releases
# Run this from the repo root after `npm run build` (frontend must be built)
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$REPO_ROOT/native-app.tar.gz"

cd "$REPO_ROOT"

# Verify frontend is built
if [ ! -d "public" ] || [ ! -f "public/index.html" ]; then
    echo "Frontend not built. Running npm run build..."
    npm run build
fi

echo "Creating native-app.tar.gz..."

# Package everything the native installer needs:
# - server.ts, routes/, lib/ (backend)
# - public/ (pre-built frontend)
# - shell/ (Qt source to compile locally)
# - package.json + package-lock.json (for npm install)
# - install/ (in case user wants the installer locally)
# - .env.example
tar -czf "$OUT" \
    --exclude='shell/build' \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.claude' \
    --exclude='test' \
    --exclude='docs' \
    --exclude='deploy' \
    --exclude='packaging' \
    server.ts \
    routes/ \
    lib/ \
    src/ \
    public/ \
    shell/ \
    install/ \
    package.json \
    package-lock.json \
    tsconfig.json \
    tsconfig.frontend.json \
    vite.config.ts \
    index.html \
    .env.example

SIZE=$(du -h "$OUT" | cut -f1)
echo "Done: $OUT ($SIZE)"
echo ""
echo "Upload to: https://github.com/rattin-player/rattin-public/releases"
echo "  gh release create v1.0.0-native --repo rattin-player/rattin-public native-app.tar.gz"
