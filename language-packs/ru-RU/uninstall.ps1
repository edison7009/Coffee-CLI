# Coffee CLI Language Pack Uninstaller — Русский
# Usage: iwr -useb https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/language-packs/ru-RU/uninstall.ps1 | iex

$ErrorActionPreference = "Stop"
chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$LANG_LABEL = "Русский"

Write-Host ""
Write-Host "  Coffee CLI Language Pack — Uninstall $LANG_LABEL" -ForegroundColor Cyan
Write-Host "  ─────────────────────────────────────────" -ForegroundColor DarkGray

$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    Write-Host "  ERROR: npm not installed." -ForegroundColor Red
    exit 1
}
$NPM_ROOT = (npm root -g 2>$null).Trim()
$CLI_PATH = Join-Path $NPM_ROOT "@anthropic-ai\claude-code\cli.js"
if (-not (Test-Path $CLI_PATH)) {
    Write-Host "  Claude Code not installed; nothing to uninstall." -ForegroundColor Yellow
    exit 0
}

$pkgJsonPath = Join-Path $NPM_ROOT "@anthropic-ai\claude-code\package.json"
$CLAUDE_VERSION = "unknown"
if (Test-Path $pkgJsonPath) {
    try {
        $CLAUDE_VERSION = (Get-Content $pkgJsonPath -Raw | ConvertFrom-Json).version
    } catch {}
}
$BACKUP = Join-Path $env:USERPROFILE ".coffee-cli\backups\cli-$CLAUDE_VERSION.js"

if (-not (Test-Path $BACKUP)) {
    Write-Host "  No backup found for Claude Code v$CLAUDE_VERSION." -ForegroundColor Yellow
    Write-Host "  To restore the original English version, run:" -ForegroundColor DarkGray
    Write-Host "    npm install -g @anthropic-ai/claude-code" -ForegroundColor DarkGray
    exit 1
}

Write-Host "  Restoring original cli.js from backup..." -ForegroundColor DarkGray
Copy-Item $BACKUP $CLI_PATH -Force
Remove-Item -Force (Join-Path $env:USERPROFILE ".coffee-cli\active-language") -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "  ✓ Claude Code restored to original English." -ForegroundColor Green
Write-Host ""
