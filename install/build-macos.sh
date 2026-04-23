#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$REPO_ROOT/build-macos"
SHELL_BUILD_DIR="$REPO_ROOT/shell/build-macos"
APP_NAME="Rattin"
APP_BUNDLE="$BUILD_DIR/${APP_NAME}.app"
ZIP_OUTPUT="$REPO_ROOT/${APP_NAME}-macOS-$(uname -m).zip"
APP_ICON_NAME="${APP_NAME}.icns"

if [ -t 1 ]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
    CYAN='\033[0;36m'; NC='\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
fi

log()  { printf "${GREEN}[INFO]${NC}  %s\n" "$*"; }
warn() { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
die()  { printf "${RED}[ERROR]${NC} %s\n" "$*" >&2; exit 1; }

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

brew_prefix() {
    brew --prefix "$1" 2>/dev/null || true
}

clear_bundle_metadata() {
    local bundle="$1"
    xattr -cr "$bundle" 2>/dev/null || true
    find "$bundle" -name '._*' -delete
}

create_bundle_icon() {
    local output_path="$1"
    local source_svg="$REPO_ROOT/packaging/linux/rattin.svg"
    local iconset_dir="$BUILD_DIR/${APP_NAME}.iconset"
    local master_png="$BUILD_DIR/${APP_NAME}-1024.png"

    [ -f "$source_svg" ] || die "App icon source not found at $source_svg"

    rm -rf "$iconset_dir" "$master_png" "$output_path"
    mkdir -p "$iconset_dir"

    sips -z 1024 1024 -s format png "$source_svg" --out "$master_png" >/dev/null

    for size in 16 32 128 256 512; do
        sips -z "$size" "$size" "$master_png" \
            --out "$iconset_dir/icon_${size}x${size}.png" >/dev/null

        local retina_size=$((size * 2))
        sips -z "$retina_size" "$retina_size" "$master_png" \
            --out "$iconset_dir/icon_${size}x${size}@2x.png" >/dev/null
    done

    iconutil --convert icns --output "$output_path" "$iconset_dir"

    rm -rf "$iconset_dir" "$master_png"
}

stamp_bundle_metadata() {
    local bundle="$1"
    local version="$2"
    local plist="$bundle/Contents/Info.plist"

    [ -f "$plist" ] || die "Info.plist not found at $plist"

    plutil -replace CFBundleIconFile -string "$APP_ICON_NAME" "$plist"
    plutil -replace CFBundleVersion -string "$version" "$plist"
    plutil -replace CFBundleShortVersionString -string "$version" "$plist"
}

sign_bundle() {
    local bundle="$1"
    local staging_root
    local staged_bundle

    staging_root="$(mktemp -d "${TMPDIR:-/tmp}/rattin-sign.XXXXXX")"
    staged_bundle="$staging_root/${APP_NAME}.app"

    ditto "$bundle" "$staged_bundle"
    xattr -cr "$staged_bundle" 2>/dev/null || true

    log "Applying local ad-hoc code signature"
    codesign --force --deep --sign - --timestamp=none "$staged_bundle"

    rm -rf "$bundle"
    ditto "$staged_bundle" "$bundle"
    rm -rf "$staging_root"

    if ! codesign --verify --deep --strict --verbose=2 "$bundle" >/dev/null 2>&1; then
        die "codesign verification failed for $bundle"
    fi
}

patch_qtwebengine_helper() {
    local bundle="$1"
    local helper_app="$bundle/Contents/Frameworks/QtWebEngineCore.framework/Versions/A/Helpers/QtWebEngineProcess.app"
    local helper_contents="$helper_app/Contents"
    local helper_exec="$helper_contents/MacOS/QtWebEngineProcess"

    [ -f "$helper_exec" ] || die "QtWebEngine helper not found at $helper_exec"

    codesign --remove-signature "$helper_exec" >/dev/null 2>&1 || true
    codesign --remove-signature "$helper_app" >/dev/null 2>&1 || true

    rm -rf "$helper_contents/Frameworks"
    ln -s ../../../../../.. "$helper_contents/Frameworks"

    while IFS= read -r dep; do
        case "$dep" in
            /opt/homebrew/*/Qt*.framework/*|/usr/local/*/Qt*.framework/*)
                framework="$(printf '%s\n' "$dep" | sed -E 's#.*/(Qt[^/]+)\.framework/Versions/A/.*#\1#')"
                [ -n "$framework" ] || continue
                install_name_tool -change "$dep" \
                    "@executable_path/../Frameworks/${framework}.framework/Versions/A/${framework}" \
                    "$helper_exec"
                ;;
        esac
    done < <(otool -L "$helper_exec" | tail -n +2 | awk '{print $1}')

    if otool -L "$helper_exec" | grep -E '(/opt/homebrew|/usr/local).*/Qt[^/]+\.framework' >/dev/null 2>&1; then
        die "QtWebEngine helper still references Homebrew Qt frameworks"
    fi
}

usage() {
    cat <<'EOF'
Usage: build-macos.sh [--clean]

Builds a local macOS app bundle for Rattin.

Prerequisites:
  brew install cmake pkgconf qt qtwebengine mpv ffmpeg node@20

This produces:
  build-macos/Rattin.app
  Rattin-macOS-<arch>.zip

Notes:
  - This is a source build for your local machine.
  - The build applies a local ad-hoc signature only.
  - A signed/notarized public release still needs Apple credentials.
  - VPN routing remains Linux-only.
EOF
}

CLEAN=false
while [ $# -gt 0 ]; do
    case "$1" in
        --clean) CLEAN=true; shift ;;
        --help|-h) usage; exit 0 ;;
        *) die "Unknown argument: $1" ;;
    esac
done

[ "$(uname -s)" = "Darwin" ] || die "This script must be run on macOS."

for cmd in brew xcodebuild cmake pkg-config ditto; do
    require_cmd "$cmd"
done

for cmd in codesign iconutil plutil sips xattr; do
    require_cmd "$cmd"
done

NODE20_PREFIX="$(brew_prefix node@20)"
if [ -n "$NODE20_PREFIX" ] && [ -x "$NODE20_PREFIX/bin/node" ]; then
    NODE_BIN="$NODE20_PREFIX/bin/node"
    NPM_BIN="$NODE20_PREFIX/bin/npm"
    NPX_BIN="$NODE20_PREFIX/bin/npx"
else
    require_cmd node
    require_cmd npm
    require_cmd npx
    NODE_BIN="$(command -v node)"
    NPM_BIN="$(command -v npm)"
    NPX_BIN="$(command -v npx)"
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20+ is required."
APP_VERSION="$("$NODE_BIN" -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$REPO_ROOT/package.json")"
[ -n "$APP_VERSION" ] || die "Could not read app version from package.json"

QT_PREFIX="$(brew_prefix qt)"
QTWEBENGINE_PREFIX="$(brew_prefix qtwebengine)"
MPV_PREFIX="$(brew_prefix mpv)"
FFMPEG_PREFIX="$(brew_prefix ffmpeg)"

[ -n "$QT_PREFIX" ] || die "Homebrew formula 'qt' is not installed."
[ -n "$QTWEBENGINE_PREFIX" ] || die "Homebrew formula 'qtwebengine' is not installed."
[ -n "$MPV_PREFIX" ] || die "Homebrew formula 'mpv' is not installed."
[ -n "$FFMPEG_PREFIX" ] || die "Homebrew formula 'ffmpeg' is not installed."
[ -x "$QT_PREFIX/bin/macdeployqt" ] || die "macdeployqt not found in $QT_PREFIX/bin."

export PATH="$QT_PREFIX/bin:$PATH"
export PKG_CONFIG_PATH="$MPV_PREFIX/lib/pkgconfig${PKG_CONFIG_PATH+:$PKG_CONFIG_PATH}"
export COPYFILE_DISABLE=1

if [ "$CLEAN" = true ]; then
    log "Cleaning previous macOS build output"
    rm -rf "$BUILD_DIR" "$SHELL_BUILD_DIR" "$ZIP_OUTPUT"
fi

mkdir -p "$BUILD_DIR"

log "Installing npm dependencies"
cd "$REPO_ROOT"
"$NPM_BIN" ci

log "Building frontend"
"$NPM_BIN" run build

log "Configuring Qt shell"
cmake -S "$REPO_ROOT/shell" -B "$SHELL_BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DRATTIN_APP_VERSION="$APP_VERSION" \
    -DCMAKE_PREFIX_PATH="$QT_PREFIX;$QTWEBENGINE_PREFIX"

log "Building Qt shell"
cmake --build "$SHELL_BUILD_DIR" --config Release

SHELL_BUNDLE="$SHELL_BUILD_DIR/${APP_NAME}.app"
[ -d "$SHELL_BUNDLE" ] || die "Expected bundle not found at $SHELL_BUNDLE"

log "Staging app bundle"
rm -rf "$APP_BUNDLE"
cp -R "$SHELL_BUNDLE" "$APP_BUNDLE"

APP_RESOURCES="$APP_BUNDLE/Contents/Resources"
APP_PAYLOAD="$APP_RESOURCES/app"
RUNTIME_BIN="$APP_RESOURCES/runtime/bin"
APP_ICON_PATH="$APP_RESOURCES/$APP_ICON_NAME"

mkdir -p "$APP_PAYLOAD" "$RUNTIME_BIN"

log "Generating macOS app icon"
create_bundle_icon "$APP_ICON_PATH"
stamp_bundle_metadata "$APP_BUNDLE" "$APP_VERSION"

log "Bundling backend with esbuild"
"$NPX_BIN" esbuild "$REPO_ROOT/server.ts" --bundle --platform=node --format=esm \
    --outfile="$APP_PAYLOAD/server.js" \
    --external:utp-native --external:node-datachannel \
    --external:bufferutil --external:utf-8-validate \
    --target=node20 \
    "--banner:js=import{createRequire}from'module';const require=createRequire(import.meta.url);"

cp -R "$REPO_ROOT/public" "$APP_PAYLOAD/"
cp "$REPO_ROOT/package.json" "$APP_PAYLOAD/"
cp "$REPO_ROOT/package-lock.json" "$APP_PAYLOAD/"
cp "$REPO_ROOT/.env.example" "$APP_PAYLOAD/"

log "Installing production dependencies into app payload"
(
    cd "$APP_PAYLOAD"
    "$NPM_BIN" ci --omit=dev
)

log "Bundling local runtime binaries"
cp -L "$NODE_BIN" "$RUNTIME_BIN/node"
cp -L "$FFMPEG_PREFIX/bin/ffmpeg" "$RUNTIME_BIN/ffmpeg"
cp -L "$FFMPEG_PREFIX/bin/ffprobe" "$RUNTIME_BIN/ffprobe"
chmod +x "$RUNTIME_BIN/node" "$RUNTIME_BIN/ffmpeg" "$RUNTIME_BIN/ffprobe"

log "Running macdeployqt"
MACDEPLOYQT_LOG="$BUILD_DIR/macdeployqt.log"
if ! "$QT_PREFIX/bin/macdeployqt" "$APP_BUNDLE" \
    -qmldir="$REPO_ROOT/shell" \
    -no-codesign \
    >"$MACDEPLOYQT_LOG" 2>&1; then
    cat "$MACDEPLOYQT_LOG" >&2
    die "macdeployqt failed"
fi

if grep -q '^ERROR:' "$MACDEPLOYQT_LOG"; then
    warn "macdeployqt reported deployment warnings; validating and patching the bundle"
fi

log "Repairing QtWebEngine helper bundle"
patch_qtwebengine_helper "$APP_BUNDLE"

log "Removing stray macOS metadata from bundle"
clear_bundle_metadata "$APP_BUNDLE"

sign_bundle "$APP_BUNDLE"

log "Creating ZIP archive"
rm -f "$ZIP_OUTPUT"
ditto -c -k --sequesterRsrc --keepParent "$APP_BUNDLE" "$ZIP_OUTPUT"

cat <<EOF

Build complete
  App bundle: $APP_BUNDLE
  ZIP:        $ZIP_OUTPUT

Launch locally:
  open "$APP_BUNDLE"

If Finder blocks the app on first launch, clear the quarantine flag:
  xattr -dr com.apple.quarantine "$APP_BUNDLE"

Because this build is not notarized, Gatekeeper may still require:
  - right-click -> Open once, or
  - approval in System Settings -> Privacy & Security
EOF
