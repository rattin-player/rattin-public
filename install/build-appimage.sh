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
    # Don't produce AppImage yet — we need to strip problematic libs first.
    # Disable strip — linuxdeploy's bundled strip is too old for .relr.dyn sections
    # on newer distros (Arch, Fedora 40+, etc.), causing spurious failures.
    DISABLE_COPYRIGHT_FILES_DEPLOYMENT=1 "$TOOLS_DIR/linuxdeploy" \
        --appdir "$APPDIR" \
        --executable "$APPDIR/usr/bin/rattin-shell" \
        --desktop-file "$APPDIR/rattin.desktop" \
        --icon-file "$APPDIR/rattin.svg" \
        --custom-apprun "$REPO_ROOT/install/AppRun" \
        --plugin qt \
        || true

    # Strip with system strip (handles modern ELF sections)
    log "Stripping libraries with system strip..."
    find "$APPDIR" -type f \( -name '*.so' -o -name '*.so.*' \) -exec strip --strip-unneeded {} \; 2>/dev/null || true

    # Bundle Wayland platform plugins — linuxdeploy only bundles xcb by default.
    # Without these, Qt falls back to X11/XWayland on Wayland sessions, causing
    # coordinate mismatches between rendered UI and click targets.
    log "Bundling Wayland platform plugins..."
    local qt_plugin_dir
    qt_plugin_dir="$($QMAKE -query QT_INSTALL_PLUGINS 2>/dev/null || echo "")"
    if [ -n "$qt_plugin_dir" ]; then
        for wl_plugin in "$qt_plugin_dir"/platforms/libqwayland*.so; do
            [ -f "$wl_plugin" ] && cp "$wl_plugin" "$APPDIR/usr/plugins/platforms/" 2>/dev/null || true
        done
        # Wayland shell integration plugins
        if [ -d "$qt_plugin_dir/wayland-shell-integration" ]; then
            cp -r "$qt_plugin_dir/wayland-shell-integration" "$APPDIR/usr/plugins/"
        fi
        # Wayland graphics integration
        if [ -d "$qt_plugin_dir/wayland-graphics-integration-client" ]; then
            cp -r "$qt_plugin_dir/wayland-graphics-integration-client" "$APPDIR/usr/plugins/"
        fi
        # Wayland decoration plugins
        if [ -d "$qt_plugin_dir/wayland-decoration-client" ]; then
            cp -r "$qt_plugin_dir/wayland-decoration-client" "$APPDIR/usr/plugins/"
        fi
    fi

    # Remove NSS/NSPR libs — they MUST come from the host system.
    # Bundling them causes version mismatches with the system's crypto stack
    # (e.g. libnssutil3.so vs libsoftokn3.so) which crashes QtWebEngine.
    log "Removing system-coupled libraries..."
    rm -f "$APPDIR"/usr/lib/libnss3.so*
    rm -f "$APPDIR"/usr/lib/libnssutil3.so*
    rm -f "$APPDIR"/usr/lib/libnspr4.so*
    rm -f "$APPDIR"/usr/lib/libplc4.so*
    rm -f "$APPDIR"/usr/lib/libplds4.so*
    rm -f "$APPDIR"/usr/lib/libsmime3.so*
    rm -f "$APPDIR"/usr/lib/libssl3.so*

    # Now produce the AppImage
    log "Packaging AppImage..."

    # Download appimagetool if needed
    if [ ! -x "$TOOLS_DIR/appimagetool" ]; then
        log "Downloading appimagetool..."
        curl -fSL "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage" \
            -o "$TOOLS_DIR/appimagetool"
        chmod +x "$TOOLS_DIR/appimagetool"
    fi

    "$TOOLS_DIR/appimagetool" "$APPDIR" "$OUTPUT"

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

    # Check build prerequisites
    command -v cmake >/dev/null 2>&1 || die "cmake not found. Install: sudo apt install cmake"
    command -v g++ >/dev/null 2>&1   || die "g++ not found. Install: sudo apt install g++"
    command -v npm >/dev/null 2>&1   || die "npm not found. Install Node.js 20+"
    local qml_dir
    qml_dir="$(qmake6 -query QT_INSTALL_QML 2>/dev/null || true)"
    if [ -z "$qml_dir" ] || [ ! -d "$qml_dir/QtWebEngine" ]; then
        die "Qt6 QML modules not found. Install:
  sudo apt install qt6-base-dev qt6-webengine-dev qt6-declarative-dev qt6-webchannel-dev \\
    libmpv-dev g++ qml6-module-qtwebengine qml6-module-qtwebengine-controlsdelegates \\
    qml6-module-qtquick qml6-module-qtquick-window qml6-module-qtquick-layouts \\
    qml6-module-qtquick-controls qml6-module-qtquick-templates qml6-module-qtwebchannel \\
    qml6-module-qtqml qml6-module-qtqml-models qml6-module-qtqml-workerscript \\
    qml6-module-qtcore"
    fi

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
