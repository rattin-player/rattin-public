#!/usr/bin/env bash
set -euo pipefail

cd /opt/rattin

echo "Building frontend..."
npm run build

echo "Restarting service..."
sudo systemctl restart rattin

echo "Server deployed."
echo ""
echo "To release a new native AppImage, run from a machine with Qt6/cmake/libmpv:"
echo "  ./install/build-appimage.sh"
echo "  ./install/release-appimage.sh"
