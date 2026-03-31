#!/usr/bin/env bash
set -euo pipefail

cd /opt/rattin

echo "Building frontend..."
npm run build

echo "Restarting service..."
sudo systemctl restart rattin

echo "Building native tarball..."
./install/build-native-tarball.sh

echo "Uploading tarball..."
gh release upload v1.0.0-native native-app.tar.gz --repo rattin-player/rattin-public --clobber

echo "Done."
