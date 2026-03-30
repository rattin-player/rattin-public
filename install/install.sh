#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Rattin — Linux Installer
# Preflight checks, distro detection, and mode detection
# ==============================================================================

INSTALLER_VERSION="1.0.0"
INSTALL_DIR="${INSTALL_DIR:-/opt/rattin}"

trap 'rm -rf /tmp/rattin-node-download.tar.xz /tmp/rattin-ffmpeg-download.tar.xz /tmp/rattin-app-download.tar.gz /tmp/rattin-ffmpeg-extract' EXIT

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
USE_SERVICE=false
NON_INTERACTIVE=false

while [ $# -gt 0 ]; do
    case "$1" in
        --uninstall)
            UNINSTALL=true
            shift
            ;;
        --non-interactive)
            NON_INTERACTIVE=true
            shift
            ;;
        --tmdb-key)
            TMDB_API_KEY_ARG="$2"
            shift 2
            ;;
        --tmdb-key=*)
            TMDB_API_KEY_ARG="${1#*=}"
            shift
            ;;
        --no-service)
            USE_SERVICE=false
            NO_SERVICE_FLAG=true
            shift
            ;;
        --help|-h)
            echo "Usage: install.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --uninstall        Remove rattin and all its components"
            echo "  --non-interactive  Skip all prompts (use with --tmdb-key and --no-service)"
            echo "  --tmdb-key KEY     Provide TMDB API key non-interactively"
            echo "  --no-service       Skip systemd service setup (create start.sh instead)"
            echo "  --help, -h         Show this help message"
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

    # 4. Ensure basic prerequisites are available (curl/wget, xz for tar.xz)
    local need_install=false
    local pkgs_apt="" pkgs_dnf=""

    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        need_install=true
        pkgs_apt="curl" pkgs_dnf="curl"
    fi
    if ! command -v xz >/dev/null 2>&1; then
        need_install=true
        pkgs_apt="$pkgs_apt xz-utils" pkgs_dnf="$pkgs_dnf xz"
    fi

    if [ "$need_install" = "true" ]; then
        log info "Installing prerequisites:${pkgs_apt:-$pkgs_dnf}..."
        case "$PKG_MANAGER" in
            apt-get) apt-get update -qq && apt-get install -y -qq $pkgs_apt >/dev/null 2>&1 ;;
            dnf)     dnf install -y -q $pkgs_dnf >/dev/null 2>&1 ;;
            *)       die "Missing prerequisites and no known package manager to install them." ;;
        esac
        log info "Prerequisites installed"
    fi

    # 5. Internet check
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

        local answer
        if [ "$NON_INTERACTIVE" = "true" ]; then
            answer="y"
            log info "Non-interactive mode: auto-wiping existing installation"
        else
            printf "${YELLOW}Found existing installation not managed by this installer. Wipe and reinstall? [y/N]${NC} "
            read -r answer < /dev/tty || answer="n"
        fi
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

# ---------------------------------------------------------------------------
# create_user() — create the rattin system user
# ---------------------------------------------------------------------------
create_user() {
    if ! id rattin >/dev/null 2>&1; then
        useradd --system --shell /usr/sbin/nologin --home-dir "$INSTALL_DIR" rattin
        log info "Created system user: rattin"
    else
        log info "System user rattin already exists"
    fi
}

# ---------------------------------------------------------------------------
# create_dirs() — create the directory structure
# ---------------------------------------------------------------------------
create_dirs() {
    log info "Creating directory structure..."
    mkdir -p "$INSTALL_DIR"/{runtime/node,runtime/bin,app,data/downloads,data/transcoded}
    log info "Directory structure created"
}

# ---------------------------------------------------------------------------
# install_node() — download and install Node.js v20 LTS
# ---------------------------------------------------------------------------
install_node() {
    log info "Installing Node.js..."

    # Query latest v20 LTS version
    local version_json
    version_json="$(download "https://nodejs.org/dist/index.json")"

    # Find first v20.x entry where "lts" is not false
    # Use a temp var to avoid SIGPIPE from head -1 in pipefail mode
    local filtered
    filtered="$(echo "$version_json" | tr '{' '\n' | grep '"version":"v20\.' | grep -v '"lts":false' || true)"
    local latest_version
    latest_version="$(echo "$filtered" | head -1 | sed 's/.*"version":"\(v20\.[^"]*\)".*/\1/')"

    if [ -z "$latest_version" ]; then
        die "Could not determine latest Node.js v20 LTS version"
    fi
    log info "Latest Node.js v20 LTS: $latest_version"

    # On update: check if already installed at this version
    if [ "$MODE" = "update" ] && [ -x "$INSTALL_DIR/runtime/node/bin/node" ]; then
        local installed_version
        installed_version="$("$INSTALL_DIR/runtime/node/bin/node" --version 2>/dev/null || echo "")"
        if [ "$installed_version" = "$latest_version" ]; then
            log info "Node.js $latest_version already installed — skipping"
            return 0
        fi
        log info "Node.js version change: $installed_version -> $latest_version"
        # Back up existing installation
        rm -rf "$INSTALL_DIR/runtime/node.bak"
        mv "$INSTALL_DIR/runtime/node" "$INSTALL_DIR/runtime/node.bak"
        mkdir -p "$INSTALL_DIR/runtime/node"
    fi

    # Download
    local url="https://nodejs.org/dist/$latest_version/node-$latest_version-linux-$ARCH.tar.xz"
    local tmpfile="/tmp/rattin-node-download.tar.xz"
    log info "Downloading Node.js from $url"
    download "$url" > "$tmpfile"

    # Verify file size > 20MB
    local filesize
    filesize="$(stat -c%s "$tmpfile")"
    if [ "$filesize" -lt 20000000 ]; then
        rm -f "$tmpfile"
        die "Node.js download too small (${filesize} bytes). Download may have failed."
    fi

    # Extract
    rm -rf "$INSTALL_DIR/runtime/node"
    mkdir -p "$INSTALL_DIR/runtime/node"
    tar -xJf "$tmpfile" -C "$INSTALL_DIR/runtime/node/" --strip-components=1

    # Clean up
    rm -f "$tmpfile"

    # Verify
    if ! "$INSTALL_DIR/runtime/node/bin/node" --version >/dev/null 2>&1; then
        die "Node.js installation verification failed"
    fi
    log info "Node.js $("$INSTALL_DIR/runtime/node/bin/node" --version) installed successfully"
}

# ---------------------------------------------------------------------------
# install_ffmpeg() — download static ffmpeg + ffprobe binaries
# ---------------------------------------------------------------------------
install_ffmpeg() {
    log info "Installing ffmpeg..."

    local url
    case "$ARCH" in
        x64)    url="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" ;;
        arm64)  url="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz" ;;
        *)      die "Unsupported architecture for ffmpeg: $ARCH" ;;
    esac

    # Download
    local tmpfile="/tmp/rattin-ffmpeg-download.tar.xz"
    log info "Downloading ffmpeg from $url"
    download "$url" > "$tmpfile"

    # Verify file size > 30MB
    local filesize
    filesize="$(stat -c%s "$tmpfile")"
    if [ "$filesize" -lt 30000000 ]; then
        rm -f "$tmpfile"
        die "ffmpeg download too small (${filesize} bytes). Download may have failed."
    fi

    # Extract to a temp directory first, then copy binaries
    local tmpdir="/tmp/rattin-ffmpeg-extract"
    rm -rf "$tmpdir"
    mkdir -p "$tmpdir"
    tar -xJf "$tmpfile" -C "$tmpdir"

    # Find ffmpeg and ffprobe in the extracted archive
    local ffmpeg_bin ffprobe_bin
    ffmpeg_bin="$(find "$tmpdir" -name ffmpeg -type f | head -1)"
    ffprobe_bin="$(find "$tmpdir" -name ffprobe -type f | head -1)"

    if [ -z "$ffmpeg_bin" ] || [ -z "$ffprobe_bin" ]; then
        rm -rf "$tmpdir" "$tmpfile"
        die "Could not find ffmpeg/ffprobe binaries in the downloaded archive"
    fi

    # Install binaries
    mkdir -p "$INSTALL_DIR/runtime/bin"
    cp "$ffmpeg_bin" "$INSTALL_DIR/runtime/bin/ffmpeg"
    cp "$ffprobe_bin" "$INSTALL_DIR/runtime/bin/ffprobe"
    chmod +x "$INSTALL_DIR/runtime/bin/ffmpeg" "$INSTALL_DIR/runtime/bin/ffprobe"

    # Clean up
    rm -rf "$tmpdir" "$tmpfile"

    # Verify
    if ! "$INSTALL_DIR/runtime/bin/ffmpeg" -version >/dev/null 2>&1; then
        die "ffmpeg installation verification failed"
    fi
    log info "ffmpeg installed successfully: $("$INSTALL_DIR/runtime/bin/ffmpeg" -version 2>&1 | head -1)"
}

# ---------------------------------------------------------------------------
# install_fpcalc() — install chromaprint fpcalc (best-effort, system-wide)
# ---------------------------------------------------------------------------
install_fpcalc() {
    log info "Installing fpcalc (chromaprint)..."

    case "$PKG_MANAGER" in
        apt-get)
            if ! (apt-get update -qq && apt-get install -y libchromaprint-tools); then
                log warn "fpcalc not available — acoustic fingerprinting will be disabled"
            fi
            ;;
        dnf)
            if ! dnf install -y chromaprint-tools; then
                log warn "fpcalc not available — acoustic fingerprinting will be disabled"
            fi
            ;;
        *)
            log warn "Unknown package manager — skipping fpcalc install. Acoustic fingerprinting may not work."
            ;;
    esac

    if command -v fpcalc >/dev/null 2>&1; then
        log info "fpcalc installed successfully: $(fpcalc -version 2>&1 | head -1)"
    else
        log warn "fpcalc not found in PATH after install attempt"
    fi
}

# ---------------------------------------------------------------------------
# install_build_tools() — install C++ compiler, make, python3 for native addons
# ---------------------------------------------------------------------------
install_build_tools() {
    log info "Installing build tools..."

    case "$PKG_MANAGER" in
        apt-get)
            if ! apt-get install -y build-essential python3; then
                die "Failed to install build tools"
            fi
            ;;
        dnf)
            if ! dnf install -y gcc-c++ make python3; then
                die "Failed to install build tools"
            fi
            ;;
        *)
            log warn "Unknown package manager — skipping build tools install. Native addons may fail to compile."
            return 0
            ;;
    esac

    log info "Build tools installed successfully"
}

# ---------------------------------------------------------------------------
# rollback() — restore app.bak and node.bak on update failure
# ---------------------------------------------------------------------------
rollback() {
    log warn "Rolling back to previous installation..."
    if [ -d "$INSTALL_DIR/app.bak" ]; then
        rm -rf "$INSTALL_DIR/app"
        mv "$INSTALL_DIR/app.bak" "$INSTALL_DIR/app"
        log info "Restored previous app directory"
    fi
    if [ -d "$INSTALL_DIR/runtime/node.bak" ]; then
        rm -rf "$INSTALL_DIR/runtime/node"
        mv "$INSTALL_DIR/runtime/node.bak" "$INSTALL_DIR/runtime/node"
        log info "Restored previous Node.js installation"
    fi
    systemctl start rattin 2>/dev/null || true
    log warn "Rollback complete. Previous version restored."
}

# ---------------------------------------------------------------------------
# install_app() — download the app from GitHub
# ---------------------------------------------------------------------------
install_app() {
    log info "Downloading application..."

    local tmpfile="/tmp/rattin-app-download.tar.gz"

    if [ -n "${APP_TARBALL:-}" ] && [ -f "$APP_TARBALL" ]; then
        log info "Using local app tarball: $APP_TARBALL"
        cp "$APP_TARBALL" "$tmpfile"
    else
        local tarball_url="https://github.com/rattin-player/rattin-public/releases/latest/download/app.tar.gz"
        download "$tarball_url" > "$tmpfile"
    fi

    # Verify file size > 100KB
    local filesize
    filesize="$(stat -c%s "$tmpfile")"
    if [ "$filesize" -lt 100000 ]; then
        rm -f "$tmpfile"
        die "App download too small (${filesize} bytes). Download may have failed."
    fi

    if [ "$MODE" = "update" ]; then
        # Stop service before replacing files
        systemctl stop rattin 2>/dev/null || true

        # Backup current app directory
        rm -rf "$INSTALL_DIR/app.bak"
        mv "$INSTALL_DIR/app" "$INSTALL_DIR/app.bak"
        mkdir -p "$INSTALL_DIR/app"

        # Extract new tarball
        if ! tar -xzf "$tmpfile" -C "$INSTALL_DIR/app/" --strip-components=1; then
            rollback
            die "Failed to extract app update"
        fi

        # Restore .env from backup
        if ! cp "$INSTALL_DIR/app.bak/.env" "$INSTALL_DIR/app/.env" 2>/dev/null; then
            log warn "No .env found in backup to restore"
        fi
    else
        # Fresh install — extract directly
        mkdir -p "$INSTALL_DIR/app"
        tar -xzf "$tmpfile" -C "$INSTALL_DIR/app/" --strip-components=1
    fi

    rm -f "$tmpfile"
    log info "Application downloaded successfully"
}

# ---------------------------------------------------------------------------
# build_app() — npm ci and build the frontend
# ---------------------------------------------------------------------------
build_app() {
    log info "Building application..."

    export PATH="$INSTALL_DIR/runtime/node/bin:$INSTALL_DIR/runtime/bin:$PATH"
    cd "$INSTALL_DIR/app"

    log info "Running npm ci..."
    if ! "$INSTALL_DIR/runtime/node/bin/npm" ci; then
        if [ "$MODE" = "update" ]; then
            rollback
        fi
        die "npm ci failed"
    fi

    log info "Running npm run build..."
    if ! "$INSTALL_DIR/runtime/node/bin/npm" run build; then
        if [ "$MODE" = "update" ]; then
            rollback
        fi
        die "npm run build failed"
    fi

    if [ ! -f "$INSTALL_DIR/app/public/index.html" ]; then
        if [ "$MODE" = "update" ]; then
            rollback
        fi
        die "Build verification failed: public/index.html not found"
    fi

    log info "Application built successfully"
}

# ---------------------------------------------------------------------------
# configure_tmdb() — prompt for TMDB API key
# ---------------------------------------------------------------------------
configure_tmdb() {
    log info "Configuring TMDB API key..."

    # Skip if .env already has a non-empty TMDB_API_KEY
    if [ -f "$INSTALL_DIR/app/.env" ] && grep -qE '^TMDB_API_KEY=.+' "$INSTALL_DIR/app/.env"; then
        log info "TMDB API key already configured — skipping"
        return 0
    fi

    local TMDB_KEY=""

    # Check if key was passed via --tmdb-key flag
    if [ -n "${TMDB_API_KEY_ARG:-}" ]; then
        TMDB_KEY="$TMDB_API_KEY_ARG"
        log info "Using TMDB API key from --tmdb-key argument"
    elif [ "$NON_INTERACTIVE" = "true" ]; then
        log warn "No TMDB API key provided (non-interactive mode). Add it later to $INSTALL_DIR/app/.env"
        return 0
    else
        echo ""
        echo "Rattin uses The Movie Database (TMDB) for movie/TV metadata."
        echo "To get a free API key:"
        echo "  1. Create an account at https://www.themoviedb.org/signup"
        echo "  2. Go to https://www.themoviedb.org/settings/api"
        echo "  3. Request an API key (choose 'Developer' option)"
        echo ""

        read -rp "Paste your TMDB API key: " TMDB_KEY < /dev/tty
    fi

    if [ -z "$TMDB_KEY" ]; then
        log warn "No TMDB API key provided. You can add it later to $INSTALL_DIR/app/.env"
        return 0
    fi

    # Validate key by hitting the TMDB API
    local http_status
    if command -v curl >/dev/null 2>&1; then
        http_status="$(curl -s -o /dev/null -w '%{http_code}' "https://api.themoviedb.org/3/configuration?api_key=$TMDB_KEY")"
    elif command -v wget >/dev/null 2>&1; then
        http_status="$(wget --server-response --spider "https://api.themoviedb.org/3/configuration?api_key=$TMDB_KEY" 2>&1 | awk '/HTTP\//{print $2}' | tail -1)"
    fi

    if [ "$http_status" != "200" ]; then
        log warn "TMDB API key appears invalid (HTTP $http_status), but saving it anyway. You can fix it later in $INSTALL_DIR/app/.env"
    else
        log info "TMDB API key validated successfully"
    fi

    if [ -f "$INSTALL_DIR/app/.env" ]; then
        # Remove existing TMDB_API_KEY line if present, then append
        sed -i '/^TMDB_API_KEY=/d' "$INSTALL_DIR/app/.env"
    fi
    echo "TMDB_API_KEY=$TMDB_KEY" >> "$INSTALL_DIR/app/.env"
    log info "TMDB API key saved to $INSTALL_DIR/app/.env"
}

# ---------------------------------------------------------------------------
# set_permissions() — set ownership and file permissions
# ---------------------------------------------------------------------------
set_permissions() {
    log info "Setting permissions..."

    chown -R rattin:rattin "$INSTALL_DIR"
    [ -f "$INSTALL_DIR/app/.env" ] && chmod 0600 "$INSTALL_DIR/app/.env"

    if [ "$SELINUX_ENFORCING" = "true" ]; then
        log info "Configuring SELinux contexts..."
        semanage fcontext -a -t bin_t "$INSTALL_DIR/runtime/node/bin(/.*)?" 2>/dev/null || true
        semanage fcontext -a -t bin_t "$INSTALL_DIR/runtime/bin(/.*)?" 2>/dev/null || true
        restorecon -Rv "$INSTALL_DIR/runtime/" 2>/dev/null || true
        semanage port -a -t http_port_t -p tcp 3000 2>/dev/null || true
    fi

    log info "Permissions set successfully"
}

# ---------------------------------------------------------------------------
# setup_service() — configure systemd service or manual launcher
# ---------------------------------------------------------------------------
setup_service() {
    log info "Configuring service..."

    local answer=""

    if [ "${NO_SERVICE_FLAG:-}" = "true" ] || [ "$NON_INTERACTIVE" = "true" ]; then
        answer="n"
        log info "Skipping service setup (non-interactive or --no-service)"
    else
        read -p "Start rattin automatically on boot? [Y/n]: " answer < /dev/tty || answer=""
    fi

    case "$answer" in
        [nN]|[nN][oO])
            USE_SERVICE=false
            log info "User declined auto-start — writing manual launcher"

            cat > "$INSTALL_DIR/start.sh" <<LAUNCHER
#!/bin/bash
export PATH="$INSTALL_DIR/runtime/node/bin:$INSTALL_DIR/runtime/bin:\$PATH"
export DOWNLOAD_PATH="$INSTALL_DIR/data/downloads"
export TRANSCODE_PATH="$INSTALL_DIR/data/transcoded"
export HOST="127.0.0.1"
cd $INSTALL_DIR/app
exec $INSTALL_DIR/app/node_modules/.bin/tsx --env-file=.env server.ts
LAUNCHER
            chmod +x "$INSTALL_DIR/start.sh"
            log info "Manual launcher written to $INSTALL_DIR/start.sh"
            return 0
            ;;
        *)
            USE_SERVICE=true
            log info "Setting up systemd service..."
            ;;
    esac

    # Write rattin.service
    cat > /etc/systemd/system/rattin.service <<EOF
[Unit]
Description=Rattin
After=network.target

[Service]
Type=simple
User=rattin
Group=rattin
WorkingDirectory=$INSTALL_DIR/app
Environment=PATH=$INSTALL_DIR/runtime/node/bin:$INSTALL_DIR/runtime/bin:/usr/bin:/bin
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=DOWNLOAD_PATH=$INSTALL_DIR/data/downloads
Environment=TRANSCODE_PATH=$INSTALL_DIR/data/transcoded
ExecStart=$INSTALL_DIR/app/node_modules/.bin/tsx --env-file=.env server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

    # Write rattin-cleanup.timer
    cat > /etc/systemd/system/rattin-cleanup.timer <<'EOF'
[Unit]
Description=Clean old rattin data

[Timer]
OnCalendar=*-*-* */6:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

    # Write rattin-cleanup.service
    cat > /etc/systemd/system/rattin-cleanup.service <<EOF
[Unit]
Description=Clean old rattin data

[Service]
Type=oneshot
ExecStart=/usr/bin/find $INSTALL_DIR/data -type f -mmin +1440 -delete
ExecStart=/usr/bin/find $INSTALL_DIR/data -type d -empty -delete
EOF

    systemctl daemon-reload
    systemctl enable rattin
    systemctl enable rattin-cleanup.timer

    log info "Systemd service configured and enabled"
}

# ---------------------------------------------------------------------------
# start_and_verify() — start the app and health-check it
# ---------------------------------------------------------------------------
start_and_verify() {
    if [ "$USE_SERVICE" = "false" ]; then
        echo ""
        log info "To start Rattin, run: $INSTALL_DIR/start.sh"
        return 0
    fi

    log info "Starting rattin service..."
    systemctl start rattin

    log info "Waiting for health check..."
    local attempts=0
    while [ "$attempts" -lt 10 ]; do
        if command -v curl >/dev/null 2>&1; then
            if curl -sf http://localhost:3000 >/dev/null 2>&1; then
                log info "Health check passed"
                return 0
            fi
        elif command -v wget >/dev/null 2>&1; then
            if wget -qO /dev/null http://localhost:3000 2>/dev/null; then
                log info "Health check passed"
                return 0
            fi
        fi
        attempts=$((attempts + 1))
        sleep 2
    done

    log warn "Health check failed after 10 attempts. Service may still be starting."
    log warn "Recent logs:"
    journalctl -u rattin --no-pager -n 20 2>/dev/null || true

    if [ "$MODE" = "update" ]; then
        rollback
        systemctl start rattin 2>/dev/null || true
        die "Update failed. Rolled back to previous version."
    else
        log warn "Fresh install health check failed. The app may need a manual restart."
    fi
}

# ---------------------------------------------------------------------------
# print_success() — display final success banner
# ---------------------------------------------------------------------------
print_success() {
    echo ""
    echo "============================================"
    echo "  Rattin installed successfully!"
    echo "============================================"
    echo ""
    echo "  URL:        http://localhost:3000"
    echo "  Install:    $INSTALL_DIR"
    echo "  Data:       $INSTALL_DIR/data"
    echo "  Config:     $INSTALL_DIR/app/.env"

    if [ "$USE_SERVICE" = "true" ]; then
        echo "  Logs:       journalctl -u rattin"
    else
        echo "  Start:      $INSTALL_DIR/start.sh"
        echo "  Logs:       (run start.sh to see output)"
    fi

    echo "  Uninstall:  curl -fsSL https://raw.githubusercontent.com/rattin-player/rattin-public/main/install.sh | sudo bash -s -- --uninstall"
    echo ""
    echo "============================================"
    echo ""
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

    # Create directory structure (on fresh install; dirs already exist on update)
    if [ "$MODE" = "fresh" ]; then
        create_user
        create_dirs
    fi

    install_node
    install_ffmpeg
    install_fpcalc
    install_build_tools
    install_app
    build_app

    if [ "$MODE" = "fresh" ]; then
        configure_tmdb
    fi

    set_permissions
    setup_service
    start_and_verify

    # Mark as installer-managed
    echo "$INSTALLER_VERSION" > "$INSTALL_DIR/.installer-version"

    # Clean up backups on successful update
    if [ "$MODE" = "update" ]; then
        rm -rf "$INSTALL_DIR/app.bak"
        rm -rf "$INSTALL_DIR/runtime/node.bak"
        log info "Update backups cleaned up"
    fi

    print_success
}

main
