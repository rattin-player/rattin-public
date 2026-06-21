@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat" x64
set CMAKE_PREFIX_PATH=C:\Qt\6.7.3\msvc2019_64
set PATH=C:\Qt\6.7.3\msvc2019_64\bin;C:\Program Files\7-Zip;%PATH%
cd /d D:\rattin-public
echo Installing npm dependencies...
call npm ci
echo Building frontend...
call npm run build
echo Building app...
"C:\Program Files\PowerShell\7\pwsh.exe" -ExecutionPolicy Bypass -File install\build-windows.ps1 -Clean
