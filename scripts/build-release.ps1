<#
.SYNOPSIS
Builds and packages the Coffee CLI for Windows into a standalone zip file.

.DESCRIPTION
This script builds the frontend, compiles the Rust backend via optimal settings,
and packages the raw executable along with required resource folders (like binaries)
into a portable .zip artifact. Does not trigger MSI compilation.
#>

$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$OutDir = Join-Path $ProjectRoot "target\release\coffee-cli-windows"
$ZipName = "coffee-cli-windows-amd64.zip"
$ZipPath = Join-Path $ProjectRoot "target\release\$ZipName"

Write-Host "🚀 Starting Coffee CLI Windows Portal Build..." -ForegroundColor Cyan

# 1. Build frontend
Write-Host "📦 Building frontend UI..." -ForegroundColor Yellow
Set-Location (Join-Path $ProjectRoot "src-ui")
npm run build
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed" }

# 2. Build Tauri (release profile executable only, skip MSIs)
Write-Host "🦀 Compiling Rust core (Release Profile)..." -ForegroundColor Yellow
Set-Location $ProjectRoot
cargo build --release
if ($LASTEXITCODE -ne 0) { throw "Cargo build failed" }

# 3. Assemble Portable Folder
Write-Host "📁 Assembling Portable Package Directory..." -ForegroundColor Yellow
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir | Out-Null

Copy-Item (Join-Path $ProjectRoot "target\release\coffee-cli.exe") -Destination $OutDir
if (Test-Path (Join-Path $ProjectRoot "binaries")) {
    Copy-Item (Join-Path $ProjectRoot "binaries") -Destination $OutDir -Recurse
}

# 4. Zip it
Write-Host "🗜️ Compressing into $ZipName..." -ForegroundColor Yellow
if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
Compress-Archive -Path "$OutDir\*" -DestinationPath $ZipPath

Write-Host "`n✅ Build Successful! Portable release zip created at:" -ForegroundColor Green
Write-Host "👉 $ZipPath" -ForegroundColor White
