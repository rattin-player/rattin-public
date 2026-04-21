# AppImage runtime validator

Second tier of the two-tier AppImage release gate (first tier is
`ldd_audit` in `install/build-appimage.sh`). Runs in CI on every tag
push under `.github/workflows/release.yml`'s `validate-linux` matrix.

## What it does

`validator.sh <path-to-appimage>`:

1. Launches the AppImage under `xvfb` with `QTWEBENGINE_REMOTE_DEBUGGING=127.0.0.1:9222`.
2. Stage 1 (bash, 60 s budget): polls the server on `:9630`, the CDP
   endpoint on `:9222`, asserts `rattin-shell` + `QtWebEngineProcess` are
   in the process tree, greps `stderr` for loader/crash/symbol patterns.
3. Stage 2 (`cdp-check.mjs`): connects to the page target over raw CDP
   WebSocket, asserts React mounted and the first-run `TMDB API Key
   Required` overlay rendered, checks for uncaught JS errors in a 2 s
   mount window.

Playwright's `connectOverCDP` is avoided because it unconditionally
calls `Browser.setDownloadBehavior`, which Qt's embedded DevTools
doesn't implement — the raw CDP client does only what this test needs.

Diagnostics land in `/tmp/rattin-validator/` (stdout, stderr, ps tree).

## Local reproduction

Build the AppImage once (`bash install/build-appimage.sh --clean` from the
repo root), then run it through the validator inside each distro container.

Authoritative dep lists live in `.github/workflows/release.yml` under the
`validate-linux` matrix — keep the README examples in sync with that.

### Ubuntu 22.04 / 24.04

```
docker run --rm --shm-size=2g -v "$PWD:/w" -w /w ubuntu:22.04 bash -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends \
    git curl ca-certificates xvfb libfuse2 \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libgl1 libopengl0 libegl1 libglx0 \
    libfontconfig1 libfreetype6 libharfbuzz0b libfribidi0 \
    libexpat1 libcom-err2 libgmp10 libgpg-error0 libusb-1.0-0 \
    libwayland-client0 libasound2
  # cdp-check.mjs needs fetch() — Node 18+. 22.04 ships Node 12.
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y --no-install-recommends nodejs
  cd test/appimage && npm ci
  cd /w && bash test/appimage/validator.sh /w/Rattin-x86_64.AppImage
'
```

On 24.04 swap `ubuntu:22.04` → `ubuntu:24.04` and `libasound2` → `libasound2t64`
(24.04 ships Node 18, so the NodeSource step is optional there).

### Fedora 40

```
docker run --rm --shm-size=2g -v "$PWD:/w" -w /w fedora:40 bash -c '
  dnf install -y --setopt=install_weak_deps=False \
    git curl ca-certificates procps-ng xorg-x11-server-Xvfb fuse-libs nodejs npm \
    nss nspr atk at-spi2-atk cups-libs libdrm libxkbcommon \
    libXcomposite libXdamage libXfixes libXrandr mesa-libgbm mesa-dri-drivers alsa-lib \
    libglvnd-opengl libglvnd-egl libglvnd-glx mesa-libGL \
    fontconfig freetype harfbuzz fribidi \
    expat libcom_err gmp libgpg-error libusbx libwayland-client
  cd test/appimage && npm ci
  cd /w && bash test/appimage/validator.sh /w/Rattin-x86_64.AppImage
'
```

### Arch Linux

```
docker run --rm --shm-size=2g -v "$PWD:/w" -w /w archlinux:latest bash -c '
  pacman -Sy --noconfirm --needed \
    git curl ca-certificates xorg-server-xvfb fuse2 nodejs npm \
    nss nspr atk at-spi2-atk cups libdrm libxkbcommon libxcomposite \
    libxdamage libxfixes libxrandr mesa alsa-lib \
    libglvnd fontconfig freetype2 harfbuzz fribidi \
    expat e2fsprogs gmp libgpg-error libusb wayland
  cd test/appimage && npm ci
  cd /w && bash test/appimage/validator.sh /w/Rattin-x86_64.AppImage
'
```

## Deliberate-break canary

Once the validator is green on all four distros, verify it actually
catches breakage by deliberately corrupting a bundled lib:

```
patchelf --replace-needed libavcodec.so.61 libdoesnotexist.so.0 \
  build-appimage/AppDir/usr/lib/libmpv.so.2
bash install/build-appimage.sh          # re-packages with broken lib
# Run any of the docker one-liners above; validator should exit 1.
```

The NEEDED name (`libavcodec.so.61` above) may differ between build
hosts — pick any entry from `readelf -d build-appimage/AppDir/usr/lib/libmpv.so.2 | grep NEEDED`.

Then revert with a clean rebuild: `bash install/build-appimage.sh --clean`.

## Updating Playwright

Chromium revision is pinned implicitly by the `@playwright/test` version
in `package.json`. Bumps must be deliberate:

```
cd test/appimage
npm i -E @playwright/test@<new-version>
npx playwright install chromium
```

Commit `package.json` + `package-lock.json` together and re-run the
docker matrix above before merging.
