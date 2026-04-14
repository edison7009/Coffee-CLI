# Coffee CLI — Windows Installer / Updater
# Usage: irm https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/install/install.ps1 | iex

$ErrorActionPreference = "Stop"
$repo = "edison7009/Coffee-CLI"

Write-Host ""
Write-Host "  Coffee CLI Installer" -ForegroundColor Cyan
Write-Host "  --------------------" -ForegroundColor DarkGray

# Get latest release
Write-Host "  Fetching latest release..." -ForegroundColor Gray
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
$latestTag = $release.tag_name                      # e.g. "v0.2.4"
$latestVer = $latestTag -replace '^v', ''           # e.g. "0.2.4"
Write-Host "  Latest : $latestTag" -ForegroundColor Green

# Detect currently installed version from Windows registry
$installedVer = $null
$regPaths = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
)
foreach ($path in $regPaths) {
    $entry = Get-ItemProperty $path -ErrorAction SilentlyContinue |
             Where-Object { $_.DisplayName -like "Coffee CLI*" } |
             Select-Object -First 1
    if ($entry) {
        $installedVer = $entry.DisplayVersion
        break
    }
}

if ($installedVer) {
    Write-Host "  Installed: v$installedVer" -ForegroundColor Gray
    if ($installedVer -eq $latestVer) {
        Write-Host ""
        Write-Host "  Coffee CLI is already up to date (v$installedVer)." -ForegroundColor Green
        Write-Host ""
        exit 0
    }
    Write-Host "  Upgrading v$installedVer  →  v$latestVer ..." -ForegroundColor Yellow
} else {
    Write-Host "  Not installed — performing fresh install..." -ForegroundColor Gray
}

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
Write-Host "  Done! Coffee CLI $latestTag installed." -ForegroundColor Green
Write-Host "  Launch it from the Start Menu." -ForegroundColor Gray
Write-Host ""
