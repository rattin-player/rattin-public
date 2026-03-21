@echo off
title Rattin
cd /d "%~dp0"

set "NODE_VER=v20.18.1"
set "NODE_DIR=%~dp0runtime\node"
set "FFMPEG_DIR=%~dp0runtime\ffmpeg"

:: ============================================================
::  Node.js — check system, then local portable, then download
:: ============================================================
where node >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] Node.js found on system.
    goto :check_ffmpeg
)

if exist "%NODE_DIR%\node.exe" (
    echo [OK] Using portable Node.js.
    set "PATH=%NODE_DIR%;%PATH%"
    goto :check_ffmpeg
)

echo [..] Node.js not found. Downloading portable Node.js %NODE_VER%...
if not exist "runtime" mkdir runtime

set "NODE_ZIP=node-%NODE_VER%-win-x64.zip"
set "NODE_URL=https://nodejs.org/dist/%NODE_VER%/%NODE_ZIP%"

powershell -NoProfile -Command ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
    "$ProgressPreference = 'SilentlyContinue'; " ^
    "Invoke-WebRequest -Uri '%NODE_URL%' -OutFile 'runtime\%NODE_ZIP%'"

if not exist "runtime\%NODE_ZIP%" (
    echo [ERROR] Download failed. Check your internet connection.
    pause
    exit /b 1
)

echo [..] Extracting Node.js...
powershell -NoProfile -Command ^
    "Expand-Archive -Path 'runtime\%NODE_ZIP%' -DestinationPath 'runtime' -Force"

:: Rename extracted folder to "node"
if exist "%NODE_DIR%" rmdir /s /q "%NODE_DIR%"
ren "runtime\node-%NODE_VER%-win-x64" "node"

del "runtime\%NODE_ZIP%"
set "PATH=%NODE_DIR%;%PATH%"
echo [OK] Node.js %NODE_VER% installed to runtime\node

:: ============================================================
::  ffmpeg — check system, then local, then download
:: ============================================================
:check_ffmpeg

where ffmpeg >nul 2>nul
if %errorlevel% equ 0 (
    echo [OK] ffmpeg found on system.
    goto :deps
)

if exist "%FFMPEG_DIR%\ffmpeg.exe" (
    echo [OK] Using portable ffmpeg.
    set "PATH=%FFMPEG_DIR%;%PATH%"
    goto :deps
)

echo [..] ffmpeg not found. Downloading ffmpeg...
if not exist "runtime" mkdir runtime

set "FF_ZIP=ffmpeg-release-essentials.zip"
set "FF_URL=https://www.gyan.dev/ffmpeg/builds/%FF_ZIP%"

powershell -NoProfile -Command ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
    "$ProgressPreference = 'SilentlyContinue'; " ^
    "Invoke-WebRequest -Uri '%FF_URL%' -OutFile 'runtime\%FF_ZIP%'"

if not exist "runtime\%FF_ZIP%" (
    echo [WARNING] ffmpeg download failed. Transcoding will not work.
    echo You can manually download from https://www.gyan.dev/ffmpeg/builds/
    goto :deps
)

echo [..] Extracting ffmpeg (this may take a minute)...
powershell -NoProfile -Command ^
    "Expand-Archive -Path 'runtime\%FF_ZIP%' -DestinationPath 'runtime\ffmpeg_tmp' -Force"

:: The zip contains a versioned folder like ffmpeg-7.1-essentials_build/bin/
:: Find and move the binaries
if not exist "%FFMPEG_DIR%" mkdir "%FFMPEG_DIR%"
powershell -NoProfile -Command ^
    "Get-ChildItem -Path 'runtime\ffmpeg_tmp' -Recurse -Filter 'ffmpeg.exe' | " ^
    "ForEach-Object { Copy-Item $_.Directory.FullName\* '%FFMPEG_DIR%\' -Force }"

rmdir /s /q "runtime\ffmpeg_tmp"
del "runtime\%FF_ZIP%"
set "PATH=%FFMPEG_DIR%;%PATH%"
echo [OK] ffmpeg installed to runtime\ffmpeg

:: ============================================================
::  npm install
:: ============================================================
:deps

if not exist "node_modules" (
    echo [..] Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed.
)

:: ============================================================
::  Launch
:: ============================================================
echo.
echo ========================================
echo   Rattin starting...
echo   Opening http://localhost:3000
echo   Press Ctrl+C to stop
echo ========================================
echo.

start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

call npm run build
node server.js

pause
