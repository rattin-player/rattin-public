# build-rattin.ps1 — PowerShell build script (avoids CMD's 8191-char PATH limit)
param([switch]$Clean)

# Set up MSVC build environment
$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat"
cmd /c "`"$vcvars`" x64 && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)') {
        Set-Item -Path "Env:$($matches[1])" -Value $matches[2]
    }
}

$env:CMAKE_PREFIX_PATH = "C:\Qt\6.7.3\msvc2019_64"
$env:PATH = "C:\Qt\6.7.3\msvc2019_64\bin;C:\Program Files\7-Zip;$env:PATH"

Set-Location "D:\rattin-public"

Write-Host "Installing npm dependencies..."
npm ci --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
npm rebuild

Write-Host "Building frontend..."
npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

Write-Host "Building app..."
$args = @("-ExecutionPolicy", "Bypass", "-File", "install\build-windows.ps1")
if ($Clean) { $args += "-Clean" }
& "C:\Program Files\PowerShell\7\pwsh.exe" @args
