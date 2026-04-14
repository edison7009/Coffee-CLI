# Coffee CLI Language Pack Installer — Русский
# Usage: iwr -useb https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/language-packs/ru-RU/install.ps1 | iex

$ErrorActionPreference = "Stop"
chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$LANG_CODE = "ru-RU"
$LANG_LABEL = "Русский"
$REPO_URL = "https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/language-packs/ru-RU"

Write-Host ""
Write-Host "  Coffee CLI Language Pack — $LANG_LABEL" -ForegroundColor Cyan
Write-Host "  ─────────────────────────────────" -ForegroundColor DarkGray

# 1. Find npm Claude Code
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) {
    Write-Host "  ERROR: npm not installed. Install Node.js first." -ForegroundColor Red
    exit 1
}
$NPM_ROOT = (npm root -g 2>$null).Trim()
$CLI_PATH = Join-Path $NPM_ROOT "@anthropic-ai\claude-code\cli.js"
if (-not (Test-Path $CLI_PATH)) {
    Write-Host "  ERROR: Claude Code not installed via npm." -ForegroundColor Red
    Write-Host "  Install it from the Coffee Installer menu first (option 1)." -ForegroundColor DarkGray
    exit 1
}

# 2. Get Claude Code version
$pkgJsonPath = Join-Path $NPM_ROOT "@anthropic-ai\claude-code\package.json"
$CLAUDE_VERSION = "unknown"
if (Test-Path $pkgJsonPath) {
    try {
        $CLAUDE_VERSION = (Get-Content $pkgJsonPath -Raw | ConvertFrom-Json).version
    } catch {}
}
Write-Host "  Detected Claude Code v$CLAUDE_VERSION" -ForegroundColor DarkGray

$COFFEE_DIR = Join-Path $env:USERPROFILE ".coffee-cli"
$BACKUP_DIR = Join-Path $COFFEE_DIR "backups"
$BACKUP = Join-Path $BACKUP_DIR "cli-$CLAUDE_VERSION.js"
New-Item -ItemType Directory -Force -Path $BACKUP_DIR | Out-Null

# 3. Backup original
if (-not (Test-Path $BACKUP)) {
    Write-Host "  Backing up original cli.js..." -ForegroundColor DarkGray
    Copy-Item $CLI_PATH $BACKUP -Force
}

# 4. Restore pristine
Write-Host "  Restoring pristine cli.js from backup..." -ForegroundColor DarkGray
Copy-Item $BACKUP $CLI_PATH -Force

# 5. Download patcher + dict to temp
$TMP = Join-Path $env:TEMP "coffee-langpack-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $TMP | Out-Null
try {
    Write-Host "  Downloading patcher and dictionary..." -ForegroundColor DarkGray
    Invoke-WebRequest -Uri "$REPO_URL/patch-cli.js" -OutFile (Join-Path $TMP "patch-cli.js") -UseBasicParsing
    Invoke-WebRequest -Uri "$REPO_URL/cli-translations.json" -OutFile (Join-Path $TMP "cli-translations.json") -UseBasicParsing

    # 6. Apply patch
    Write-Host "  Applying $LANG_LABEL patch..." -ForegroundColor DarkGray
    $COUNT = (node (Join-Path $TMP "patch-cli.js") $CLI_PATH (Join-Path $TMP "cli-translations.json"))
} finally {
    Remove-Item -Recurse -Force $TMP -ErrorAction SilentlyContinue
}

# 7. Mark active language
New-Item -ItemType Directory -Force -Path $COFFEE_DIR | Out-Null
[System.IO.File]::WriteAllText((Join-Path $COFFEE_DIR "active-language"), $LANG_CODE, [System.Text.UTF8Encoding]::new($false))

Write-Host ""
Write-Host "  ✓ Applied $COUNT translations" -ForegroundColor Green
Write-Host "  Claude Code is now in $LANG_LABEL." -ForegroundColor Green
Write-Host "  Run 'claude' to start. To revert, run the uninstall script." -ForegroundColor DarkGray
Write-Host ""
