#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Build Rattin AppImage
#
# Idempotent — skips steps that are already done. Use --clean to rebuild all.
# Prerequisites: Qt6 dev packages, libmpv-dev, cmake, make, Node.js 20+, npm
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$REPO_ROOT/build-appimage"
APPDIR="$BUILD_DIR/AppDir"
TOOLS_DIR="$BUILD_DIR/tools"
NODE_VERSION="20.18.1"
ARCH="x86_64"
APP_NAME="Rattin"
OUTPUT="$REPO_ROOT/${APP_NAME}-${ARCH}.AppImage"

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
    CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; NC=''
fi

log()  { printf "${GREEN}[INFO]${NC}  %s\n" "$*"; }
warn() { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
err()  { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; }
die()  { err "$*"; exit 1; }
skip() { printf "${CYAN}[SKIP]${NC}  %s\n" "$*"; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
CLEAN=false
while [ $# -gt 0 ]; do
    case "$1" in
        --clean)  CLEAN=true; shift ;;
        --help|-h)
            echo "Usage: build-appimage.sh [--clean] [--help]"
            echo ""
            echo "Build Rattin as an AppImage."
            echo ""
            echo "  --clean    Wipe build directory and rebuild everything"
            echo "  --help     Show this help"
            exit 0
            ;;
        *) die "Unknown argument: $1" ;;
    esac
done

if [ "$CLEAN" = true ]; then
    log "Cleaning build directory..."
    rm -rf "$BUILD_DIR"
fi

mkdir -p "$BUILD_DIR" "$TOOLS_DIR"

# ---------------------------------------------------------------------------
# Step A: Download tools (cached)
# ---------------------------------------------------------------------------
download_tools() {
    log "Checking build tools..."

    # linuxdeploy
    if [ ! -x "$TOOLS_DIR/linuxdeploy" ]; then
        log "Downloading linuxdeploy..."
        curl -fSL "https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage" \
            -o "$TOOLS_DIR/linuxdeploy"
        chmod +x "$TOOLS_DIR/linuxdeploy"
    else
        skip "linuxdeploy already downloaded"
    fi

    # linuxdeploy Qt plugin
    if [ ! -x "$TOOLS_DIR/linuxdeploy-plugin-qt" ]; then
        log "Downloading linuxdeploy-plugin-qt..."
        curl -fSL "https://github.com/linuxdeploy/linuxdeploy-plugin-qt/releases/download/continuous/linuxdeploy-plugin-qt-x86_64.AppImage" \
            -o "$TOOLS_DIR/linuxdeploy-plugin-qt"
        chmod +x "$TOOLS_DIR/linuxdeploy-plugin-qt"
    else
        skip "linuxdeploy-plugin-qt already downloaded"
    fi

    # Node.js standalone
    if [ ! -x "$TOOLS_DIR/node/bin/node" ]; then
        log "Downloading Node.js v${NODE_VERSION}..."
        curl -fSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
            -o "$TOOLS_DIR/node.tar.xz"
        mkdir -p "$TOOLS_DIR/node"
        tar -xf "$TOOLS_DIR/node.tar.xz" -C "$TOOLS_DIR/node" --strip-components=1
        rm -f "$TOOLS_DIR/node.tar.xz"
    else
        skip "Node.js already downloaded"
    fi

    # Static ffmpeg + ffprobe
    if [ ! -x "$TOOLS_DIR/ffmpeg" ]; then
        log "Downloading static ffmpeg..."
        curl -fSL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" \
            -o "$TOOLS_DIR/ffmpeg.tar.xz"
        # Extract only ffmpeg and ffprobe binaries
        tar -xf "$TOOLS_DIR/ffmpeg.tar.xz" -C "$TOOLS_DIR/" --strip-components=1 \
            --wildcards "*/ffmpeg" "*/ffprobe"
        rm -f "$TOOLS_DIR/ffmpeg.tar.xz"
    else
        skip "ffmpeg already downloaded"
    fi

    log "All tools ready"
}

# ---------------------------------------------------------------------------
# Step B: Build frontend
# ---------------------------------------------------------------------------
build_frontend() {
    cd "$REPO_ROOT"

    # Skip if public/index.html exists and is newer than all src/ files
    if [ -f "public/index.html" ]; then
        local newest_src
        newest_src="$(find src/ -type f -newer public/index.html 2>/dev/null | head -1)"
        if [ -z "$newest_src" ]; then
            skip "Frontend already built (public/ is current)"
            return
        fi
    fi

    log "Installing npm dependencies..."
    npm install 2>&1 | tail -3

    log "Building frontend..."
    npm run build 2>&1 | tail -3
}

# ---------------------------------------------------------------------------
# Step C: Build Qt shell
# ---------------------------------------------------------------------------
build_shell() {
    cd "$REPO_ROOT/shell"

    # Skip if binary exists and is newer than all source files
    if [ -f "build/rattin-shell" ]; then
        local newest_src
        newest_src="$(find . -maxdepth 1 \( -name '*.cpp' -o -name '*.h' -o -name '*.qml' -o -name '*.qrc' -o -name 'CMakeLists.txt' \) -newer build/rattin-shell 2>/dev/null | head -1)"
        if [ -z "$newest_src" ]; then
            skip "Qt shell already built (binary is current)"
            return
        fi
    fi

    log "Building Qt6 shell..."
    mkdir -p build && cd build
    cmake .. -DCMAKE_BUILD_TYPE=Release 2>&1 | tail -5
    make -j"$(nproc)" 2>&1 | tail -5
    cd "$REPO_ROOT"

    log "Qt shell built"
}

# ---------------------------------------------------------------------------
# Step D: Assemble AppDir
# ---------------------------------------------------------------------------
assemble_appdir() {
    log "Assembling AppDir..."

    # Always start fresh to avoid stale files
    rm -rf "$APPDIR"

    mkdir -p "$APPDIR/usr/bin"
    mkdir -p "$APPDIR/usr/share/rattin/app"
    mkdir -p "$APPDIR/usr/share/rattin/node"
    mkdir -p "$APPDIR/usr/share/applications"
    mkdir -p "$APPDIR/usr/share/icons/hicolor/scalable/apps"

    # Qt shell binary
    cp "$REPO_ROOT/shell/build/rattin-shell" "$APPDIR/usr/bin/"

    # ffmpeg + ffprobe
    cp "$TOOLS_DIR/ffmpeg" "$TOOLS_DIR/ffprobe" "$APPDIR/usr/bin/"

    # Node.js runtime (only bin/node — not the full distribution)
    mkdir -p "$APPDIR/usr/share/rattin/node/bin"
    cp "$TOOLS_DIR/node/bin/node" "$APPDIR/usr/share/rattin/node/bin/"

    # App code
    local app_dest="$APPDIR/usr/share/rattin/app"
    cp "$REPO_ROOT/server.ts" "$app_dest/"
    cp -r "$REPO_ROOT/routes" "$app_dest/"
    cp -r "$REPO_ROOT/lib" "$app_dest/"
    cp -r "$REPO_ROOT/public" "$app_dest/"
    cp "$REPO_ROOT/package.json" "$app_dest/"
    cp "$REPO_ROOT/package-lock.json" "$app_dest/"
    cp "$REPO_ROOT/tsconfig.json" "$app_dest/"
    cp "$REPO_ROOT/.env.example" "$app_dest/"

    # Production node_modules — use bundled node+npm so native addons
    # compile against the same Node.js version that ships in the AppImage
    log "Installing production dependencies..."
    cd "$app_dest"
    local bundled_node="$APPDIR/usr/share/rattin/node/bin/node"
    local bundled_npm="$TOOLS_DIR/node/lib/node_modules/npm/bin/npm-cli.js"
    "$bundled_node" "$bundled_npm" ci --omit=dev 2>&1 | tail -5
    cd "$REPO_ROOT"

    # Desktop file + icon
    cp "$REPO_ROOT/packaging/linux/rattin.desktop" "$APPDIR/usr/share/applications/"
    cp "$REPO_ROOT/packaging/linux/rattin.svg" "$APPDIR/usr/share/icons/hicolor/scalable/apps/"

    # Desktop file + icon at AppDir root (linuxdeploy expects them here)
    cp "$REPO_ROOT/packaging/linux/rattin.desktop" "$APPDIR/"
    cp "$REPO_ROOT/packaging/linux/rattin.svg" "$APPDIR/"

    # NOTE: AppRun is NOT placed here — linuxdeploy handles it via --custom-apprun
    # to avoid a self-copy conflict during its deploy step.

    log "AppDir assembled"
}

# ---------------------------------------------------------------------------
# Step E: Bundle libraries + produce AppImage
# ---------------------------------------------------------------------------
build_appimage() {
    log "Bundling libraries with linuxdeploy..."

    cd "$BUILD_DIR"

    # linuxdeploy-plugin-qt needs QMAKE to find Qt's install prefix
    export QMAKE="$(command -v qmake6 2>/dev/null || command -v qmake 2>/dev/null || true)"
    if [ -z "$QMAKE" ]; then
        die "qmake6 or qmake not found. Install Qt6 development packages."
    fi

    # Tell the Qt plugin where to look for QML imports
    export QML_SOURCES_PATHS="$REPO_ROOT/shell"

    # Prevent linuxdeploy AppImage from needing FUSE
    export APPIMAGE_EXTRACT_AND_RUN=1

    # Run linuxdeploy — bundles shared libs (Qt6, libmpv, codecs),
    # Qt plugins, QML imports, and WebEngine resources.
    "$TOOLS_DIR/linuxdeploy" \
        --appdir "$APPDIR" \
        --executable "$APPDIR/usr/bin/rattin-shell" \
        --desktop-file "$APPDIR/rattin.desktop" \
        --icon-file "$APPDIR/rattin.svg" \
        --custom-apprun "$REPO_ROOT/install/AppRun" \
        --plugin qt \
        --output appimage

    # linuxdeploy names the output based on the desktop file
    # Move it to our expected location
    local generated
    generated="$(ls -1 Rattin*.AppImage 2>/dev/null | head -1)"
    if [ -z "$generated" ]; then
        # Try alternative naming
        generated="$(ls -1 *.AppImage 2>/dev/null | head -1)"
    fi

    if [ -n "$generated" ] && [ "$generated" != "$(basename "$OUTPUT")" ]; then
        mv "$generated" "$OUTPUT"
    elif [ -n "$generated" ]; then
        mv "$generated" "$OUTPUT"
    else
        die "AppImage was not generated. Check linuxdeploy output above."
    fi

    local size
    size="$(du -h "$OUTPUT" | cut -f1)"
    log "AppImage ready: $OUTPUT ($size)"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    echo ""
    printf "${BOLD}Rattin — AppImage Builder${NC}\n"
    echo ""

    # Verify we're in the repo root
    [ -f "$REPO_ROOT/server.ts" ] || die "Run from the repository root"
    [ -f "$REPO_ROOT/shell/CMakeLists.txt" ] || die "Qt shell source not found"

    download_tools
    build_frontend
    build_shell
    assemble_appdir
    build_appimage

    echo ""
    printf "${BOLD}========================================${NC}\n"
    printf "${GREEN}  AppImage built successfully!${NC}\n"
    printf "${BOLD}========================================${NC}\n"
    echo ""
    echo "  Output: $OUTPUT"
    echo ""
    echo "  Test it:  chmod +x $(basename "$OUTPUT") && ./$(basename "$OUTPUT")"
    echo "  Deploy:   gh release upload v1.0.0-native $(basename "$OUTPUT") --repo rattin-player/rattin-public --clobber"
    echo ""
}

main
