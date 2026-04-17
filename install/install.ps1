# Coffee CLI - Windows Installer / Updater
# Usage: irm https://coffeecli.com/install.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  Coffee CLI Installer" -ForegroundColor Cyan
Write-Host "  --------------------" -ForegroundColor DarkGray

# Resolve version and binary via coffeecli.com (CF-hosted, China-accessible).
# /version.json is served from Web-Home; /download/windows is a CF Worker
# route that proxies the matching GitHub Release asset. This keeps the
# install path off api.github.com so the script doesn't stall on a blocked
# or slow GitHub API from mainland networks.
Write-Host "  Fetching latest version..." -ForegroundColor Gray
$latestVer = (Invoke-RestMethod "https://coffeecli.com/version.json").version
Write-Host "  Latest : v$latestVer" -ForegroundColor Green

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
    Write-Host "  Upgrading v$installedVer -> v$latestVer ..." -ForegroundColor Yellow
} else {
    Write-Host "  Not installed - performing fresh install..." -ForegroundColor Gray
}

$url = "https://coffeecli.com/download/windows"
$out = "$env:TEMP\coffee-cli-setup.exe"

Write-Host "  Downloading..." -ForegroundColor Gray
Invoke-WebRequest $url -OutFile $out -UseBasicParsing

Write-Host "  Installing..." -ForegroundColor Gray
Start-Process $out -Wait

Write-Host ""
Write-Host "  Done! Coffee CLI v$latestVer installed." -ForegroundColor Green
Write-Host "  Launch it from the Start Menu." -ForegroundColor Gray
Write-Host ""
