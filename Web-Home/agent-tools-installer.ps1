<#
.SYNOPSIS
Coffee CLI Agent Installer - thin bootstrap.
Fetches the modular menu system from coffeecli.com (with jsDelivr/GitHub
fallback) and dispatches. Keeps user-visible startup near zero; all heavy
logic lives in remote sub-scripts so updates ship without a version bump.

Usage: irm https://coffeecli.com/agent-tools-installer.ps1 | iex
#>

$ErrorActionPreference = "SilentlyContinue"
chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# CDN bases tried in order. CF first (fast + China), jsDelivr + GitHub as tombstone.
$Global:CoffeeInstallerBases = @(
    "https://coffeecli.com/installer",
    "https://cdn.jsdelivr.net/gh/edison7009/Coffee-CLI@main/Web-Home/installer",
    "https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/Web-Home/installer"
)
$Global:CoffeeInstallerCache = @{}
$Global:CoffeeI18nCache = @{}

function Global:Get-InstallerScript([string]$name) {
    if ($Global:CoffeeInstallerCache.ContainsKey($name)) {
        return $Global:CoffeeInstallerCache[$name]
    }
    $errors = @()
    foreach ($base in $Global:CoffeeInstallerBases) {
        $url = "$base/$name"
        try {
            $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 8 -ErrorAction Stop
            $content = if ($resp.Content -is [byte[]]) {
                [System.Text.Encoding]::UTF8.GetString($resp.Content)
            } else {
                [string]$resp.Content
            }
            if ($content -match '(?i)<!DOCTYPE|<html') {
                $errors += "$url -> HTML (not a script)"
                continue
            }
            $Global:CoffeeInstallerCache[$name] = $content
            return $content
        } catch {
            $errors += "$url -> $($_.Exception.Message)"
        }
    }
    throw "Failed to fetch $name`n$($errors -join "`n")"
}

try {
    $menu = Get-InstallerScript "menu.ps1"
    Invoke-Expression $menu
} catch {
    Write-Host ""
    Write-Host "  [Error] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
}
