#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Upload AppImage + sync install script to rattin-player/rattin-public
# Run this after build-appimage.sh produces Rattin-x86_64.AppImage
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APPIMAGE="$REPO_ROOT/Rattin-x86_64.AppImage"

if [ ! -f "$APPIMAGE" ]; then
    echo "AppImage not found at $APPIMAGE"
    echo "Run ./install/build-appimage.sh first."
    exit 1
fi

echo "Uploading AppImage..."
gh release upload v1.0.0-native "$APPIMAGE" \
    --repo rattin-player/rattin-public --clobber

echo "Syncing install script to rattin-player/rattin-public..."
INSTALL_REPO="/tmp/rattin-public-sync"
rm -rf "$INSTALL_REPO"
gh repo clone rattin-player/rattin-public "$INSTALL_REPO" -- --depth 1
cp "$REPO_ROOT/install/install-native.sh" "$INSTALL_REPO/install-native.sh"
cd "$INSTALL_REPO"
if ! git diff --quiet; then
    git config user.email "rattin@noreply.github.com"
    git config user.name "Rattin"
    git add install-native.sh
    git commit -m "sync install script from rattin-player/player"
    git push
fi
rm -rf "$INSTALL_REPO"

echo "Done. Users can now install with:"
echo "  curl -fsSL https://raw.githubusercontent.com/rattin-player/rattin-public/main/install-native.sh | bash"
