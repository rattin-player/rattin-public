#!/usr/bin/env bash
# Per-container AppImage runtime validator.
#
# Stage 1 (bash gate, ~60s budget): launch the AppImage under xvfb with
# QtWebEngine remote debugging on :9222; poll server/CDP endpoints, assert
# required processes are alive, grep stderr for known loader/crash patterns.
#
# Stage 2 (Playwright, only if stage 1 passed): `npx playwright test` runs
# appimage.spec.ts which connects over CDP and exercises the live UI.
#
# Diagnostics (stdout/stderr/ps snapshot) live under /tmp/rattin-validator
# for upload via actions/upload-artifact on failure.

set -euo pipefail

APPIMAGE="${1:?usage: validator.sh <path-to-appimage>}"
APPIMAGE="$(readlink -f "$APPIMAGE")"
[ -f "$APPIMAGE" ] || { echo "validator.sh: not found: $APPIMAGE" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="${WORKDIR:-/tmp/rattin-validator}"
STDOUT_LOG="$WORKDIR/stdout.log"
STDERR_LOG="$WORKDIR/stderr.log"
PS_SNAPSHOT="$WORKDIR/ps.txt"

mkdir -p "$WORKDIR"
: > "$STDOUT_LOG"
: > "$STDERR_LOG"
: > "$PS_SNAPSHOT"

chmod +x "$APPIMAGE"

# Extract-and-run: AppImage's default FUSE mount doesn't work in all
# container runtimes. CDP flags expose the Chromium remote debug endpoint
# that appimage.spec.ts connects to.
export APPIMAGE_EXTRACT_AND_RUN=1
export QTWEBENGINE_REMOTE_DEBUGGING="127.0.0.1:9222"
export QTWEBENGINE_CHROMIUM_FLAGS="--remote-allow-origins=*"

APP_PID=""

dump_diagnostics() {
    echo "=================== stderr.log (tail -100) ==================="
    tail -n 100 "$STDERR_LOG" 2>/dev/null || true
    echo "=================== stdout.log (tail -100) ==================="
    tail -n 100 "$STDOUT_LOG" 2>/dev/null || true
    echo "=================== ps.txt =================================="
    cat "$PS_SNAPSHOT" 2>/dev/null || true
    echo "=============================================================="
}

cleanup() {
    if [ -n "$APP_PID" ]; then
        # Negative PID addresses the entire process group (setsid gave us one).
        kill -TERM -- "-$APP_PID" 2>/dev/null || true
        sleep 3
        kill -KILL -- "-$APP_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

# Launch in its own process group so cleanup can reap Qt + QtWebEngineProcess
# + the Node server + xvfb all together.
setsid xvfb-run --auto-servernum --server-args="-screen 0 1280x720x24" \
    "$APPIMAGE" >"$STDOUT_LOG" 2>"$STDERR_LOG" &
APP_PID=$!
echo "launched AppImage pid=$APP_PID"

# -------- Stage 1: bash gate -------------------------------------------------

wait_for() {
    local label="$1" check="$2" budget="$3"
    local deadline=$(( $(date +%s) + budget ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if eval "$check"; then
            echo "  [ok] $label"
            return 0
        fi
        if ! kill -0 "$APP_PID" 2>/dev/null; then
            echo "::error::app process died while waiting for: $label"
            return 1
        fi
        sleep 1
    done
    echo "::error::timed out (${budget}s) waiting for: $label"
    return 1
}

echo "---- stage 1: startup gate ----"

wait_for "server log: 'Rattin running at'" \
    'grep -q "Rattin running at" "$STDOUT_LOG"' 30 \
    || { dump_diagnostics; exit 1; }

wait_for "http 200 on http://127.0.0.1:9630" \
    '[ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9630 || true)" = "200" ]' 10 \
    || { dump_diagnostics; exit 1; }

wait_for "http 200 on http://127.0.0.1:9222/json/version" \
    '[ "$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9222/json/version || true)" = "200" ]' 15 \
    || { dump_diagnostics; exit 1; }

# Process tree snapshot for the artifact, plus presence assertions.
ps -ef --forest > "$PS_SNAPSHOT" 2>&1 || true
if ! grep -q "rattin-shell" "$PS_SNAPSHOT"; then
    echo "::error::rattin-shell not found in process tree"
    dump_diagnostics; exit 1
fi
if ! grep -q "QtWebEngineProcess" "$PS_SNAPSHOT"; then
    echo "::error::QtWebEngineProcess not found in process tree"
    dump_diagnostics; exit 1
fi
echo "  [ok] rattin-shell + QtWebEngineProcess alive"

# Known loader / crash / symbol patterns in stderr.
pattern_file="$(mktemp)"
cat > "$pattern_file" <<'EOF'
error while loading shared libraries
cannot open shared object file
undefined symbol
version `GLIBC_.*' not found
Could not load Qt platform plugin
QtWebEngineProcess: crashed
Failed to create OpenGL context
Segmentation fault
SIGABRT
SIGILL
EOF
if grep -E -f "$pattern_file" "$STDERR_LOG"; then
    rm -f "$pattern_file"
    echo "::error::loader / crash / symbol pattern matched in stderr"
    dump_diagnostics; exit 1
fi
rm -f "$pattern_file"
echo "  [ok] stderr clean of loader/crash/symbol patterns"

echo "---- stage 1 passed ----"

# -------- Stage 2: Playwright ------------------------------------------------

echo "---- stage 2: Playwright CDP check ----"
cd "$SCRIPT_DIR"
npx playwright test
echo "---- stage 2 passed ----"
