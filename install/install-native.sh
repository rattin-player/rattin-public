#!/usr/bin/env bash
# =============================================================================
# Rattin — Linux Desktop Installer
# Downloads a pre-built AppImage, creates desktop entry + config.
#
# Install:    curl -fsSL <url>/install-native.sh | bash
# Uninstall:  curl -fsSL <url>/install-native.sh | bash -s -- --uninstall
# =============================================================================

main() {
set -euo pipefail

INSTALLER_VERSION="2.0.0"
APP_DIR="$HOME/.local/share/rattin"
BIN_DIR="$HOME/.local/bin"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/rattin"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"
APPIMAGE_URL="https://github.com/rattin-player/rattin-public/releases/latest/download/Rattin-x86_64.AppImage"
APPIMAGE_NAME="Rattin.AppImage"

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
            echo "Installs Rattin as a native desktop app (AppImage)."
            echo ""
            echo "Options:"
            echo "  --uninstall        Remove Rattin"
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
if [ "$UNINSTALL" = true ]; then
    log "Uninstalling Rattin..."
    rm -f "$BIN_DIR/rattin"
    rm -f "$DESKTOP_DIR/rattin.desktop"
    rm -f "$ICON_DIR/rattin.svg" "$ICON_DIR/rattin.png"
    rm -rf "$APP_DIR"
    # Also clean up old installs that used 256x256 icon path
    rm -f "$HOME/.local/share/icons/hicolor/256x256/apps/rattin.png"
    rm -f "$HOME/.local/share/icons/hicolor/256x256/apps/rattin.svg"
    log "Updating desktop database..."
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
    gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
    echo ""
    log "Rattin uninstalled."
    echo "  Config preserved at: $CONFIG_DIR"
    echo "  To remove config too: rm -rf $CONFIG_DIR"
    exit 0
fi

# ---------------------------------------------------------------------------
# Download AppImage
# ---------------------------------------------------------------------------
log "Downloading Rattin AppImage..."

mkdir -p "$APP_DIR"
local tmpfile="$APP_DIR/${APPIMAGE_NAME}.tmp"

if command -v curl >/dev/null 2>&1; then
    curl -fSL "$APPIMAGE_URL" -o "$tmpfile"
elif command -v wget >/dev/null 2>&1; then
    wget -q "$APPIMAGE_URL" -O "$tmpfile"
else
    die "Neither curl nor wget found."
fi

# Verify download (AppImage should be >1 MB)
local filesize
filesize="$(stat -c%s "$tmpfile" 2>/dev/null || stat -f%z "$tmpfile" 2>/dev/null || echo 0)"
if [ "$filesize" -lt 1000000 ]; then
    rm -f "$tmpfile"
    die "Download too small (${filesize} bytes). Check the release URL."
fi

mv "$tmpfile" "$APP_DIR/$APPIMAGE_NAME"
chmod +x "$APP_DIR/$APPIMAGE_NAME"

log "AppImage saved to $APP_DIR/$APPIMAGE_NAME"

# ---------------------------------------------------------------------------
# Create symlink
# ---------------------------------------------------------------------------
mkdir -p "$BIN_DIR"
ln -sf "$APP_DIR/$APPIMAGE_NAME" "$BIN_DIR/rattin"
log "Symlinked: $BIN_DIR/rattin"

# ---------------------------------------------------------------------------
# Config (.env)
# ---------------------------------------------------------------------------
mkdir -p "$CONFIG_DIR"

if [ ! -f "$CONFIG_DIR/.env" ]; then
    if [ -n "$TMDB_KEY" ]; then
        echo "TMDB_API_KEY=$TMDB_KEY" > "$CONFIG_DIR/.env"
        log "Created config with provided TMDB key"
    else
        # Try to prompt interactively
        if [ -t 0 ]; then
            printf "${CYAN}Enter your TMDB API key (get one at https://www.themoviedb.org/settings/api):${NC} "
            read -r key < /dev/tty || key=""
            if [ -n "$key" ]; then
                echo "TMDB_API_KEY=$key" > "$CONFIG_DIR/.env"
                log "Created config"
            else
                echo "TMDB_API_KEY=" > "$CONFIG_DIR/.env"
                warn "No TMDB key provided — browsing won't work until you add one to $CONFIG_DIR/.env"
            fi
        else
            echo "TMDB_API_KEY=" > "$CONFIG_DIR/.env"
            warn "No TMDB key provided — add one to $CONFIG_DIR/.env"
        fi
    fi
else
    log "Config already exists, keeping it"
fi

# ---------------------------------------------------------------------------
# Desktop entry + icon
# ---------------------------------------------------------------------------
mkdir -p "$DESKTOP_DIR" "$ICON_DIR"

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

# Extract the icon from the AppImage
# AppImages support --appimage-extract to get contents without FUSE
cd /tmp
"$APP_DIR/$APPIMAGE_NAME" --appimage-extract rattin.svg >/dev/null 2>&1 || true
if [ -f "squashfs-root/rattin.svg" ]; then
    cp "squashfs-root/rattin.svg" "$ICON_DIR/rattin.svg"
fi
rm -rf squashfs-root

update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
printf "${BOLD}========================================${NC}\n"
printf "${GREEN}  Rattin installed!${NC}\n"
printf "${BOLD}========================================${NC}\n"
echo ""
echo "  Launch:  rattin"
echo "  Or find 'Rattin' in your application menu"
echo ""
echo "  AppImage: $APP_DIR/$APPIMAGE_NAME"
echo "  Binary:   $BIN_DIR/rattin"
echo "  Config:   $CONFIG_DIR/.env"
echo ""
echo "  To update:    re-run this installer"
echo "  To uninstall: bash <(curl -fsSL <url>/install-native.sh) --uninstall"
echo ""

} # end main()

main "$@"
