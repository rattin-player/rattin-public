#Requires -Version 5.1
<#
.SYNOPSIS
    Rattin - Windows Installer
.DESCRIPTION
    Installs Rattin with bundled Node.js, ffmpeg, and WinSW service.
.PARAMETER Uninstall
    Remove rattin and all its components.
.EXAMPLE
    .\install.ps1
    .\install.ps1 -Uninstall
#>
param(
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$InstallerVersion = "1.0.0"
$InstallDir = "C:\Program Files\rattin"

# ==============================================================================
# Logging
# ==============================================================================
function Write-Log {
    param(
        [string]$Level,
        [string]$Message
    )
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    switch ($Level) {
        "info"  { Write-Host "[INFO]  $Message" -ForegroundColor Green }
        "warn"  { Write-Host "[WARN]  $Message" -ForegroundColor Yellow }
        "error" { Write-Host "[ERROR] $Message" -ForegroundColor Red }
    }
    # Append to install log
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }
    Add-Content -Path "$InstallDir\install.log" -Value "[$timestamp] [$Level] $Message"
}

function Write-Info  { param([string]$Message) Write-Log "info"  $Message }
function Write-Warn  { param([string]$Message) Write-Log "warn"  $Message }
function Write-Err   { param([string]$Message) Write-Log "error" $Message }

function Stop-WithError {
    param([string]$Message)
    Write-Err $Message
    exit 1
}

# ==============================================================================
# Lockfile (named mutex)
# ==============================================================================
$script:InstallerMutex = $null

function Get-InstallerLock {
    $script:InstallerMutex = [System.Threading.Mutex]::new($false, "Global\MagnetPlayerInstaller")
    try {
        if (-not $script:InstallerMutex.WaitOne(0)) {
            Stop-WithError "Another installer instance is already running."
        }
    } catch [System.Threading.AbandonedMutexException] {
        # Previous holder crashed — we now own it, continue
    }
}

function Release-InstallerLock {
    if ($script:InstallerMutex) {
        try { $script:InstallerMutex.ReleaseMutex() } catch { }
        $script:InstallerMutex.Dispose()
    }
}

# ==============================================================================
# Preflight
# ==============================================================================
function Test-Preflight {
    Write-Info "Running preflight checks (installer v$InstallerVersion)..."

    # 1. Admin check
    $currentPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Stop-WithError "This installer must be run as Administrator. Right-click PowerShell and select 'Run as administrator'."
    }
    Write-Info "Running as Administrator"

    # 2. Architecture
    if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
        Stop-WithError "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE. Only AMD64 (x86_64) is supported."
    }
    Write-Info "Architecture: $env:PROCESSOR_ARCHITECTURE"

    # 3. Internet connectivity
    Write-Info "Checking internet connectivity..."
    $endpoints = @("https://nodejs.org", "https://github.com", "https://registry.npmjs.org")
    foreach ($endpoint in $endpoints) {
        try {
            Invoke-WebRequest -Uri $endpoint -Method Head -UseBasicParsing -TimeoutSec 10 | Out-Null
        } catch {
            Stop-WithError "Cannot reach $endpoint - check your internet connection or firewall."
        }
    }
    Write-Info "Internet connectivity OK"

    # 4. Disk space
    $drive = Get-PSDrive C
    if ($drive.Free -lt 1GB) {
        $freeGB = [math]::Round($drive.Free / 1GB, 2)
        Stop-WithError "Insufficient disk space on C: ${freeGB}GB available, need at least 1GB."
    }
    $freeGB = [math]::Round($drive.Free / 1GB, 1)
    Write-Info "Disk space on C: ${freeGB}GB available"

    Write-Info "Preflight checks passed"
}

# ==============================================================================
# Mode Detection
# ==============================================================================
function Get-InstallMode {
    if ((Test-Path "$InstallDir\app") -and (Test-Path "$InstallDir\.installer-version")) {
        Write-Info "Existing installation found (managed by installer) - update mode"
        return "update"
    } elseif ((Test-Path $InstallDir) -and -not (Test-Path "$InstallDir\.installer-version")) {
        # Check if directory has meaningful content (not just our install.log)
        $items = Get-ChildItem $InstallDir -Exclude "install.log" -ErrorAction SilentlyContinue
        if ($items.Count -gt 0) {
            Write-Warn "Found existing $InstallDir not managed by this installer."
            $answer = Read-Host "Wipe and reinstall? [y/N]"
            if ($answer -match "^[yY]") {
                Write-Info "User chose to wipe and reinstall"
                return "wipe"
            } else {
                Write-Info "User declined to wipe - exiting"
                exit 0
            }
        }
    }
    Write-Info "No existing installation found - fresh install mode"
    return "fresh"
}

# ==============================================================================
# Uninstall
# ==============================================================================
function Invoke-Uninstall {
    Write-Info "Uninstalling rattin..."

    # Stop and remove WinSW service
    $serviceXml = "$InstallDir\runtime\bin\rattin-service.xml"
    $winswExe = "$InstallDir\runtime\bin\winsw.exe"
    if ((Test-Path $serviceXml) -and (Test-Path $winswExe)) {
        try {
            & $winswExe stop $serviceXml 2>$null
            Start-Sleep -Seconds 2
            & $winswExe uninstall $serviceXml 2>$null
            Write-Info "WinSW service removed"
        } catch {
            Write-Warn "Could not remove WinSW service: $_"
        }
    }

    # Remove scheduled task
    Unregister-ScheduledTask -TaskName "MagnetPlayerCleanup" -Confirm:$false -ErrorAction SilentlyContinue

    # Remove install directory
    if (Test-Path $InstallDir) {
        Remove-Item -Recurse -Force $InstallDir
    }

    Write-Info "Rattin uninstalled successfully."
}

# ==============================================================================
# Create Directories
# ==============================================================================
function New-DirectoryStructure {
    Write-Info "Creating directory structure..."
    $dirs = @(
        "$InstallDir\runtime\node",
        "$InstallDir\runtime\bin",
        "$InstallDir\app",
        "$InstallDir\data\downloads",
        "$InstallDir\data\transcoded"
    )
    foreach ($dir in $dirs) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    Write-Info "Directory structure created"
}

# ==============================================================================
# Install Node.js
# ==============================================================================
function Install-Node {
    Write-Info "Installing Node.js..."

    # Query latest v20 LTS version
    $versionJson = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -UseBasicParsing
    $latest = $versionJson | Where-Object { $_.version -match "^v20\." -and $_.lts } | Select-Object -First 1

    if (-not $latest) {
        Stop-WithError "Could not determine latest Node.js v20 LTS version"
    }
    $nodeVersion = $latest.version
    Write-Info "Latest Node.js v20 LTS: $nodeVersion"

    # On update: check if already installed at this version
    $nodeExe = "$InstallDir\runtime\node\node.exe"
    if (($script:Mode -eq "update") -and (Test-Path $nodeExe)) {
        $installedVersion = & $nodeExe --version 2>$null
        if ($installedVersion -eq $nodeVersion) {
            Write-Info "Node.js $nodeVersion already installed - skipping"
            return
        }
        Write-Info "Node.js version change: $installedVersion -> $nodeVersion"
        if (Test-Path "$InstallDir\runtime\node.bak") {
            Remove-Item -Recurse -Force "$InstallDir\runtime\node.bak"
        }
        Rename-Item "$InstallDir\runtime\node" "$InstallDir\runtime\node.bak"
        New-Item -ItemType Directory -Path "$InstallDir\runtime\node" -Force | Out-Null
    }

    # Download
    $url = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip"
    $tmpFile = "$env:TEMP\rattin-node.zip"
    Write-Info "Downloading Node.js from $url"
    Invoke-WebRequest -Uri $url -OutFile $tmpFile -UseBasicParsing

    # Verify file size > 20MB
    $fileSize = (Get-Item $tmpFile).Length
    if ($fileSize -lt 20000000) {
        Remove-Item -Force $tmpFile
        Stop-WithError "Node.js download too small ($fileSize bytes). Download may have failed."
    }

    # Extract (archive has top-level dir, so extract to temp then move contents)
    $tmpExtract = "$env:TEMP\rattin-node-extract"
    if (Test-Path $tmpExtract) { Remove-Item -Recurse -Force $tmpExtract }
    Expand-Archive -Path $tmpFile -DestinationPath $tmpExtract -Force

    # Find the top-level directory inside the archive
    $innerDir = Get-ChildItem $tmpExtract | Select-Object -First 1

    # Ensure target is clean and move contents
    if (Test-Path "$InstallDir\runtime\node") {
        Remove-Item -Recurse -Force "$InstallDir\runtime\node"
    }
    Move-Item -Path $innerDir.FullName -Destination "$InstallDir\runtime\node"

    # Clean up
    Remove-Item -Force $tmpFile -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $tmpExtract -ErrorAction SilentlyContinue

    # Verify
    $result = & "$InstallDir\runtime\node\node.exe" --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "Node.js installation verification failed"
    }
    Write-Info "Node.js $result installed successfully"
}

# ==============================================================================
# Install ffmpeg
# ==============================================================================
function Install-Ffmpeg {
    Write-Info "Installing ffmpeg..."

    $url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    $tmpFile = "$env:TEMP\rattin-ffmpeg.zip"

    Write-Info "Downloading ffmpeg from $url"
    Invoke-WebRequest -Uri $url -OutFile $tmpFile -UseBasicParsing

    # Verify file size > 30MB
    $fileSize = (Get-Item $tmpFile).Length
    if ($fileSize -lt 30000000) {
        Remove-Item -Force $tmpFile
        Stop-WithError "ffmpeg download too small ($fileSize bytes). Download may have failed."
    }

    # Extract
    $tmpExtract = "$env:TEMP\rattin-ffmpeg-extract"
    if (Test-Path $tmpExtract) { Remove-Item -Recurse -Force $tmpExtract }
    Expand-Archive -Path $tmpFile -DestinationPath $tmpExtract -Force

    # Find ffmpeg.exe and ffprobe.exe in the bin subdirectory
    $ffmpegExe = Get-ChildItem -Path $tmpExtract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    $ffprobeExe = Get-ChildItem -Path $tmpExtract -Recurse -Filter "ffprobe.exe" | Select-Object -First 1

    if (-not $ffmpegExe -or -not $ffprobeExe) {
        Remove-Item -Recurse -Force $tmpExtract, $tmpFile -ErrorAction SilentlyContinue
        Stop-WithError "Could not find ffmpeg.exe/ffprobe.exe in the downloaded archive"
    }

    New-Item -ItemType Directory -Path "$InstallDir\runtime\bin" -Force | Out-Null
    Copy-Item $ffmpegExe.FullName "$InstallDir\runtime\bin\ffmpeg.exe" -Force
    Copy-Item $ffprobeExe.FullName "$InstallDir\runtime\bin\ffprobe.exe" -Force

    # Clean up
    Remove-Item -Force $tmpFile -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $tmpExtract -ErrorAction SilentlyContinue

    # Verify
    $result = & "$InstallDir\runtime\bin\ffmpeg.exe" -version 2>&1 | Select-Object -First 1
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "ffmpeg installation verification failed"
    }
    Write-Info "ffmpeg installed successfully: $result"
}

# ==============================================================================
# Install fpcalc (best-effort)
# ==============================================================================
function Install-Fpcalc {
    Write-Info "Installing fpcalc (chromaprint) - best effort..."
    try {
        $releasesUrl = "https://api.github.com/repos/acoustid/chromaprint/releases/latest"
        $release = Invoke-RestMethod -Uri $releasesUrl -UseBasicParsing -ErrorAction Stop

        $asset = $release.assets | Where-Object { $_.name -match "chromaprint-fpcalc-.*-windows-x86_64\.zip$" } | Select-Object -First 1

        if (-not $asset) {
            Write-Warn "fpcalc binary not found in latest chromaprint release - acoustic fingerprinting will be disabled"
            return
        }

        $tmpFile = "$env:TEMP\rattin-fpcalc.zip"
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmpFile -UseBasicParsing

        $tmpExtract = "$env:TEMP\rattin-fpcalc-extract"
        if (Test-Path $tmpExtract) { Remove-Item -Recurse -Force $tmpExtract }
        Expand-Archive -Path $tmpFile -DestinationPath $tmpExtract -Force

        $fpcalcExe = Get-ChildItem -Path $tmpExtract -Recurse -Filter "fpcalc.exe" | Select-Object -First 1
        if ($fpcalcExe) {
            Copy-Item $fpcalcExe.FullName "$InstallDir\runtime\bin\fpcalc.exe" -Force
            Write-Info "fpcalc installed successfully"
        } else {
            Write-Warn "fpcalc.exe not found in downloaded archive"
        }

        Remove-Item -Force $tmpFile -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force $tmpExtract -ErrorAction SilentlyContinue
    } catch {
        Write-Warn "fpcalc installation failed: $($_.Exception.Message)"
        Write-Warn "Acoustic fingerprinting will be disabled (intro detection degrades gracefully)"
    }
}

# ==============================================================================
# Build Tools (skip on Windows)
# ==============================================================================
function Install-BuildTools {
    Write-Info "Node.js v20 ships prebuilt binaries for native modules on Windows - skipping build tools."
    Write-Info "If npm ci fails with a gyp error, install Visual Studio Build Tools: https://visualstudio.microsoft.com/visual-cpp-build-tools/"
}

# ==============================================================================
# Rollback
# ==============================================================================
function Invoke-Rollback {
    Write-Warn "Rolling back to previous installation..."
    if (Test-Path "$InstallDir\app.bak") {
        if (Test-Path "$InstallDir\app") { Remove-Item -Recurse -Force "$InstallDir\app" }
        Rename-Item "$InstallDir\app.bak" "$InstallDir\app"
        Write-Info "Restored previous app directory"
    }
    if (Test-Path "$InstallDir\runtime\node.bak") {
        if (Test-Path "$InstallDir\runtime\node") { Remove-Item -Recurse -Force "$InstallDir\runtime\node" }
        Rename-Item "$InstallDir\runtime\node.bak" "$InstallDir\runtime\node"
        Write-Info "Restored previous Node.js installation"
    }
    # Try to restart service
    $winswExe = "$InstallDir\runtime\bin\winsw.exe"
    $serviceXml = "$InstallDir\runtime\bin\rattin-service.xml"
    if ((Test-Path $winswExe) -and (Test-Path $serviceXml)) {
        & $winswExe start $serviceXml 2>$null
    }
    Write-Warn "Rollback complete. Previous version restored."
}

# ==============================================================================
# Install App
# ==============================================================================
function Install-App {
    Write-Info "Downloading application..."

    $tarballUrl = "https://github.com/rattin-player/player/archive/refs/heads/main.tar.gz"
    $tmpFile = "$env:TEMP\rattin-app.tar.gz"

    Invoke-WebRequest -Uri $tarballUrl -OutFile $tmpFile -UseBasicParsing

    # Verify file size > 100KB
    $fileSize = (Get-Item $tmpFile).Length
    if ($fileSize -lt 100000) {
        Remove-Item -Force $tmpFile
        Stop-WithError "App download too small ($fileSize bytes). Download may have failed."
    }

    if ($script:Mode -eq "update") {
        # Stop service before replacing files
        $winswExe = "$InstallDir\runtime\bin\winsw.exe"
        $serviceXml = "$InstallDir\runtime\bin\rattin-service.xml"
        if ((Test-Path $winswExe) -and (Test-Path $serviceXml)) {
            & $winswExe stop $serviceXml 2>$null
            Start-Sleep -Seconds 2
        }

        # Backup current app directory
        if (Test-Path "$InstallDir\app.bak") {
            Remove-Item -Recurse -Force "$InstallDir\app.bak"
        }
        Rename-Item "$InstallDir\app" "$InstallDir\app.bak"
        New-Item -ItemType Directory -Path "$InstallDir\app" -Force | Out-Null

        # Extract using tar.exe (available on Win10 1803+)
        try {
            & tar.exe -xzf $tmpFile -C "$InstallDir\app" --strip-components=1
            if ($LASTEXITCODE -ne 0) { throw "tar extraction failed" }
        } catch {
            Invoke-Rollback
            Stop-WithError "Failed to extract app update"
        }

        # Restore .env from backup
        if (Test-Path "$InstallDir\app.bak\.env") {
            Copy-Item "$InstallDir\app.bak\.env" "$InstallDir\app\.env" -Force
            Write-Info "Restored .env from backup"
        } else {
            Write-Warn "No .env found in backup to restore"
        }
    } else {
        # Fresh install
        New-Item -ItemType Directory -Path "$InstallDir\app" -Force | Out-Null
        & tar.exe -xzf $tmpFile -C "$InstallDir\app" --strip-components=1
        if ($LASTEXITCODE -ne 0) {
            Stop-WithError "Failed to extract application archive"
        }
    }

    Remove-Item -Force $tmpFile -ErrorAction SilentlyContinue
    Write-Info "Application downloaded successfully"
}

# ==============================================================================
# Build App
# ==============================================================================
function Build-App {
    Write-Info "Building application..."

    # Set PATH to include our bundled runtimes
    $env:PATH = "$InstallDir\runtime\node;$InstallDir\runtime\bin;$env:PATH"

    $npmExe = "$InstallDir\runtime\node\npm.cmd"

    Write-Info "Running npm ci..."
    Push-Location "$InstallDir\app"
    try {
        & $npmExe ci
        if ($LASTEXITCODE -ne 0) {
            if ($script:Mode -eq "update") { Invoke-Rollback }
            Stop-WithError "npm ci failed. If this is a gyp error, install Visual Studio Build Tools."
        }

        Write-Info "Running npm run build..."
        & $npmExe run build
        if ($LASTEXITCODE -ne 0) {
            if ($script:Mode -eq "update") { Invoke-Rollback }
            Stop-WithError "npm run build failed"
        }

        if (-not (Test-Path "$InstallDir\app\public\index.html")) {
            if ($script:Mode -eq "update") { Invoke-Rollback }
            Stop-WithError "Build verification failed: public\index.html not found"
        }
    } finally {
        Pop-Location
    }

    Write-Info "Application built successfully"
}

# ==============================================================================
# Configure TMDB
# ==============================================================================
function Set-TmdbKey {
    Write-Info "Configuring TMDB API key..."

    # Skip if .env already has a non-empty TMDB_API_KEY
    $envFile = "$InstallDir\app\.env"
    if ((Test-Path $envFile) -and (Select-String -Path $envFile -Pattern "^TMDB_API_KEY=.+" -Quiet)) {
        Write-Info "TMDB API key already configured - skipping"
        return
    }

    Write-Host ""
    Write-Host "Rattin uses The Movie Database (TMDB) for movie/TV metadata."
    Write-Host "To get a free API key:"
    Write-Host "  1. Create an account at https://www.themoviedb.org/signup"
    Write-Host "  2. Go to https://www.themoviedb.org/settings/api"
    Write-Host "  3. Request an API key (choose 'Developer' option)"
    Write-Host ""

    $tmdbKey = Read-Host "Paste your TMDB API key"

    if ([string]::IsNullOrWhiteSpace($tmdbKey)) {
        Write-Warn "No TMDB API key provided. You can add it later to $InstallDir\app\.env"
        return
    }

    # Validate key
    try {
        $response = Invoke-WebRequest -Uri "https://api.themoviedb.org/3/configuration?api_key=$tmdbKey" -UseBasicParsing -ErrorAction Stop
        if ($response.StatusCode -eq 200) {
            Write-Info "TMDB API key validated successfully"
        }
    } catch {
        Write-Warn "TMDB API key appears invalid, but saving it anyway. You can fix it later in $InstallDir\app\.env"
    }

    # Write to .env (remove existing line if present, then append)
    if (Test-Path $envFile) {
        $content = Get-Content $envFile | Where-Object { $_ -notmatch "^TMDB_API_KEY=" }
        $content | Set-Content $envFile
    }
    Add-Content -Path $envFile -Value "TMDB_API_KEY=$tmdbKey"
    Write-Info "TMDB API key saved to $envFile"
}

# ==============================================================================
# Permissions
# ==============================================================================
function Set-FilePermissions {
    Write-Info "Setting permissions..."

    $envFile = "$InstallDir\app\.env"
    if (Test-Path $envFile) {
        & icacls $envFile /inheritance:r /grant:r "Administrators:(R)" 2>$null
        Write-Info ".env file permissions restricted to Administrators"
    }

    Write-Info "Permissions set successfully"
}

# ==============================================================================
# Service Setup (WinSW)
# ==============================================================================
function Install-Service {
    Write-Info "Configuring service..."

    $answer = Read-Host "Start rattin automatically on boot? [Y/n]"

    if ($answer -match "^[nN]") {
        Write-Info "User declined auto-start - writing manual launcher"

        $batContent = @"
@echo off
set PATH=C:\Program Files\rattin\runtime\node;C:\Program Files\rattin\runtime\bin;%PATH%
set DOWNLOAD_DIR=C:\Program Files\rattin\data\downloads
set TRANSCODE_DIR=C:\Program Files\rattin\data\transcoded
set HOST=127.0.0.1
cd /d "C:\Program Files\rattin\app"
"C:\Program Files\rattin\runtime\node\node.exe" --max-old-space-size=256 --env-file=.env server.js
"@
        Set-Content -Path "$InstallDir\start.bat" -Value $batContent -Encoding ASCII
        Write-Info "Manual launcher written to $InstallDir\start.bat"
        $script:UseService = $false
        return
    }

    $script:UseService = $true
    Write-Info "Setting up WinSW service..."

    # Download WinSW
    $winswUrl = "https://github.com/winsw/winsw/releases/download/v3.0.0-alpha.11/WinSW-x64.exe"
    $winswExe = "$InstallDir\runtime\bin\winsw.exe"

    if (-not (Test-Path $winswExe)) {
        Write-Info "Downloading WinSW..."
        Invoke-WebRequest -Uri $winswUrl -OutFile $winswExe -UseBasicParsing
    }

    # Create service XML
    $serviceXml = @"
<service>
  <id>rattin</id>
  <name>Rattin</name>
  <description>WebTorrent streaming server</description>
  <executable>C:\Program Files\rattin\runtime\node\node.exe</executable>
  <arguments>--max-old-space-size=256 --env-file=.env server.js</arguments>
  <workingdirectory>C:\Program Files\rattin\app</workingdirectory>
  <env name="PATH" value="C:\Program Files\rattin\runtime\node;C:\Program Files\rattin\runtime\bin;%PATH%"/>
  <env name="PORT" value="3000"/>
  <env name="HOST" value="127.0.0.1"/>
  <env name="DOWNLOAD_DIR" value="C:\Program Files\rattin\data\downloads"/>
  <env name="TRANSCODE_DIR" value="C:\Program Files\rattin\data\transcoded"/>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>3</keepFiles>
  </log>
</service>
"@
    $serviceXmlPath = "$InstallDir\runtime\bin\rattin-service.xml"
    Set-Content -Path $serviceXmlPath -Value $serviceXml -Encoding UTF8

    # Install and start service
    Write-Info "Installing WinSW service..."
    & $winswExe install $serviceXmlPath
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "WinSW service install returned exit code $LASTEXITCODE"
    }

    Write-Info "Starting WinSW service..."
    & $winswExe start $serviceXmlPath
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "WinSW service start returned exit code $LASTEXITCODE"
    }

    Write-Info "WinSW service configured and started"
}

# ==============================================================================
# Cleanup Scheduled Task
# ==============================================================================
function Register-CleanupTask {
    Write-Info "Registering cleanup scheduled task..."

    # Remove existing task if present
    Unregister-ScheduledTask -TaskName "MagnetPlayerCleanup" -Confirm:$false -ErrorAction SilentlyContinue

    $action = New-ScheduledTaskAction -Execute "PowerShell.exe" `
        -Argument "-NoProfile -Command `"Get-ChildItem '$InstallDir\data' -Recurse -File | Where-Object { `$_.LastWriteTime -lt (Get-Date).AddHours(-24) } | Remove-Item -Force`""

    $trigger = New-ScheduledTaskTrigger -Once -At "00:00" -RepetitionInterval (New-TimeSpan -Hours 6)

    Register-ScheduledTask -TaskName "MagnetPlayerCleanup" -Action $action -Trigger $trigger `
        -Description "Clean old rattin data" -RunLevel Highest | Out-Null

    Write-Info "Cleanup scheduled task registered (runs every 6 hours)"
}

# ==============================================================================
# Health Check
# ==============================================================================
function Test-HealthCheck {
    if (-not $script:UseService) {
        Write-Host ""
        Write-Info "To start Rattin, run: $InstallDir\start.bat"
        return
    }

    Write-Info "Waiting for health check..."
    $attempts = 0
    while ($attempts -lt 10) {
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:3000" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($response.StatusCode -eq 200) {
                Write-Info "Health check passed"
                return
            }
        } catch {
            # Not ready yet
        }
        $attempts++
        Start-Sleep -Seconds 2
    }

    Write-Warn "Health check failed after 10 attempts. Service may still be starting."
    if ($script:Mode -eq "update") {
        Invoke-Rollback
        Stop-WithError "Update failed. Rolled back to previous version."
    } else {
        Write-Warn "Fresh install health check failed. The app may need a manual restart."
    }
}

# ==============================================================================
# Success Banner
# ==============================================================================
function Write-SuccessBanner {
    Write-Host ""
    Write-Host "============================================"
    Write-Host "  Rattin installed successfully!"
    Write-Host "============================================"
    Write-Host ""
    Write-Host "  URL:        http://localhost:3000"
    Write-Host "  Install:    $InstallDir"
    Write-Host "  Data:       $InstallDir\data"
    Write-Host "  Config:     $InstallDir\app\.env"

    if ($script:UseService) {
        Write-Host "  Logs:       $InstallDir\runtime\bin\rattin-service.wrapper.log"
    } else {
        Write-Host "  Start:      $InstallDir\start.bat"
        Write-Host "  Logs:       (run start.bat to see output)"
    }

    Write-Host "  Uninstall:  .\install.ps1 -Uninstall"
    Write-Host ""
    Write-Host "============================================"
    Write-Host ""
}

# ==============================================================================
# Main
# ==============================================================================
function Main {
    Get-InstallerLock

    try {
        # Handle -Uninstall before preflight
        if ($Uninstall) {
            # Still need admin for uninstall
            $currentPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
            if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
                Stop-WithError "This installer must be run as Administrator."
            }
            Invoke-Uninstall
            return
        }

        Test-Preflight

        $script:Mode = Get-InstallMode
        $script:UseService = $false

        Write-Info "Install mode: $($script:Mode)"

        # Wipe mode: uninstall first, then fresh install
        if ($script:Mode -eq "wipe") {
            Invoke-Uninstall
            $script:Mode = "fresh"
            Write-Info "Wipe complete - continuing as fresh install"
        }

        # Create directory structure on fresh install
        if ($script:Mode -eq "fresh") {
            New-DirectoryStructure
        }

        Install-Node
        Install-Ffmpeg
        Install-Fpcalc
        Install-BuildTools
        Install-App
        Build-App

        if ($script:Mode -eq "fresh") {
            Set-TmdbKey
        }

        Set-FilePermissions
        Install-Service
        Register-CleanupTask
        Test-HealthCheck

        # Mark as installer-managed
        Set-Content -Path "$InstallDir\.installer-version" -Value $InstallerVersion

        # Clean up backups on successful update
        if ($script:Mode -eq "update") {
            Remove-Item -Recurse -Force "$InstallDir\app.bak" -ErrorAction SilentlyContinue
            Remove-Item -Recurse -Force "$InstallDir\runtime\node.bak" -ErrorAction SilentlyContinue
            Write-Info "Update backups cleaned up"
        }

        Write-SuccessBanner
    } finally {
        Release-InstallerLock
    }
}

Main
