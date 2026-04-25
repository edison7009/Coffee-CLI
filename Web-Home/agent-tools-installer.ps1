<#
.SYNOPSIS
Coffee CLI in-app installer is retired. This stub redirects to Coffee 101
(the Claude Code course on coffeecli.com) which is the new home for all
install + usage guides. Kept here so old `irm | iex` invocations and
v1.4.2-and-earlier app clients land on a friendly page instead of 404.

Usage (deprecated): irm https://coffeecli.com/agent-tools-installer.ps1 | iex
#>

$ErrorActionPreference = "SilentlyContinue"
chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$Url = "https://coffeecli.com/courses/claude-code"

Write-Host ""
Write-Host "  Coffee CLI's one-click installer has been retired." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Visit Coffee 101 for installation and usage guides:" -ForegroundColor Cyan
Write-Host "  $Url" -ForegroundColor Cyan
Write-Host ""

try { Start-Process $Url } catch { }
