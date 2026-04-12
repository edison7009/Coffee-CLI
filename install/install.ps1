# Coffee CLI — Windows Installer
# Usage: irm https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/install/install.ps1 | iex

$ErrorActionPreference = "Stop"
$repo = "edison7009/Coffee-CLI"

Write-Host ""
Write-Host "  Coffee CLI Installer" -ForegroundColor Cyan
Write-Host "  ────────────────────" -ForegroundColor DarkGray

# Get latest release
Write-Host "  Fetching latest release..." -ForegroundColor Gray
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
$version = $release.tag_name
Write-Host "  Latest: $version" -ForegroundColor Green

# Find Windows installer asset
$asset = $release.assets | Where-Object { $_.name -like "*x64-setup.exe" } | Select-Object -First 1
if (-not $asset) {
    $asset = $release.assets | Where-Object { $_.name -like "*.msi" } | Select-Object -First 1
}
if (-not $asset) {
    Write-Host "  ERROR: No Windows installer found in release assets." -ForegroundColor Red
    exit 1
}

$url = $asset.browser_download_url
$out = "$env:TEMP\coffee-cli-setup.exe"

Write-Host "  Downloading $($asset.name)..." -ForegroundColor Gray
Invoke-WebRequest $url -OutFile $out -UseBasicParsing

Write-Host "  Installing..." -ForegroundColor Gray
Start-Process $out -Wait

Write-Host ""
Write-Host "  Done! Coffee CLI $version installed." -ForegroundColor Green
Write-Host "  Launch it from the Start Menu." -ForegroundColor Gray
Write-Host ""
