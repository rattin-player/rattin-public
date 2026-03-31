#!/usr/bin/env bash
set -euo pipefail

cd /opt/rattin

echo "Building frontend..."
npm run build

echo "Restarting service..."
sudo systemctl restart rattin

echo "Building AppImage..."
./install/build-appimage.sh

echo "Uploading AppImage..."
gh release upload v1.0.0-native Rattin-x86_64.AppImage \
    --repo rattin-player/rattin-public --clobber

echo "Syncing install script to rattin-player/rattin-public..."
INSTALL_REPO="/tmp/rattin-public-sync"
rm -rf "$INSTALL_REPO"
gh repo clone rattin-player/rattin-public "$INSTALL_REPO" -- --depth 1
cp install/install-native.sh "$INSTALL_REPO/install-native.sh"
cd "$INSTALL_REPO"
if ! git diff --quiet; then
    git add install-native.sh
    git commit -m "sync install script from rattin-player/player"
    git push
fi
rm -rf "$INSTALL_REPO"

echo "Done."
