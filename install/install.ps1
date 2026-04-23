# Coffee CLI - Windows Installer / Updater
# Usage: irm https://coffeecli.com/install.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  Coffee CLI Installer" -ForegroundColor Cyan
Write-Host "  --------------------" -ForegroundColor DarkGray

# Resolve version and binary via coffeecli.com (CF-hosted, China-accessible).
# /version.json?platform=windows returns the latest release tag ONLY when
# the Windows installer has been uploaded to GitHub Releases. If CI is
# still mid-build, the endpoint returns an empty version, which we treat
# as "no upgrade available yet" — preventing the earlier race where the
# version bumped instantly but the .exe took another 15 min to appear.
# /download/windows is a CF Worker route that proxies the matching GitHub
# Release asset. This keeps the install path off api.github.com so the
# script doesn't stall on a blocked or slow GitHub API from mainland
# networks.
Write-Host "  Fetching latest version..." -ForegroundColor Gray
$latestVer = (Invoke-RestMethod "https://coffeecli.com/version.json?platform=windows").version

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

# Empty `version` = the Windows build isn't out yet (CI probably still
# running for a just-tagged release). Report gracefully instead of trying
# to download something that 404s.
if (-not $latestVer) {
    Write-Host "  Latest : (Windows installer not yet published)" -ForegroundColor DarkYellow
    if ($installedVer) {
        Write-Host "  Installed: v$installedVer" -ForegroundColor Gray
        Write-Host ""
        Write-Host "  The Windows build for the newest release is still being" -ForegroundColor DarkYellow
        Write-Host "  compiled by CI (takes ~15-20 min after a new tag). Your" -ForegroundColor DarkYellow
        Write-Host "  current v$installedVer stays installed. Try again soon." -ForegroundColor DarkYellow
    } else {
        Write-Host ""
        Write-Host "  No Windows installer is available at the moment." -ForegroundColor DarkYellow
        Write-Host "  CI may still be building a just-tagged release." -ForegroundColor DarkYellow
        Write-Host "  Please try again in about 15 minutes." -ForegroundColor DarkYellow
    }
    Write-Host ""
    exit 0
}

Write-Host "  Latest : v$latestVer" -ForegroundColor Green

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
# Wrap in try/catch so a transient 404 (CI edge case: version.json says
# ready but GitHub asset not yet consistent) surfaces as a friendly
# message instead of a raw WebException stack.
try {
    Invoke-WebRequest $url -OutFile $out -UseBasicParsing
} catch {
    Write-Host ""
    Write-Host "  Download failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  The Windows installer may still be uploading to GitHub." -ForegroundColor DarkYellow
    Write-Host "  Please wait ~5 minutes and run this command again." -ForegroundColor DarkYellow
    Write-Host ""
    exit 1
}

Write-Host "  Installing..." -ForegroundColor Gray
Start-Process $out -Wait

Write-Host ""
Write-Host "  Done! Coffee CLI v$latestVer installed." -ForegroundColor Green
Write-Host "  Launch it from the Start Menu." -ForegroundColor Gray
Write-Host ""
