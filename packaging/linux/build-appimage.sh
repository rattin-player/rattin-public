#!/bin/bash
set -euo pipefail

# Build the Qt shell
echo "Building Qt shell..."
cd shell
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr
make -j$(nproc)
cd ../..

# Build the React frontend
echo "Building frontend..."
npm run build

# Assemble AppDir
echo "Assembling AppDir..."
APPDIR="$(pwd)/Rattin.AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin"
mkdir -p "$APPDIR/usr/share/applications"
mkdir -p "$APPDIR/usr/share/rattin"

# Copy shell binary
cp shell/build/rattin-shell "$APPDIR/usr/bin/"

# Copy app files (server, routes, lib, public, node_modules, package.json)
for item in server.ts routes lib public node_modules package.json package-lock.json .env.example; do
    if [ -e "$item" ]; then
        cp -r "$item" "$APPDIR/usr/share/rattin/"
    fi
done

# Copy desktop file
cp packaging/linux/rattin.desktop "$APPDIR/"

# Create AppRun
cat > "$APPDIR/AppRun" << 'APPRUN'
#!/bin/bash
SELF="$(readlink -f "$0")"
HERE="${SELF%/*}"
export PATH="${HERE}/usr/bin:${PATH}"
export LD_LIBRARY_PATH="${HERE}/usr/lib:${LD_LIBRARY_PATH:-}"
cd "${HERE}/usr/share/rattin"
exec "${HERE}/usr/bin/rattin-shell" "$@"
APPRUN
chmod +x "$APPDIR/AppRun"

echo "AppDir ready at: $APPDIR"
echo "To create AppImage, run: appimagetool $APPDIR"
