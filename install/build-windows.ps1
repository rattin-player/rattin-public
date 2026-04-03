#Requires -Version 7
<#
.SYNOPSIS
    Build Rattin for Windows — portable ZIP and optional NSIS installer.

.DESCRIPTION
    Downloads tools (Node.js, ffmpeg, libmpv), builds the Qt shell, assembles
    a distribution directory, and packages it. Idempotent — skips steps that
    are already done. Use -Clean to rebuild all.

    Prerequisites: Qt6 (with WebEngine) installed, CMake, MSVC 2022, Node.js 20+, npm.

.PARAMETER Clean
    Wipe build directory and rebuild everything.

.PARAMETER CI
    CI mode — skip interactive prompts, assume tools are pre-downloaded in workspace.
#>

param(
    [switch]$Clean,
    [switch]$CI
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = Split-Path -Parent $ScriptDir
$BuildDir   = Join-Path $RepoRoot "build-windows"
$ToolsDir   = Join-Path $BuildDir "tools"
$DistDir    = Join-Path $BuildDir "Rattin"
$AppDir     = Join-Path $DistDir  "app"

$NodeVersion = "20.18.1"
$AppName     = "Rattin"
$Arch        = "x64"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Log($msg)  { Write-Host "[INFO]  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "[WARN]  $msg" -ForegroundColor Yellow }
function Skip($msg) { Write-Host "[SKIP]  $msg" -ForegroundColor Cyan }
function Die($msg)  { Write-Host "[ERROR] $msg" -ForegroundColor Red; exit 1 }

# Read version from package.json
$Version = (Get-Content (Join-Path $RepoRoot "package.json") | ConvertFrom-Json).version
Log "Building Rattin v$Version"

# ---------------------------------------------------------------------------
# Clean
# ---------------------------------------------------------------------------
if ($Clean -and (Test-Path $BuildDir)) {
    Log "Cleaning build directory"
    Remove-Item -Recurse -Force $BuildDir
}

New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
New-Item -ItemType Directory -Force -Path $DistDir  | Out-Null

# ---------------------------------------------------------------------------
# Step 1: Download tools
# ---------------------------------------------------------------------------

# Node.js
$NodeDir = Join-Path $ToolsDir "node"
$NodeExe = Join-Path $NodeDir "node.exe"
if (Test-Path $NodeExe) {
    Skip "Node.js already downloaded"
} else {
    Log "Downloading Node.js $NodeVersion"
    $nodeZip = Join-Path $ToolsDir "node.zip"
    $nodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-$Arch.zip"
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip
    Expand-Archive $nodeZip -DestinationPath $ToolsDir -Force
    Rename-Item (Join-Path $ToolsDir "node-v$NodeVersion-win-$Arch") $NodeDir
    Remove-Item $nodeZip
}

# libmpv (from shinchiro/mpv-winbuild-cmake GitHub releases)
$MpvDir = Join-Path $ToolsDir "mpv"
$MpvDll = Join-Path $MpvDir "libmpv-2.dll"
if (Test-Path $MpvDll) {
    Skip "libmpv already downloaded"
} else {
    Log "Downloading libmpv dev build"
    $mpv7z = Join-Path $ToolsDir "mpv-dev.7z"
    $mpvUrl = (gh api repos/shinchiro/mpv-winbuild-cmake/releases/latest --jq '.assets[] | select(.name | test("mpv-dev-x86_64-[0-9]")) | .browser_download_url' | Select-Object -First 1)
    Log "URL: $mpvUrl"
    Invoke-WebRequest -Uri $mpvUrl -OutFile $mpv7z
    New-Item -ItemType Directory -Force -Path $MpvDir | Out-Null
    & 7z x $mpv7z -o"$MpvDir" -y
    Remove-Item $mpv7z
}

# rcedit (for branding node.exe)
$RceditExe = Join-Path $ToolsDir "rcedit.exe"
if (Test-Path $RceditExe) {
    Skip "rcedit already downloaded"
} else {
    Log "Downloading rcedit"
    Invoke-WebRequest -Uri "https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe" -OutFile $RceditExe
}

# ---------------------------------------------------------------------------
# Step 2: Build frontend
# ---------------------------------------------------------------------------
$PublicIndex = Join-Path $RepoRoot "public/index.html"
if (Test-Path $PublicIndex) {
    Skip "Frontend already built"
} else {
    Log "Building frontend"
    Push-Location $RepoRoot
    & npm ci
    & npm run build
    Pop-Location
}

# ---------------------------------------------------------------------------
# Step 3: Build Qt shell
# ---------------------------------------------------------------------------
$ShellExe = Join-Path $RepoRoot "shell/build/Release/rattin-shell.exe"
if (Test-Path $ShellExe) {
    Skip "Qt shell already built"
} else {
    Log "Building Qt shell"
    $shellBuild = Join-Path $RepoRoot "shell/build"
    New-Item -ItemType Directory -Force -Path $shellBuild | Out-Null
    Push-Location $shellBuild
    & cmake -G "Visual Studio 17 2022" -A x64 `
        -DMPV_PREFIX="$MpvDir" `
        ..
    & cmake --build . --config Release
    Pop-Location
}

# ---------------------------------------------------------------------------
# Step 4: Assemble distribution
# ---------------------------------------------------------------------------
Log "Assembling distribution directory"

# Clean dist
if (Test-Path $DistDir) { Remove-Item -Recurse -Force $DistDir }
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
New-Item -ItemType Directory -Force -Path $AppDir  | Out-Null

# Qt shell + icon
Copy-Item $ShellExe $DistDir
Copy-Item (Join-Path $RepoRoot "packaging/windows/rattin.ico") $DistDir

# Run windeployqt to gather Qt DLLs
Log "Running windeployqt"
$windeployqt = Get-Command windeployqt6 -ErrorAction SilentlyContinue
if (-not $windeployqt) {
    $windeployqt = Get-Command windeployqt -ErrorAction SilentlyContinue
}
if ($windeployqt) {
    & $windeployqt.Source (Join-Path $DistDir "rattin-shell.exe") `
        --qmldir (Join-Path $RepoRoot "shell") `
        --release --no-translations
} else {
    Warn "windeployqt not found — Qt DLLs must be copied manually"
}

# Node.js → branded as rattin-runtime.exe
Copy-Item $NodeExe $DistDir
$RuntimeExe = Join-Path $DistDir "rattin-runtime.exe"
Rename-Item (Join-Path $DistDir "node.exe") $RuntimeExe
Log "Branding rattin-runtime.exe"
& $RceditExe $RuntimeExe `
    --set-icon (Join-Path $DistDir "rattin.ico") `
    --set-version-string "ProductName" "RattinRuntime" `
    --set-version-string "FileDescription" "Rattin Server Runtime" `
    --set-version-string "OriginalFilename" "rattin-runtime.exe" `
    --set-version-string "InternalName" "rattin-runtime" `
    --set-version-string "FileVersion" "$Version" `
    --set-version-string "ProductVersion" "$Version"

# libmpv DLL
Copy-Item $MpvDll $DistDir

# VC++ runtime DLLs
$vcDir = Join-Path $env:VCToolsRedistDir "x64\Microsoft.VC143.CRT"
if (Test-Path $vcDir) {
    foreach ($dll in @("vcruntime140.dll","vcruntime140_1.dll","msvcp140.dll")) {
        $src = Join-Path $vcDir $dll
        if (Test-Path $src) { Copy-Item $src $DistDir }
    }
    Log "Bundled VC++ runtime DLLs"
} else {
    Warn "VCToolsRedistDir not found — VC++ runtime DLLs not bundled"
}

# Bundle server into a single JS file with esbuild
Log "Bundling server with esbuild"
Push-Location $RepoRoot
& npx esbuild server.ts --bundle --platform=node --format=esm `
    --outfile=compiled/server.js `
    --external:utp-native --external:node-datachannel `
    --external:bufferutil --external:utf-8-validate `
    --target=node20 `
    "--banner:js=import{createRequire}from'module';const require=createRequire(import.meta.url);"
Pop-Location

# App code — single bundled server.js + static assets
foreach ($item in @("package.json", "package-lock.json")) {
    $src = Join-Path $RepoRoot $item
    if (Test-Path $src) { Copy-Item $src (Join-Path $AppDir $item) }
}
Copy-Item (Join-Path $RepoRoot "compiled/server.js") (Join-Path $AppDir "server.js")
Copy-Item (Join-Path $RepoRoot "public") (Join-Path $AppDir "public") -Recurse

# Production node_modules
Log "Installing production dependencies"
Push-Location $AppDir
& $RuntimeExe (Join-Path $NodeDir "node_modules/npm/bin/npm-cli.js") ci --omit=dev
Pop-Location

# ---------------------------------------------------------------------------
# Step 5: Create portable ZIP
# ---------------------------------------------------------------------------
$zipOutput = Join-Path $RepoRoot "$AppName-$Arch-Portable.zip"
Log "Creating portable ZIP: $zipOutput"
if (Test-Path $zipOutput) { Remove-Item $zipOutput }
Compress-Archive -Path $DistDir -DestinationPath $zipOutput

# ---------------------------------------------------------------------------
# Step 6: NSIS installer (optional)
# ---------------------------------------------------------------------------
$makensis = Get-Command makensis -ErrorAction SilentlyContinue
$nsiScript = Join-Path $RepoRoot "packaging/windows/rattin.nsi"
if ($makensis -and (Test-Path $nsiScript)) {
    Log "Building NSIS installer"
    $setupOutput = Join-Path $RepoRoot "$AppName-$Arch-Setup.exe"
    $pluginDir = Join-Path $RepoRoot "packaging/windows/Plugins"
    & makensis /DVERSION="$Version" /DDIST_DIR="$DistDir" /DOUTPUT="$setupOutput" `
        /X"!addplugindir /x86-unicode $pluginDir\x86-unicode" `
        $nsiScript
    Log "Installer: $setupOutput"
} else {
    if (-not $makensis) { Warn "makensis not found — skipping NSIS installer" }
    if (-not (Test-Path $nsiScript)) { Warn "NSIS script not found at $nsiScript" }
}

Log "Build complete!"
Log "  Portable ZIP: $zipOutput"
if (Test-Path (Join-Path $RepoRoot "$AppName-$Arch-Setup.exe")) {
    Log "  Installer:    $(Join-Path $RepoRoot "$AppName-$Arch-Setup.exe")"
}
