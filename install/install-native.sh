#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Rattin Native — Linux Desktop Installer
# Installs Qt6 deps, builds the Qt shell + mpv player, creates desktop entry
# ==============================================================================

INSTALLER_VERSION="1.0.0"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/share/rattin}"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"
REPO_URL="https://github.com/rattin-player/player"
BRANCH="native-desktop-pivot"

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

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
UNINSTALL=false
TMDB_KEY=""

while [ $# -gt 0 ]; do
    case "$1" in
        --uninstall)    UNINSTALL=true; shift ;;
        --tmdb-key)     TMDB_KEY="$2"; shift 2 ;;
        --tmdb-key=*)   TMDB_KEY="${1#*=}"; shift ;;
        --help|-h)
            echo "Usage: install-native.sh [OPTIONS]"
            echo ""
            echo "Installs Rattin as a native desktop app with Qt6 + mpv."
            echo ""
            echo "Options:"
            echo "  --uninstall        Remove Rattin native"
            echo "  --tmdb-key KEY     Provide TMDB API key"
            echo "  --help, -h         Show this help message"
            exit 0
            ;;
        *) die "Unknown argument: $1. Use --help for usage." ;;
    esac
done

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
if [ "$UNINSTALL" = "true" ]; then
    log "Uninstalling Rattin native..."
    rm -f "$BIN_DIR/rattin"
    rm -f "$DESKTOP_DIR/rattin.desktop"
    rm -rf "$INSTALL_DIR"
    log "Updating desktop database..."
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
    log "Rattin native uninstalled."
    exit 0
fi

# ---------------------------------------------------------------------------
# Distro detection
# ---------------------------------------------------------------------------
detect_distro() {
    DISTRO_ID="unknown"
    DISTRO_ID_LIKE=""
    PKG_MANAGER="unknown"

    if [ -f /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        DISTRO_ID="${ID:-unknown}"
        DISTRO_ID_LIKE="${ID_LIKE:-}"
    fi

    local match="${DISTRO_ID} ${DISTRO_ID_LIKE}"
    if echo "$match" | grep -qiE 'arch|cachyos|manjaro|endeavour'; then
        PKG_MANAGER="pacman"
    elif echo "$match" | grep -qiE 'debian|ubuntu|linuxmint|pop'; then
        PKG_MANAGER="apt"
    elif echo "$match" | grep -qiE 'fedora|rhel|centos|rocky'; then
        PKG_MANAGER="dnf"
    elif echo "$match" | grep -qiE 'opensuse|suse'; then
        PKG_MANAGER="zypper"
    fi
    log "Detected: ${DISTRO_ID} (pkg: ${PKG_MANAGER})"
}

# ---------------------------------------------------------------------------
# Install system dependencies
# ---------------------------------------------------------------------------
install_deps() {
    log "Checking system dependencies..."

    local missing=()

    # Check for each required tool/lib
    command -v cmake   >/dev/null 2>&1 || missing+=("cmake")
    command -v make    >/dev/null 2>&1 || missing+=("make")
    command -v pkg-config >/dev/null 2>&1 || missing+=("pkg-config")
    command -v node    >/dev/null 2>&1 || missing+=("nodejs")
    command -v npm     >/dev/null 2>&1 || missing+=("npm")
    command -v ffmpeg  >/dev/null 2>&1 || missing+=("ffmpeg")
    command -v ffprobe >/dev/null 2>&1 || missing+=("ffprobe")

    # Check for mpv/libmpv
    if ! pkg-config --exists mpv 2>/dev/null; then
        missing+=("libmpv")
    fi

    # Check for Qt6 WebEngine (the heaviest dep — if this exists, the rest likely do)
    if ! pkg-config --exists Qt6WebEngineCore 2>/dev/null; then
        missing+=("qt6-webengine")
    fi

    if [ ${#missing[@]} -eq 0 ]; then
        log "All dependencies already installed"
        return 0
    fi

    warn "Missing: ${missing[*]}"
    log "Installing dependencies via ${PKG_MANAGER}..."

    case "$PKG_MANAGER" in
        pacman)
            sudo pacman -Syu --needed --noconfirm \
                qt6-base qt6-webengine qt6-declarative qt6-webchannel \
                mpv cmake pkgconf nodejs npm ffmpeg chromaprint
            ;;
        apt)
            sudo apt-get update -qq
            sudo apt-get install -y -qq \
                qt6-base-dev qt6-webengine-dev qt6-webengine-dev-tools \
                qt6-declarative-dev qt6-webchannel-dev \
                libmpv-dev cmake pkg-config nodejs npm ffmpeg libchromaprint-tools
            ;;
        dnf)
            sudo dnf install -y \
                qt6-qtbase-devel qt6-qtwebengine-devel qt6-qtdeclarative-devel \
                qt6-qtwebchannel-devel \
                mpv-libs-devel cmake pkg-config nodejs npm ffmpeg chromaprint-tools
            ;;
        zypper)
            sudo zypper install -y \
                qt6-base-devel qt6-webengine-devel qt6-declarative-devel \
                qt6-webchannel-devel \
                mpv-devel cmake pkg-config nodejs20 npm20 ffmpeg chromaprint-fpcalc
            ;;
        *)
            die "Cannot auto-install on ${DISTRO_ID}. Please install manually:
  Qt6 (base, webengine, declarative, webchannel), libmpv, cmake, pkg-config,
  nodejs, npm, ffmpeg, chromaprint (fpcalc)
Then re-run this installer."
            ;;
    esac

    log "Dependencies installed"
}

# ---------------------------------------------------------------------------
# Download / update app source
# ---------------------------------------------------------------------------
get_source() {
    if [ -d "$INSTALL_DIR/source/.git" ]; then
        log "Updating existing source..."
        cd "$INSTALL_DIR/source"
        git fetch origin
        git checkout "$BRANCH"
        git reset --hard "origin/$BRANCH"
    else
        log "Cloning repository..."
        mkdir -p "$INSTALL_DIR"
        git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR/source"
    fi
    cd "$INSTALL_DIR/source"
    log "Source ready at $INSTALL_DIR/source"
}

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
build_app() {
    cd "$INSTALL_DIR/source"

    log "Installing Node.js dependencies..."
    npm install --production=false 2>&1 | tail -3

    log "Building frontend..."
    npm run build 2>&1 | tail -3

    log "Building Qt6 shell..."
    cd shell
    mkdir -p build && cd build
    cmake .. -DCMAKE_BUILD_TYPE=Release 2>&1 | tail -5
    make -j"$(nproc)" 2>&1 | tail -5
    cd "$INSTALL_DIR/source"

    log "Build complete"
}

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
install_app() {
    log "Installing..."

    # Symlink the binary
    mkdir -p "$BIN_DIR"
    ln -sf "$INSTALL_DIR/source/shell/build/rattin-shell" "$BIN_DIR/rattin"

    # .env file
    if [ ! -f "$INSTALL_DIR/source/.env" ]; then
        if [ -n "$TMDB_KEY" ]; then
            echo "TMDB_API_KEY=$TMDB_KEY" > "$INSTALL_DIR/source/.env"
            log "Created .env with provided TMDB key"
        else
            printf "${CYAN}Enter your TMDB API key (get one at https://www.themoviedb.org/settings/api):${NC} "
            read -r key < /dev/tty || key=""
            if [ -n "$key" ]; then
                echo "TMDB_API_KEY=$key" > "$INSTALL_DIR/source/.env"
                log "Created .env"
            else
                echo "TMDB_API_KEY=" > "$INSTALL_DIR/source/.env"
                warn "No TMDB key provided — browsing won't work until you add one to $INSTALL_DIR/source/.env"
            fi
        fi
    else
        log ".env already exists, keeping it"
    fi

    # Desktop entry
    mkdir -p "$DESKTOP_DIR"
    cat > "$DESKTOP_DIR/rattin.desktop" << EOF
[Desktop Entry]
Name=Rattin
Comment=Stream torrents instantly with native video playback
Exec=$BIN_DIR/rattin %U
Icon=rattin
Type=Application
Categories=AudioVideo;Video;Player;
MimeType=x-scheme-handler/magnet;application/x-bittorrent;
Terminal=false
StartupWMClass=MagnetPlayer
EOF

    # Icon (generate a simple one if none exists)
    mkdir -p "$ICON_DIR"
    if [ ! -f "$ICON_DIR/rattin.png" ]; then
        # Create a simple SVG icon and convert if possible, otherwise skip
        if command -v convert >/dev/null 2>&1; then
            convert -size 256x256 xc:'#1a1a2e' \
                -fill '#e94560' -draw "circle 128,128 128,40" \
                -fill white -gravity center -pointsize 80 -annotate +0+0 "M" \
                "$ICON_DIR/rattin.png" 2>/dev/null || true
        fi
    fi

    # Update desktop database
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
    gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

    log "Installed"
}

# ---------------------------------------------------------------------------
# Print summary
# ---------------------------------------------------------------------------
print_summary() {
    echo ""
    printf "${BOLD}========================================${NC}\n"
    printf "${GREEN}  Rattin Native installed!${NC}\n"
    printf "${BOLD}========================================${NC}\n"
    echo ""
    echo "  Launch:  rattin"
    echo "  Or find 'Rattin' in your application menu"
    echo ""
    echo "  Install dir:  $INSTALL_DIR"
    echo "  Binary:       $BIN_DIR/rattin"
    echo "  Config:       $INSTALL_DIR/source/.env"
    echo ""
    echo "  To update:    re-run this installer"
    echo "  To uninstall: $0 --uninstall"
    echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    echo ""
    printf "${BOLD}Rattin Native — Desktop Installer v${INSTALLER_VERSION}${NC}\n"
    echo ""

    detect_distro
    install_deps
    get_source
    build_app
    install_app
    print_summary
}

main
