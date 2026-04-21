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

    # Node.js standalone (with checksum verification)
    if [ ! -x "$TOOLS_DIR/node/bin/node" ]; then
        log "Downloading Node.js v${NODE_VERSION}..."
        curl -fSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
            -o "$TOOLS_DIR/node.tar.xz"
        curl -fSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
            -o "$TOOLS_DIR/node.shasums"
        local expected_hash
        expected_hash="$(grep "node-v${NODE_VERSION}-linux-x64.tar.xz" "$TOOLS_DIR/node.shasums" | awk '{print $1}')"
        local actual_hash
        actual_hash="$(sha256sum "$TOOLS_DIR/node.tar.xz" | awk '{print $1}')"
        if [ "$expected_hash" != "$actual_hash" ]; then
            rm -f "$TOOLS_DIR/node.tar.xz" "$TOOLS_DIR/node.shasums"
            die "Node.js checksum mismatch! Expected: $expected_hash Got: $actual_hash"
        fi
        rm -f "$TOOLS_DIR/node.shasums"
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

    # Bundle server into single JS file
    local app_dest="$APPDIR/usr/share/rattin/app"
    log "Bundling server with esbuild..."
    cd "$REPO_ROOT"
    npx esbuild server.ts --bundle --platform=node --format=esm \
        --outfile="$app_dest/server.js" \
        --external:utp-native --external:node-datachannel \
        --external:bufferutil --external:utf-8-validate \
        --target=node20 \
        "--banner:js=import{createRequire}from'module';const require=createRequire(import.meta.url);" \
        2>&1 | tail -5

    # App assets
    cp -r "$REPO_ROOT/public" "$app_dest/"
    cp "$REPO_ROOT/package.json" "$app_dest/"
    cp "$REPO_ROOT/package-lock.json" "$app_dest/"
    cp "$REPO_ROOT/.env.example" "$app_dest/"

    # Production node_modules — only needed for native addons now.
    # Use bundled node+npm so native addons compile against the same
    # Node.js version that ships in the AppImage.
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
    # NOTE: linuxdeploy may exit non-zero even on partial success (known quirk),
    # so we capture the exit code and warn rather than abort. The verify_appdir()
    # step below will catch any real missing-library consequences.
    local ld_exit=0
    DISABLE_COPYRIGHT_FILES_DEPLOYMENT=1 "$TOOLS_DIR/linuxdeploy" \
        --appdir "$APPDIR" \
        --executable "$APPDIR/usr/bin/rattin-shell" \
        --desktop-file "$APPDIR/rattin.desktop" \
        --icon-file "$APPDIR/rattin.svg" \
        --custom-apprun "$REPO_ROOT/install/AppRun" \
        --plugin qt \
        || ld_exit=$?
    if [ "$ld_exit" -ne 0 ]; then
        warn "linuxdeploy exited with code $ld_exit — verify_appdir will check for consequences"
    fi

    # linuxdeploy --custom-apprun is unreliable — copy manually
    cp "$REPO_ROOT/install/AppRun" "$APPDIR/AppRun"
    chmod +x "$APPDIR/AppRun"

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

    # Force-bundle libjack: libmpv & libavdevice were linked with -ljack on the
    # Ubuntu build host (GCC default, no --as-needed), so the bundled .so's
    # have NEEDED libjack.so.0. linuxdeploy's continuous channel enforces the
    # AppImage canonical excludelist which drops libjack (even when passed
    # via --library, silently). Result without this step: load-time crash on
    # every user distro without libjack-jackd2-0 installed (the v2.7.8
    # regression). Manual cp -a preserves the SONAME symlink chain.
    log "Force-bundling libjack (linuxdeploy excludelist drops it)..."
    local libjack_src
    libjack_src="$(readlink -f /usr/lib/x86_64-linux-gnu/libjack.so.0 2>/dev/null \
        || find /usr/lib -name 'libjack.so.0*' -type f 2>/dev/null | head -n1)"
    if [ -z "$libjack_src" ] || [ ! -f "$libjack_src" ]; then
        die "libjack.so.0 not found on build host — install libjack-jackd2-0"
    fi
    # shellcheck disable=SC2086
    cp -a /usr/lib/x86_64-linux-gnu/libjack.so.0* "$APPDIR/usr/lib/"

    # ── Verify AppDir before packaging ─────────────────────────────────────
    verify_appdir

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
# NEEDED-lib audit — every bundled binary/.so must have every NEEDED
# library either bundled in $APPDIR/usr/lib or listed in the allowlist.
# Catches the "host has dev dep installed, clean target does not" class
# of release breakage (e.g. libjack on build host but not on user box).
# ---------------------------------------------------------------------------
ldd_audit() {
    log "Auditing NEEDED libraries of bundled binaries and shared objects..."

    # readelf legitimately returns non-zero on non-ELF files (scripts, data
    # files that may live alongside binaries); under the script's global
    # `set -euo pipefail`, that would abort the audit silently before any
    # [ERROR] line prints. Disable errexit/pipefail locally and manage
    # failures explicitly via the $errors counter + die() at the end.
    set +e
    set +o pipefail

    local allowlist_file="$REPO_ROOT/install/ldd-allowlist.txt"
    if [ ! -f "$allowlist_file" ]; then
        die "ldd_audit: missing allowlist at $allowlist_file"
    fi
    command -v readelf >/dev/null 2>&1 || die "ldd_audit: readelf not found (install binutils)"

    # Allowlist: strip blank lines and comments, trim trailing whitespace.
    local allowlist
    allowlist="$(grep -Ev '^[[:space:]]*($|#)' "$allowlist_file" | sed 's/[[:space:]]*$//')"

    # Every .so* bundled under $APPDIR/usr/lib (recursive). Match by basename.
    # Include symlinks — linuxdeploy typically bundles a real file plus versioned
    # SONAME symlinks (e.g. real libjack.so.0.1.0 + symlink libjack.so.0). NEEDED
    # entries reference the SONAME, so the symlink name must be in the bundled set.
    local bundled
    bundled="$(find "$APPDIR/usr/lib" \( -type f -o -type l \) \
                \( -name '*.so' -o -name '*.so.*' \) \
                -printf '%f\n' 2>/dev/null | sort -u)"

    # Audit target set: executables in usr/bin + shared objects in usr/lib.
    local targets
    targets="$(
        find "$APPDIR/usr/bin" -maxdepth 1 -type f 2>/dev/null
        find "$APPDIR/usr/lib" -type f \( -name '*.so' -o -name '*.so.*' \) 2>/dev/null
    )"

    local errors=0
    while IFS= read -r file; do
        [ -z "$file" ] && continue

        local needed
        needed="$(readelf -d "$file" 2>/dev/null \
                    | awk '/\(NEEDED\)/ { gsub(/[][]/, "", $NF); print $NF }')"
        [ -z "$needed" ] && continue

        while IFS= read -r lib; do
            [ -z "$lib" ] && continue

            # libfoo.so.3.1.4 -> libfoo.so   (allowlist matches name-only)
            local name
            name="$(printf '%s' "$lib" | sed -E 's/(\.so)\..*/\1/')"

            # Exact bundled basename match? (e.g. NEEDED libjack.so.0 satisfied
            # by $APPDIR/usr/lib/libjack.so.0 being present.)
            if printf '%s\n' "$bundled" | grep -Fxq -- "$lib"; then
                continue
            fi

            # Host-provides allowlist match (version-stripped)?
            if printf '%s\n' "$allowlist" | grep -Fxq -- "$name"; then
                continue
            fi

            err "$file NEEDS $lib — not bundled in \$APPDIR/usr/lib and not on install/ldd-allowlist.txt"
            err "  fix: bundle the lib, remove the dep, or (if truly host-provided) add '$name' to install/ldd-allowlist.txt"
            errors=$((errors + 1))
        done <<< "$needed"
    done <<< "$targets"

    if [ "$errors" -gt 0 ]; then
        die "ldd_audit: $errors unbundled/unallowlisted NEEDED entry/entries"
    fi

    # Restore strictness for callers.
    set -e
    set -o pipefail

    log "ldd_audit passed"
}

# ---------------------------------------------------------------------------
# Verify AppDir — catch missing plugins/libs before packaging
# ---------------------------------------------------------------------------
verify_appdir() {
    log "Verifying AppDir contents..."
    local errors=0

    # Platform plugins (at least xcb is required; wayland for modern desktops)
    for plugin in libqxcb.so; do
        if [ ! -f "$APPDIR/usr/plugins/platforms/$plugin" ]; then
            err "Missing required platform plugin: $plugin"
            ((errors++))
        fi
    done
    # Wayland is non-fatal but warn loudly
    if ! ls "$APPDIR"/usr/plugins/platforms/libqwayland*.so >/dev/null 2>&1; then
        warn "No Wayland platform plugins found — Wayland-only desktops will fall back to XWayland"
    fi

    # Qt libraries
    for lib in libQt6Core.so.6 libQt6Gui.so.6 libQt6Quick.so.6 \
               libQt6WebEngineCore.so.6 libQt6Network.so.6 libQt6WebChannel.so.6; do
        if ! ls "$APPDIR/usr/lib/$lib"* >/dev/null 2>&1; then
            err "Missing Qt library: $lib"
            ((errors++))
        fi
    done

    # QtWebEngineProcess — Chromium subprocess, required for web views
    if [ ! -f "$APPDIR/usr/libexec/QtWebEngineProcess" ]; then
        err "Missing QtWebEngineProcess (Chromium subprocess)"
        ((errors++))
    fi

    # QML modules
    for mod in QtWebEngine QtQuick; do
        if [ ! -d "$APPDIR/usr/qml/$mod" ]; then
            err "Missing QML module: $mod"
            ((errors++))
        fi
    done

    # Binaries
    for bin in rattin-shell ffmpeg ffprobe; do
        if [ ! -x "$APPDIR/usr/bin/$bin" ]; then
            err "Missing binary: $bin"
            ((errors++))
        fi
    done

    # Node.js runtime
    local node_bin="$APPDIR/usr/share/rattin/node/bin/node"
    if [ ! -x "$node_bin" ]; then
        err "Missing Node.js runtime"
        ((errors++))
    fi

    # Server bundle — must exist, be non-trivial, and parse without errors
    local server_js="$APPDIR/usr/share/rattin/app/server.js"
    if [ ! -f "$server_js" ]; then
        err "Missing server.js bundle"
        ((errors++))
    else
        local server_size
        server_size="$(stat -c%s "$server_js")"
        if [ "$server_size" -lt 10000 ]; then
            err "server.js bundle suspiciously small (${server_size} bytes) — esbuild likely failed"
            ((errors++))
        fi
        if [ -x "$node_bin" ]; then
            if ! "$node_bin" --check "$server_js" 2>/dev/null; then
                err "server.js bundle has syntax errors"
                ((errors++))
            fi
        fi
    fi

    # Frontend assets — index.html plus at least one JS and CSS file
    local public_dir="$APPDIR/usr/share/rattin/app/public"
    if [ ! -f "$public_dir/index.html" ]; then
        err "Missing frontend: public/index.html"
        ((errors++))
    fi
    if ! ls "$public_dir"/assets/*.js >/dev/null 2>&1; then
        err "Missing frontend JS assets in public/assets/"
        ((errors++))
    fi
    if ! ls "$public_dir"/assets/*.css >/dev/null 2>&1; then
        err "Missing frontend CSS assets in public/assets/"
        ((errors++))
    fi

    # .env.example — required for first-run config creation
    if [ ! -f "$APPDIR/usr/share/rattin/app/.env.example" ]; then
        err "Missing .env.example"
        ((errors++))
    fi

    # AppRun — entry point must be present and executable
    if [ ! -x "$APPDIR/AppRun" ]; then
        err "Missing or non-executable AppRun"
        ((errors++))
    fi

    # node_modules — native addons directory must exist
    if [ ! -d "$APPDIR/usr/share/rattin/app/node_modules" ]; then
        err "Missing node_modules (npm ci --omit=dev likely failed)"
        ((errors++))
    fi

    # GLIBC version check — ensure all bundled libs work on target distros
    local max_glibc_target="2.35"
    local max_glibc
    max_glibc=$(find "$APPDIR" -type f \( -name '*.so' -o -name '*.so.*' \) \
        -exec readelf -V {} \; 2>/dev/null \
        | grep -oP 'GLIBC_\K[0-9.]+' | sort -V -u | tail -1)
    if [ -n "$max_glibc" ]; then
        # Check if max_glibc > max_glibc_target
        local highest
        highest="$(printf '%s\n%s' "$max_glibc" "$max_glibc_target" | sort -V | tail -1)"
        if [ "$highest" != "$max_glibc_target" ]; then
            err "Bundled libraries require GLIBC $max_glibc (target: ≤$max_glibc_target)"
            err "Offending libraries:"
            find "$APPDIR" -type f \( -name '*.so' -o -name '*.so.*' \) -exec sh -c '
                readelf -V "$1" 2>/dev/null | grep -q "GLIBC_'"$max_glibc"'" && printf "  → %s\n" "$1"
            ' _ {} \;
            ((errors++))
        else
            log "GLIBC check passed (max: ${max_glibc}, target: ≤${max_glibc_target})"
        fi
    fi

    if [ "$errors" -gt 0 ]; then
        die "AppDir verification failed with $errors error(s) — refusing to package broken AppImage"
    fi

    ldd_audit

    log "AppDir verification passed"
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
    qml6-module-qtcore qml6-module-qtquick-dialogs qml6-module-qt-labs-folderlistmodel"
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
