#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Rattin — Linux Installer
# Preflight checks, distro detection, and mode detection
# ==============================================================================

INSTALLER_VERSION="1.0.0"
INSTALL_DIR="/opt/rattin"

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    NC='\033[0m' # No Color
else
    RED=''
    GREEN=''
    YELLOW=''
    NC=''
fi

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log() {
    local level="$1"
    shift
    local msg="$*"
    local timestamp
    timestamp="$(date '+%Y-%m-%d %H:%M:%S')"

    case "$level" in
        info)    printf "${GREEN}[INFO]${NC}  %s\n" "$msg" ;;
        warn)    printf "${YELLOW}[WARN]${NC}  %s\n" "$msg" ;;
        error)   printf "${RED}[ERROR]${NC} %s\n" "$msg" >&2 ;;
        *)       printf "%s\n" "$msg" ;;
    esac

    # Append to install log (create dir if needed)
    mkdir -p "$INSTALL_DIR"
    echo "[$timestamp] [$level] $msg" >> "$INSTALL_DIR/install.log"
}

die() {
    log error "$*"
    exit 1
}

# ---------------------------------------------------------------------------
# download() — fetch a URL to stdout; tries curl then wget
# ---------------------------------------------------------------------------
download() {
    local url="$1"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO- "$url"
    else
        die "Neither curl nor wget found. Please install one and retry."
    fi
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
UNINSTALL=false

while [ $# -gt 0 ]; do
    case "$1" in
        --uninstall)
            UNINSTALL=true
            shift
            ;;
        --help|-h)
            echo "Usage: install.sh [--uninstall]"
            echo ""
            echo "Options:"
            echo "  --uninstall   Remove rattin and all its components"
            echo "  --help, -h    Show this help message"
            exit 0
            ;;
        *)
            die "Unknown argument: $1. Use --help for usage."
            ;;
    esac
done

# ---------------------------------------------------------------------------
# Lockfile — prevent concurrent installs
# ---------------------------------------------------------------------------
acquire_lock() {
    mkdir -p "$INSTALL_DIR"
    LOCK_FD=9
    eval "exec $LOCK_FD>$INSTALL_DIR/.install.lock"
    if ! flock -n "$LOCK_FD"; then
        die "Another installer instance is already running. If this is wrong, remove $INSTALL_DIR/.install.lock"
    fi
}

# ---------------------------------------------------------------------------
# preflight() — environment and system checks
# ---------------------------------------------------------------------------
preflight() {
    log info "Running preflight checks (installer v${INSTALLER_VERSION})..."

    # 1. Architecture detection
    local raw_arch
    raw_arch="$(uname -m)"
    case "$raw_arch" in
        x86_64)         ARCH="x64" ;;
        aarch64|arm64)  ARCH="arm64" ;;
        armv6l)         die "armv6l (ARMv6) is not supported. A 64-bit ARM or x86_64 system is required." ;;
        *)              die "Unsupported architecture: $raw_arch" ;;
    esac
    log info "Architecture: $raw_arch -> $ARCH"

    # 2. Musl detection
    if ldd --version 2>&1 | grep -qi musl; then
        die "Alpine/musl-based distros are not supported"
    fi

    # 3. Distro / package-manager detection
    DISTRO_ID="unknown"
    DISTRO_ID_LIKE=""
    PKG_MANAGER="unknown"

    if [ -f /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        DISTRO_ID="${ID:-unknown}"
        DISTRO_ID_LIKE="${ID_LIKE:-}"
    fi

    local distro_match="${DISTRO_ID} ${DISTRO_ID_LIKE}"
    if echo "$distro_match" | grep -qiE 'debian|ubuntu|linuxmint|pop'; then
        PKG_MANAGER="apt-get"
    elif echo "$distro_match" | grep -qiE 'fedora|rhel|centos|rocky|almalinux'; then
        PKG_MANAGER="dnf"
    else
        log warn "Unsupported distro '${DISTRO_ID}', continuing anyway. Package installs may need manual intervention."
        PKG_MANAGER="unknown"
    fi
    log info "Distro: ${DISTRO_ID} (like: ${DISTRO_ID_LIKE:-none}) -> package manager: ${PKG_MANAGER}"

    # 4. Internet check
    log info "Checking internet connectivity..."
    local endpoints=("https://nodejs.org" "https://github.com" "https://registry.npmjs.org")
    for endpoint in "${endpoints[@]}"; do
        if command -v curl >/dev/null 2>&1; then
            if ! curl -fsSL --head --max-time 10 "$endpoint" >/dev/null 2>&1; then
                die "Cannot reach $endpoint — check your internet connection or firewall."
            fi
        elif command -v wget >/dev/null 2>&1; then
            if ! wget --spider --quiet --timeout=10 "$endpoint" 2>/dev/null; then
                die "Cannot reach $endpoint — check your internet connection or firewall."
            fi
        else
            die "Neither curl nor wget found. Please install one and retry."
        fi
    done
    log info "Internet connectivity OK"

    # 5. Disk space check (>= 1 GB free on /opt or /)
    local check_mount="/"
    if df /opt >/dev/null 2>&1; then
        check_mount="/opt"
    fi
    local avail_gb
    avail_gb="$(df -BG --output=avail "$check_mount" | tail -1 | tr -d ' G')"
    if [ "$avail_gb" -lt 1 ]; then
        die "Insufficient disk space on $check_mount: ${avail_gb}GB available, need at least 1GB."
    fi
    log info "Disk space on $check_mount: ${avail_gb}GB available"

    # 6. SELinux detection
    SELINUX_ENFORCING=false
    if command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" = "Enforcing" ]; then
        SELINUX_ENFORCING=true
        log warn "SELinux is in enforcing mode. The installer will set appropriate contexts."
    fi

    log info "Preflight checks passed"
}

# ---------------------------------------------------------------------------
# detect_mode() — fresh install, update, or wipe
# ---------------------------------------------------------------------------
detect_mode() {
    MODE="fresh"

    if [ -d "$INSTALL_DIR/app/" ] && [ -f "$INSTALL_DIR/.installer-version" ]; then
        MODE="update"
        log info "Existing installation found (managed by installer) — update mode"
    elif [ -d "$INSTALL_DIR/" ] && [ ! -f "$INSTALL_DIR/.installer-version" ]; then
        MODE="unknown"
        log warn "Found existing $INSTALL_DIR not managed by this installer."
        printf "${YELLOW}Found existing installation not managed by this installer. Wipe and reinstall? [y/N]${NC} "
        local answer
        read -r answer < /dev/tty || answer="n"
        case "$answer" in
            [yY]|[yY][eE][sS])
                MODE="wipe"
                log info "User chose to wipe and reinstall"
                ;;
            *)
                log info "User declined to wipe — exiting"
                exit 0
                ;;
        esac
    else
        log info "No existing installation found — fresh install mode"
    fi
}

# ---------------------------------------------------------------------------
# uninstall() — remove all rattin components
# ---------------------------------------------------------------------------
uninstall() {
    log info "Uninstalling rattin..."

    systemctl stop rattin 2>/dev/null || true
    systemctl disable rattin 2>/dev/null || true
    rm -f /etc/systemd/system/rattin.service
    rm -f /etc/systemd/system/rattin-cleanup.service
    rm -f /etc/systemd/system/rattin-cleanup.timer
    systemctl daemon-reload 2>/dev/null || true
    userdel rattin 2>/dev/null || true
    rm -rf "$INSTALL_DIR"

    log info "Rattin uninstalled successfully."
}

# ==============================================================================
# Main
# ==============================================================================
main() {
    # Root check (needed for both install and uninstall)
    if [ "$(id -u)" -ne 0 ]; then
        die "This installer must be run as root. Re-run with: sudo $0"
    fi

    acquire_lock

    # Handle --uninstall before preflight (no need for internet/disk checks)
    if [ "$UNINSTALL" = true ]; then
        uninstall
        exit 0
    fi

    preflight
    detect_mode

    log info "Install mode: $MODE"

    # Wipe mode: uninstall first, then continue as fresh install
    if [ "$MODE" = "wipe" ]; then
        uninstall
        MODE="fresh"
        log info "Wipe complete — continuing as fresh install"
    fi

    # Future tasks will add:
    # - Node.js download/install
    # - ffmpeg download/install
    # - App download/build
    # - systemd service setup
}

main
