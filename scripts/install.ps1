<#
.SYNOPSIS
One-line installer for Coffee CLI via Windows PowerShell.
#>

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Update this URL to wherever the zip is actually hosted
$DOWNLOAD_URL = "https://your-domain.com/downloads/coffee-cli-windows-amd64.zip"

$InstallDir = Join-Path $env:USERPROFILE ".coffee-cli"
$ZipTarget = Join-Path $env:TEMP "coffee-cli-install.zip"

Write-Host "`n⚡ Installing Coffee CLI...`n" -ForegroundColor Cyan

# 1. Download
Write-Host "📥 Downloading from cloud..."
Invoke-WebRequest -Uri $DOWNLOAD_URL -OutFile $ZipTarget -UseBasicParsing

# 2. Extract
Write-Host "📦 Extracting files..."
if (Test-Path $InstallDir) {
    Remove-Item -Path "$InstallDir\*" -Recurse -Force
} else {
    New-Item -ItemType Directory -Path $InstallDir | Out-Null
}

Expand-Archive -Path $ZipTarget -DestinationPath $InstallDir -Force

# 3. Path Management
Write-Host "🔗 Configuring Environment Variables..."
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    $NewPath = "$UserPath;$InstallDir"
    [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
    $env:Path = "$env:Path;$InstallDir"
}

# Cleanup
Remove-Item $ZipTarget -Force

Write-Host "`n=======================================================" -ForegroundColor Green
Write-Host " ✅ Coffee CLI has been successfully installed!" -ForegroundColor Green
Write-Host "=======================================================" -ForegroundColor Green
Write-Host "`nTry running your new agentic terminal:" -ForegroundColor White
Write-Host "   > coffee-cli`n" -ForegroundColor Yellow
Write-Host "Note: If the command isn't recognized immediately," -ForegroundColor Gray
Write-Host "you may need to RESTART your powershell instance.`n" -ForegroundColor Gray
