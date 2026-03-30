#!/usr/bin/env bash
# Run installer integration tests across all supported distros via Docker.
# Completely isolated and idempotent — each run builds fresh containers.
#
# Usage:
#   ./install/test/run-tests.sh              # test all distros
#   ./install/test/run-tests.sh ubuntu-24.04 # test one distro
#   ./install/test/run-tests.sh --cleanup    # remove test images
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_PREFIX="rattin-installer-test"

DISTROS=(
    "ubuntu-24.04"
    "ubuntu-22.04"
    "debian-12"
    "fedora-40"
)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ---------------------------------------------------------------------------
# Cleanup mode
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--cleanup" ]; then
    echo "Cleaning up test images..."
    for distro in "${DISTROS[@]}"; do
        docker rmi "$IMAGE_PREFIX:$distro" 2>/dev/null && echo "  Removed $IMAGE_PREFIX:$distro" || true
    done
    echo "Done."
    exit 0
fi

# ---------------------------------------------------------------------------
# Filter distros if argument provided
# ---------------------------------------------------------------------------
if [ $# -gt 0 ] && [ "$1" != "--cleanup" ]; then
    DISTROS=("$1")
    if [ ! -f "$SCRIPT_DIR/Dockerfile.${DISTROS[0]}" ]; then
        echo "Error: No Dockerfile found for '${DISTROS[0]}'"
        echo "Available: ubuntu-24.04, ubuntu-22.04, debian-12, fedora-40"
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    echo "Error: Docker is not installed or not in PATH"
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "Error: Docker daemon is not running"
    exit 1
fi

echo ""
echo "============================================"
echo "  Rattin Installer — Integration Tests"
echo "============================================"
echo ""
echo "Distros to test: ${DISTROS[*]}"
echo ""

RESULTS=()
TOTAL_PASS=0
TOTAL_FAIL=0

for distro in "${DISTROS[@]}"; do
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Testing: $distro"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    IMAGE="$IMAGE_PREFIX:$distro"
    CONTAINER="$IMAGE_PREFIX-$distro-$$"

    # Build the test image
    echo "Building image..."
    if ! docker build \
        -f "$SCRIPT_DIR/Dockerfile.$distro" \
        -t "$IMAGE" \
        "$REPO_ROOT" \
        2>&1 | tail -5; then
        echo -e "${RED}FAIL${NC}: Docker build failed for $distro"
        RESULTS+=("$distro: BUILD FAILED")
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
        echo ""
        continue
    fi
    echo ""

    # Phase 1: Run the installer
    echo "Phase 1: Running installer..."
    INSTALL_EXIT=0
    docker run \
        --name "$CONTAINER" \
        "$IMAGE" \
        2>&1 | tee /tmp/installer-output-$distro.log || INSTALL_EXIT=$?

    if [ "$INSTALL_EXIT" -ne 0 ]; then
        echo -e "${RED}FAIL${NC}: Installer exited with code $INSTALL_EXIT on $distro"
        echo "  Full log: /tmp/installer-output-$distro.log"
        RESULTS+=("$distro: INSTALL FAILED (exit $INSTALL_EXIT)")
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
        docker rm "$CONTAINER" 2>/dev/null || true
        echo ""
        continue
    fi
    echo ""

    # Phase 2: Commit the container state and run verification
    echo "Phase 2: Running verification..."
    VERIFY_IMAGE="$IMAGE-verify"
    docker commit "$CONTAINER" "$VERIFY_IMAGE" >/dev/null 2>&1

    VERIFY_EXIT=0
    docker run \
        --rm \
        -v "$SCRIPT_DIR/verify.sh:/tmp/verify.sh:ro" \
        "$VERIFY_IMAGE" \
        bash /tmp/verify.sh \
        2>&1 | tee /tmp/verify-output-$distro.log || VERIFY_EXIT=$?

    # Cleanup
    docker rm "$CONTAINER" 2>/dev/null || true
    docker rmi "$VERIFY_IMAGE" 2>/dev/null || true

    if [ "$VERIFY_EXIT" -eq 0 ]; then
        echo -e "${GREEN}PASS${NC}: $distro"
        RESULTS+=("$distro: PASS")
        TOTAL_PASS=$((TOTAL_PASS + 1))
    else
        echo -e "${RED}FAIL${NC}: $distro — verification failed"
        echo "  Install log:  /tmp/installer-output-$distro.log"
        echo "  Verify log:   /tmp/verify-output-$distro.log"
        RESULTS+=("$distro: VERIFY FAILED")
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
    fi
    echo ""
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================"
echo "  Integration Test Results"
echo "============================================"
echo ""
for result in "${RESULTS[@]}"; do
    if echo "$result" | grep -q "PASS"; then
        echo -e "  ${GREEN}✓${NC} $result"
    else
        echo -e "  ${RED}✗${NC} $result"
    fi
done
echo ""
echo "  Total: $TOTAL_PASS passed, $TOTAL_FAIL failed"
echo "============================================"
echo ""

if [ "$TOTAL_FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
