#!/usr/bin/env bash
# ==============================================================================
# Tests for install.sh — uninstall and wipe-before-reinstall logic
# Run with: bash install/test_install.sh
# ==============================================================================
set -euo pipefail

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SCRIPT="$SCRIPT_DIR/install.sh"

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

# ---------------------------------------------------------------------------
# Helper: create a temp environment with mocked system commands
# ---------------------------------------------------------------------------
setup_mock_env() {
    local tmpdir
    tmpdir="$(mktemp -d)"
    local mock_bin="$tmpdir/bin"
    local install_dir="$tmpdir/install"
    local systemd_dir="$tmpdir/systemd"
    mkdir -p "$mock_bin" "$install_dir" "$systemd_dir"

    # Mock: systemctl — record calls
    cat > "$mock_bin/systemctl" <<MOCKEOF
#!/bin/bash
echo "systemctl \$*" >> "$tmpdir/calls.log"
exit 0
MOCKEOF
    chmod +x "$mock_bin/systemctl"

    # Mock: userdel — record calls
    cat > "$mock_bin/userdel" <<MOCKEOF
#!/bin/bash
echo "userdel \$*" >> "$tmpdir/calls.log"
exit 0
MOCKEOF
    chmod +x "$mock_bin/userdel"

    # Mock: id — always root
    cat > "$mock_bin/id" <<'MOCKEOF'
#!/bin/bash
if [ "$1" = "-u" ]; then echo 0; else /usr/bin/id "$@"; fi
MOCKEOF
    chmod +x "$mock_bin/id"

    # Mock: flock — always succeed
    cat > "$mock_bin/flock" <<'MOCKEOF'
#!/bin/bash
exit 0
MOCKEOF
    chmod +x "$mock_bin/flock"

    touch "$tmpdir/calls.log"
    echo "$tmpdir"
}

# ---------------------------------------------------------------------------
# Helper: create a patched version of install.sh with test-safe paths
# ---------------------------------------------------------------------------
patch_script() {
    local tmpdir="$1"
    local install_dir="$tmpdir/install"
    local systemd_dir="$tmpdir/systemd"

    sed \
        -e "s|INSTALL_DIR=\"/opt/rattin\"|INSTALL_DIR=\"$install_dir\"|" \
        -e "s|/etc/systemd/system|$systemd_dir|g" \
        "$INSTALL_SCRIPT"
}

# ---------------------------------------------------------------------------
# Helper: run the patched install.sh with mocked PATH
# ---------------------------------------------------------------------------
run_patched() {
    local tmpdir="$1"
    shift
    local patched
    patched="$(patch_script "$tmpdir")"
    PATH="$tmpdir/bin:$PATH" bash -c "$patched" -- "$@" 2>&1 || true
}

# ---------------------------------------------------------------------------
# Test 1: --uninstall prints success message
# ---------------------------------------------------------------------------
echo "Test 1: --uninstall prints success message"
tmpdir="$(setup_mock_env)"
output="$(run_patched "$tmpdir" --uninstall)"
if echo "$output" | grep -q "Rattin uninstalled successfully"; then
    pass "--uninstall prints success message"
else
    fail "--uninstall did not print success message. Output: $output"
fi
rm -rf "$tmpdir"

# ---------------------------------------------------------------------------
# Test 2: --uninstall calls systemctl stop, disable, daemon-reload
# ---------------------------------------------------------------------------
echo "Test 2: --uninstall calls expected systemctl commands"
tmpdir="$(setup_mock_env)"
run_patched "$tmpdir" --uninstall >/dev/null
calls="$(cat "$tmpdir/calls.log")"

if echo "$calls" | grep -q "systemctl stop rattin"; then
    pass "systemctl stop called"
else
    fail "systemctl stop not called. Calls: $calls"
fi
if echo "$calls" | grep -q "systemctl disable rattin"; then
    pass "systemctl disable called"
else
    fail "systemctl disable not called. Calls: $calls"
fi
if echo "$calls" | grep -q "systemctl daemon-reload"; then
    pass "systemctl daemon-reload called"
else
    fail "systemctl daemon-reload not called. Calls: $calls"
fi
rm -rf "$tmpdir"

# ---------------------------------------------------------------------------
# Test 3: --uninstall calls userdel
# ---------------------------------------------------------------------------
echo "Test 3: --uninstall calls userdel"
tmpdir="$(setup_mock_env)"
run_patched "$tmpdir" --uninstall >/dev/null
calls="$(cat "$tmpdir/calls.log")"

if echo "$calls" | grep -q "userdel rattin"; then
    pass "userdel rattin called"
else
    fail "userdel not called. Calls: $calls"
fi
rm -rf "$tmpdir"

# ---------------------------------------------------------------------------
# Test 4: --uninstall removes the install directory
# ---------------------------------------------------------------------------
echo "Test 4: --uninstall removes install directory"
tmpdir="$(setup_mock_env)"
install_dir="$tmpdir/install"
mkdir -p "$install_dir/app"
echo "data" > "$install_dir/app/test.txt"

run_patched "$tmpdir" --uninstall >/dev/null

if [ ! -d "$install_dir/app" ]; then
    pass "install directory contents removed"
else
    fail "install directory still has contents"
fi
rm -rf "$tmpdir"

# ---------------------------------------------------------------------------
# Test 5: --uninstall removes systemd unit files
# ---------------------------------------------------------------------------
echo "Test 5: --uninstall removes systemd unit files"
tmpdir="$(setup_mock_env)"
systemd_dir="$tmpdir/systemd"
touch "$systemd_dir/rattin.service"
touch "$systemd_dir/rattin-cleanup.service"
touch "$systemd_dir/rattin-cleanup.timer"

run_patched "$tmpdir" --uninstall >/dev/null

if [ ! -f "$systemd_dir/rattin.service" ] && \
   [ ! -f "$systemd_dir/rattin-cleanup.service" ] && \
   [ ! -f "$systemd_dir/rattin-cleanup.timer" ]; then
    pass "systemd unit files removed"
else
    fail "some systemd unit files still exist"
fi
rm -rf "$tmpdir"

# ---------------------------------------------------------------------------
# Test 6: --uninstall skips preflight
# ---------------------------------------------------------------------------
echo "Test 6: --uninstall skips preflight"
tmpdir="$(setup_mock_env)"
output="$(run_patched "$tmpdir" --uninstall)"

if echo "$output" | grep -q "Rattin uninstalled successfully" && \
   ! echo "$output" | grep -q "Running preflight"; then
    pass "--uninstall skips preflight"
else
    fail "--uninstall should skip preflight. Output: $output"
fi
rm -rf "$tmpdir"

# ---------------------------------------------------------------------------
# Test 7: Non-root user is rejected
# ---------------------------------------------------------------------------
echo "Test 7: non-root user is rejected"
tmpdir="$(setup_mock_env)"
# Override id mock to return non-root
cat > "$tmpdir/bin/id" <<'EOF'
#!/bin/bash
if [ "$1" = "-u" ]; then echo 1000; else /usr/bin/id "$@"; fi
EOF
chmod +x "$tmpdir/bin/id"

output="$(run_patched "$tmpdir" --uninstall)"
if echo "$output" | grep -q "must be run as root"; then
    pass "non-root rejected"
else
    fail "non-root not rejected. Output: $output"
fi
rm -rf "$tmpdir"

# ---------------------------------------------------------------------------
# Test 8: --uninstall flag is parsed correctly
# ---------------------------------------------------------------------------
echo "Test 8: --uninstall flag parsing"
output="$(bash "$INSTALL_SCRIPT" --help 2>&1)" || true
if echo "$output" | grep -q "uninstall"; then
    pass "--help mentions --uninstall"
else
    fail "--help doesn't mention --uninstall"
fi

# ---------------------------------------------------------------------------
# Test 9: Script structure — root check before acquire_lock in main()
# ---------------------------------------------------------------------------
echo "Test 9: root check is before acquire_lock in main()"
main_body="$(sed -n '/^main()/,/^}/p' "$INSTALL_SCRIPT")"
root_line="$(echo "$main_body" | grep -n 'id -u' | head -1 | cut -d: -f1)"
lock_line="$(echo "$main_body" | grep -n 'acquire_lock' | head -1 | cut -d: -f1)"
if [ -n "$root_line" ] && [ -n "$lock_line" ] && [ "$root_line" -lt "$lock_line" ]; then
    pass "root check before acquire_lock"
else
    fail "root check not before acquire_lock (root=$root_line, lock=$lock_line)"
fi

# ---------------------------------------------------------------------------
# Test 10: Script structure — uninstall check before preflight in main()
# ---------------------------------------------------------------------------
echo "Test 10: uninstall check before preflight in main()"
main_body="$(sed -n '/^main()/,/^}/p' "$INSTALL_SCRIPT")"
uninstall_line="$(echo "$main_body" | grep -n 'UNINSTALL' | head -1 | cut -d: -f1)"
preflight_line="$(echo "$main_body" | grep -n '^\s*preflight$' | head -1 | cut -d: -f1)"
if [ -n "$uninstall_line" ] && [ -n "$preflight_line" ] && [ "$uninstall_line" -lt "$preflight_line" ]; then
    pass "uninstall before preflight"
else
    fail "uninstall not before preflight (uninstall=$uninstall_line, preflight=$preflight_line)"
fi

# ---------------------------------------------------------------------------
# Test 11: Script structure — wipe mode sets MODE=fresh
# ---------------------------------------------------------------------------
echo "Test 11: wipe mode sets MODE=fresh"
main_body="$(sed -n '/^main()/,/^}/p' "$INSTALL_SCRIPT")"
if echo "$main_body" | grep -q 'MODE.*=.*"wipe"' && \
   echo "$main_body" | grep -q 'MODE="fresh"'; then
    pass "wipe mode handling present"
else
    fail "wipe mode handling missing"
fi

# ---------------------------------------------------------------------------
# Test 12: preflight no longer contains root check
# ---------------------------------------------------------------------------
echo "Test 12: preflight() does not contain root check"
preflight_body="$(sed -n '/^preflight()/,/^}/p' "$INSTALL_SCRIPT")"
if echo "$preflight_body" | grep -q 'id -u'; then
    fail "preflight still contains root check"
else
    pass "root check removed from preflight"
fi

# ---------------------------------------------------------------------------
# Test 13: Syntax check
# ---------------------------------------------------------------------------
echo "Test 13: install.sh has valid syntax"
if bash -n "$INSTALL_SCRIPT" 2>&1; then
    pass "syntax valid"
else
    fail "syntax errors found"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed"
echo "================================"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
