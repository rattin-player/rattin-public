#!/usr/bin/env bash
# Post-install verification script — runs inside the container after install.sh
set -uo pipefail
# Note: no set -e — we want check() to continue on failures

INSTALL_DIR="/opt/rattin"
PASS=0
FAIL=0

check() {
    local desc="$1"
    shift
    if "$@" >/dev/null 2>&1; then
        echo "  PASS: $desc"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $desc"
        FAIL=$((FAIL + 1))
    fi
}

echo ""
echo "=== Post-Install Verification ==="
echo ""

# Directory structure
echo "--- Directory Structure ---"
check "Install dir exists" test -d "$INSTALL_DIR"
check "runtime/node/ exists" test -d "$INSTALL_DIR/runtime/node"
check "runtime/bin/ exists" test -d "$INSTALL_DIR/runtime/bin"
check "app/ exists" test -d "$INSTALL_DIR/app"
check "data/downloads/ exists" test -d "$INSTALL_DIR/data/downloads"
check "data/transcoded/ exists" test -d "$INSTALL_DIR/data/transcoded"
check ".installer-version exists" test -f "$INSTALL_DIR/.installer-version"

# Runtime binaries
echo ""
echo "--- Runtime Binaries ---"
check "node binary exists" test -x "$INSTALL_DIR/runtime/node/bin/node"
check "npm binary exists" test -f "$INSTALL_DIR/runtime/node/bin/npm"
check "ffmpeg binary exists" test -x "$INSTALL_DIR/runtime/bin/ffmpeg"
check "ffprobe binary exists" test -x "$INSTALL_DIR/runtime/bin/ffprobe"
check "node runs" "$INSTALL_DIR/runtime/node/bin/node" --version
check "ffmpeg runs" "$INSTALL_DIR/runtime/bin/ffmpeg" -version
check "ffprobe runs" "$INSTALL_DIR/runtime/bin/ffprobe" -version

# Node version
NODE_VER=$("$INSTALL_DIR/runtime/node/bin/node" --version 2>/dev/null || echo "none")
echo "  INFO: Node version: $NODE_VER"
check "node is v20.x" test "$(echo "$NODE_VER" | grep -c "^v20\.")" -gt 0

# App
echo ""
echo "--- Application ---"
check "server.ts exists" test -f "$INSTALL_DIR/app/server.ts"
check "package.json exists" test -f "$INSTALL_DIR/app/package.json"
check "node_modules/ exists" test -d "$INSTALL_DIR/app/node_modules"
check "public/index.html exists (frontend built)" test -f "$INSTALL_DIR/app/public/index.html"

# Config
echo ""
echo "--- Configuration ---"
check ".env exists" test -f "$INSTALL_DIR/app/.env"
check ".env contains TMDB_API_KEY" grep -q "^TMDB_API_KEY=" "$INSTALL_DIR/app/.env"

# Manual launcher (since we use --no-service)
echo ""
echo "--- Launcher ---"
check "start.sh exists" test -f "$INSTALL_DIR/start.sh"
check "start.sh is executable" test -x "$INSTALL_DIR/start.sh"

# System user
echo ""
echo "--- System User ---"
check "rattin user exists" id rattin

# Ownership
echo ""
echo "--- Permissions ---"
OWNER=$(stat -c '%U' "$INSTALL_DIR/app" 2>/dev/null || echo "unknown")
check "app/ owned by rattin" test "$OWNER" = "rattin"
if [ -f "$INSTALL_DIR/app/.env" ]; then
    PERMS=$(stat -c '%a' "$INSTALL_DIR/app/.env" 2>/dev/null || echo "unknown")
    check ".env permissions are 600" test "$PERMS" = "600"
fi

# fpcalc (best-effort — may not be installed on all distros)
echo ""
echo "--- Optional: fpcalc ---"
if command -v fpcalc >/dev/null 2>&1; then
    echo "  PASS: fpcalc is available"
    PASS=$((PASS + 1))
else
    echo "  SKIP: fpcalc not available (optional)"
fi

# Quick smoke test — start the app briefly and check it responds
echo ""
echo "--- Smoke Test (start app, check response) ---"
export PATH="$INSTALL_DIR/runtime/node/bin:$INSTALL_DIR/runtime/bin:$PATH"
export DOWNLOAD_PATH="$INSTALL_DIR/data/downloads"
export TRANSCODE_PATH="$INSTALL_DIR/data/transcoded"
export HOST="127.0.0.1"

cd "$INSTALL_DIR/app"

# Start server in background as rattin user (or root if user switch fails)
if command -v su >/dev/null 2>&1; then
    su -s /bin/bash rattin -c "
        export PATH='$INSTALL_DIR/runtime/node/bin:$INSTALL_DIR/runtime/bin:\$PATH'
        export DOWNLOAD_PATH='$INSTALL_DIR/data/downloads'
        export TRANSCODE_PATH='$INSTALL_DIR/data/transcoded'
        export HOST='127.0.0.1'
        cd '$INSTALL_DIR/app'
        '$INSTALL_DIR/app/node_modules/.bin/tsx' --env-file=.env server.ts 2>&1 &
    " 2>/dev/null || \
    "$INSTALL_DIR/app/node_modules/.bin/tsx" --env-file=.env server.ts &
else
    "$INSTALL_DIR/app/node_modules/.bin/tsx" --env-file=.env server.ts &
fi
APP_PID=$!

# Wait for app to start
STARTED=false
for i in $(seq 1 15); do
    if curl -sf http://localhost:3000 >/dev/null 2>&1; then
        STARTED=true
        break
    fi
    sleep 2
done

if [ "$STARTED" = "true" ]; then
    echo "  PASS: App responds at http://localhost:3000"
    PASS=$((PASS + 1))

    # Check we get HTML back
    RESPONSE=$(curl -sf http://localhost:3000 2>/dev/null || echo "")
    if echo "$RESPONSE" | grep -qi "html"; then
        echo "  PASS: Response contains HTML"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: Response does not contain HTML"
        FAIL=$((FAIL + 1))
    fi
else
    echo "  FAIL: App did not start within 30 seconds"
    FAIL=$((FAIL + 1))
fi

# Cleanup
kill "$APP_PID" 2>/dev/null || true
wait "$APP_PID" 2>/dev/null || true

# Summary
echo ""
echo "==================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "==================================="
echo ""

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
