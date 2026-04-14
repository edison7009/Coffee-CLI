<#
.SYNOPSIS
Interactive AI Agent installer via Windows PowerShell.
#>
$ErrorActionPreference = "SilentlyContinue"
chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# ── Helpers ───────────────────────────────────────────────────────────────────

function Ask-YN($prompt) {
    $reply = Read-Host "  $prompt [Y/n]"
    return ($reply -eq "" -or $reply -match "^[Yy]$")
}

function Pause-Return {
    Read-Host "`n  Press Enter to return to menu" | Out-Null
}

function Show-Success($name, $homepage, $cmd) {
    Write-Host "`n----------------------------------------" -ForegroundColor DarkGray
    Write-Host "  [OK] $name installed!" -ForegroundColor Green
    Write-Host "  Homepage : $homepage" -ForegroundColor DarkGray
    Write-Host "  Verify   : $cmd" -ForegroundColor DarkGray
    Write-Host "----------------------------------------" -ForegroundColor DarkGray
    Pause-Return
}

function Run-Install($name, [scriptblock]$action) {
    try {
        & $action
        return $true
    } catch {
        Write-Host "`n  [Error] Installation failed: $_" -ForegroundColor Red
        Pause-Return
        return $false
    }
}

function Run-Uninstall($name, [scriptblock]$action) {
    try {
        & $action
        Write-Host "  [OK] $name uninstalled." -ForegroundColor Green
    } catch {
        Write-Host "  [Error] Uninstall failed: $_" -ForegroundColor Red
    }
    Pause-Return
}

# ── Startup ───────────────────────────────────────────────────────────────────

Clear-Host

Write-Host "============================" -ForegroundColor DarkGray
Write-Host ""
Write-Host "      Agent Installer" -ForegroundColor Cyan
Write-Host ""
Write-Host "============================" -ForegroundColor DarkGray
Write-Host ""

Write-Host "  Checking your environment..." -ForegroundColor DarkGray
Write-Host ""

# System info
$osVer = [System.Environment]::OSVersion.VersionString
Write-Host "    System        " -NoNewline
Write-Host $osVer -ForegroundColor Cyan

# Admin check
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "    Permissions   " -NoNewline
if ($isAdmin) {
    Write-Host "Administrator" -ForegroundColor Green
} else {
    Write-Host "Standard user (installers will request elevation)" -ForegroundColor Yellow
}

# Network detection
Write-Host "    Network       " -NoNewline
$isChina = $false
try {
    Invoke-RestMethod -Uri "https://www.google.com" -TimeoutSec 3 -ErrorAction Stop | Out-Null
    Write-Host "Global" -ForegroundColor Green
} catch {
    Write-Host "China — mirrors enabled" -ForegroundColor Yellow
    $isChina = $true
}

# Node.js check
$npmOK = $false
Write-Host "    Node.js       " -NoNewline
$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if ($npmCmd) {
    $nodeVer = & node --version 2>$null
    Write-Host "[OK] $nodeVer" -ForegroundColor Green
    $npmOK = $true
} else {
    Write-Host "[Missing]" -ForegroundColor Red
}

# Git check
$gitOK = $false
Write-Host "    Git           " -NoNewline
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) {
    $gitVer = (& git --version 2>$null) -replace "git version ",""
    Write-Host "[OK] v$gitVer" -ForegroundColor Green
    $gitOK = $true
} else {
    Write-Host "[Missing]" -ForegroundColor Red
}

Write-Host ""

# ── Install Missing Deps ──────────────────────────────────────────────────────

if (-not $npmOK) {
    Write-Host "  Node.js is required to install agents." -ForegroundColor Yellow
    if (Ask-YN "Install Node.js now?") {
        Write-Host "`n  Downloading Node.js..." -ForegroundColor Cyan
        $ProgressPreference = "SilentlyContinue"
        $nodeUrl = if ($isChina) {
            "https://npmmirror.com/mirrors/node/v22.13.1/node-v22.13.1-x64.msi"
        } else {
            "https://nodejs.org/dist/v22.13.1/node-v22.13.1-x64.msi"
        }
        $msiPath = "$env:TEMP\nodejs-installer.msi"
        try {
            Invoke-WebRequest -Uri $nodeUrl -OutFile $msiPath -UseBasicParsing -ErrorAction Stop
            Start-Process "msiexec.exe" -ArgumentList "/i `"$msiPath`" /qn /norestart" -Wait
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                        [System.Environment]::GetEnvironmentVariable("Path","User")
            Write-Host "  [OK] Node.js installed." -ForegroundColor Green
            $npmOK = $true
        } catch {
            Write-Host "  [Error] Failed: $_" -ForegroundColor Red
        }
    } else {
        Write-Host "  Skipped — agent installs will fail without Node.js." -ForegroundColor DarkGray
    }
    Write-Host ""
}

if (-not $gitOK) {
    Write-Host "  Git is required by some agents (e.g. Claude Code)." -ForegroundColor Yellow
    if (Ask-YN "Install Git now?") {
        Write-Host "`n  Downloading Git..." -ForegroundColor Cyan
        $ProgressPreference = "SilentlyContinue"
        $gitUrl = if ($isChina) {
            "https://registry.npmmirror.com/-/binary/git-for-windows/v2.47.1.windows.1/Git-2.47.1-64-bit.exe"
        } else {
            "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe"
        }
        $exePath = "$env:TEMP\git-installer.exe"
        try {
            Invoke-WebRequest -Uri $gitUrl -OutFile $exePath -UseBasicParsing -ErrorAction Stop
            Start-Process $exePath -ArgumentList "/VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS" -Wait
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                        [System.Environment]::GetEnvironmentVariable("Path","User")
            Write-Host "  [OK] Git installed." -ForegroundColor Green
            $gitOK = $true
        } catch {
            Write-Host "  [Error] Failed: $_" -ForegroundColor Red
        }
    } else {
        Write-Host "  Skipped — some agents may not work without Git." -ForegroundColor DarkGray
    }
    Write-Host ""
}

# NPM mirror
if ($npmOK) {
    if ($isChina) {
        npm config set registry https://registry.npmmirror.com | Out-Null
    } else {
        npm config delete registry | Out-Null
    }
}

Read-Host "  All set! Press Enter to open the menu" | Out-Null

# ── Menu Loop ─────────────────────────────────────────────────────────────────

# ── Language Pack Helpers ─────────────────────────────────────────────────────

$LANG_PACK_CF_URL       = "https://coffeecli.com/lang-packs"
$LANG_PACK_JSDELIVR_URL = "https://cdn.jsdelivr.net/gh/edison7009/Coffee-CLI@main/language-packs"
$LANG_PACK_GITHUB_URL   = "https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/language-packs"

function Invoke-LangScript($relPath) {
    $errors = @()
    foreach ($base in @($LANG_PACK_CF_URL, $LANG_PACK_JSDELIVR_URL, $LANG_PACK_GITHUB_URL)) {
        $url = "$base/$relPath"
        try {
            $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
            $content = if ($resp.Content -is [byte[]]) {
                [System.Text.Encoding]::UTF8.GetString($resp.Content)
            } else {
                [string]$resp.Content
            }
            if ($content -match '(?i)<!DOCTYPE|<html') {
                $errors += "  $url -> returned HTML (not a script)"
                continue
            }
            return $content
        } catch {
            $errors += "  $url -> $($_.Exception.Message)"
        }
    }
    throw "Failed to fetch $relPath`n$($errors -join `"`n`")"
}

# Available language packs. Add new ones here when translation data ships.
$LANGUAGE_PACKS = @(
    @{ Code = "zh-CN"; Label = "简体中文";      English = "Simplified Chinese" },
    @{ Code = "ja-JP"; Label = "日本語";        English = "Japanese"           },
    @{ Code = "ko-KR"; Label = "한국어";        English = "Korean"             },
    @{ Code = "es-ES"; Label = "Español";       English = "Spanish"            },
    @{ Code = "fr-FR"; Label = "Français";      English = "French"             },
    @{ Code = "de-DE"; Label = "Deutsch";       English = "German"             },
    @{ Code = "pt-BR"; Label = "Português (BR)"; English = "Portuguese (Brazil)" },
    @{ Code = "ru-RU"; Label = "Русский";       English = "Russian"            },
    @{ Code = "vi-VN"; Label = "Tiếng Việt";    English = "Vietnamese"         }
)

function Get-ActiveLanguage {
    $f = Join-Path $env:USERPROFILE ".coffee-cli\active-language"
    if (Test-Path $f) { return (Get-Content $f -Raw).Trim() }
    return ""
}

function Get-LangLabel($code) {
    $pack = $LANGUAGE_PACKS | Where-Object { $_.Code -eq $code } | Select-Object -First 1
    if ($pack) { return $pack.Label }
    return $code
}

function Get-LangEnglish($code) {
    $pack = $LANGUAGE_PACKS | Where-Object { $_.Code -eq $code } | Select-Object -First 1
    if ($pack) { return $pack.English }
    return $code
}

function Invoke-LangPackInstall($code, $label) {
    $english = Get-LangEnglish $code
    # Use English name in progress line — CJK wide chars double-render in ConPTY.
    # The inner install.ps1 (run via Invoke-Expression) displays the native name correctly.
    Write-Host "`n  Installing language pack: $english..." -ForegroundColor Cyan
    try {
        $script = Invoke-LangScript "$code/install.ps1"
        Invoke-Expression $script
    } catch {
        Write-Host "`n  [Error] Install failed: $_" -ForegroundColor Red
    }
    Pause-Return
}

function Invoke-LangPackUninstall($code, $label) {
    $english = Get-LangEnglish $code
    Write-Host "`n  Uninstalling language pack: $english..." -ForegroundColor Yellow
    try {
        $script = Invoke-LangScript "$code/uninstall.ps1"
        Invoke-Expression $script
    } catch {
        Write-Host "`n  [Error] Uninstall failed: $_" -ForegroundColor Red
    }
    Pause-Return
}

function Invoke-LanguagePackAction($targetCode, $targetLabel) {
    $activeCode = Get-ActiveLanguage
    $activeEnglish = if ($activeCode) { Get-LangEnglish $activeCode } else { "" }
    $targetEnglish = Get-LangEnglish $targetCode

    # Special case: target = "en" means restore original
    if ($targetCode -eq "en") {
        if ($activeCode -eq "") {
            Write-Host "`n  Claude Code is already in English. Nothing to do." -ForegroundColor Cyan
            Pause-Return
            return
        }
        Write-Host "`n  Currently active language pack: $activeEnglish" -ForegroundColor Yellow
        Write-Host "  This will restore Claude Code to original English."
        if (-not (Ask-YN "  Continue?")) { return }
        Invoke-LangPackUninstall $activeCode $activeEnglish
        return
    }

    # Repeat install (re-patch, e.g. after Claude Code upgrade)
    if ($activeCode -eq $targetCode) {
        Write-Host "`n  $targetEnglish is already active." -ForegroundColor Yellow
        Write-Host "    1. Uninstall (restore English)"
        Write-Host "    2. Re-apply patch (fix after Claude Code upgrade)"
        $sub = Read-Host "  Choose [1/2/cancel]"
        switch ($sub) {
            "1" { Invoke-LangPackUninstall $targetCode $targetLabel }
            "2" { Invoke-LangPackInstall $targetCode $targetLabel }
            default { Write-Host "  Cancelled." }
        }
        return
    }

    # Switch from one language to another
    if ($activeCode -ne "" -and $activeCode -ne $targetCode) {
        Write-Host "`n  Currently active language pack: $activeEnglish" -ForegroundColor Yellow
        Write-Host "  Switching to $targetEnglish will:"
        Write-Host "    1. Uninstall $activeEnglish"
        Write-Host "    2. Restore English from backup"
        Write-Host "    3. Apply $targetEnglish patch"
        if (-not (Ask-YN "  Continue?")) { return }
        Invoke-LangPackUninstall $activeCode $activeEnglish
        Invoke-LangPackInstall $targetCode $targetLabel
        return
    }

    # Clean install
    Write-Host "`n  Will install $targetEnglish language pack." -ForegroundColor Cyan
    if (-not (Ask-YN "  Continue?")) { return }
    Invoke-LangPackInstall $targetCode $targetLabel
}

# ── Arrow-Key Interactive Menu ────────────────────────────────────────────────

function Draw-Menu {
    param([array]$Items, [int]$Sel)

    $activeCode = Get-ActiveLanguage
    $activeMark = if ($activeCode) { " [active: $(Get-LangLabel $activeCode)]" } else { "" }

    [Console]::SetCursorPosition(0, 0)
    Write-Host "                                                                        "
    [Console]::SetCursorPosition(0, 0)
    Write-Host ""
    Write-Host "  Agent Installer                        " -ForegroundColor Cyan
    Write-Host "  Arrow keys to move, Enter to select, Esc to quit" -ForegroundColor DarkGray
    Write-Host ""

    $lastSec = ""
    for ($i = 0; $i -lt $Items.Count; $i++) {
        $sec = $Items[$i].Section
        # Section headers
        if ($sec -ne $lastSec) {
            $lastSec = $sec
            switch ($sec) {
                "install"   { Write-Host "  --- Install ---                                  " -ForegroundColor Cyan }
                "lang"      { Write-Host "  --- Language Packs (Claude Code only)$activeMark ---" -ForegroundColor Cyan }
                "uninstall" { Write-Host "  --- Uninstall ---                                " -ForegroundColor Yellow }
            }
        }

        $label = $Items[$i].Label
        $pad = $label.PadRight(52)
        if ($i -eq $Sel) {
            Write-Host "  > $pad" -ForegroundColor White -BackgroundColor DarkCyan
        } else {
            Write-Host "    $pad"
        }
    }
    Write-Host ""
    Write-Host "                                                              "
}

# Build flat menu items list
$menu = @()
$menu += @{ Section = "install"; Label = "Claude Code";            Action = "i-claude"   }
$menu += @{ Section = "install"; Label = "OpenAI Codex CLI";       Action = "i-codex"    }
$menu += @{ Section = "install"; Label = "OpenCode CLI";           Action = "i-opencode" }
$menu += @{ Section = "install"; Label = "Hermes (Nous Research)"; Action = "i-hermes"   }
for ($i = 0; $i -lt $LANGUAGE_PACKS.Count; $i++) {
    $lp = $LANGUAGE_PACKS[$i]
    $menu += @{ Section = "lang"; Label = "$($lp.Label) ($($lp.English))"; Action = "lang-$($lp.Code)" }
}
$menu += @{ Section = "lang"; Label = "English (restore default)"; Action = "lang-en" }
$menu += @{ Section = "uninstall"; Label = "Claude Code";            Action = "u-claude"   }
$menu += @{ Section = "uninstall"; Label = "OpenAI Codex CLI";       Action = "u-codex"    }
$menu += @{ Section = "uninstall"; Label = "OpenCode CLI";           Action = "u-opencode" }
$menu += @{ Section = "uninstall"; Label = "Hermes";                 Action = "u-hermes"   }

$sel = 0
[Console]::CursorVisible = $false

try {
    Clear-Host
    while ($true) {
        Draw-Menu -Items $menu -Sel $sel

        $key = [Console]::ReadKey($true)

        switch ($key.Key) {
            "UpArrow" {
                $sel--
                if ($sel -lt 0) { $sel = $menu.Count - 1 }
            }
            "DownArrow" {
                $sel++
                if ($sel -ge $menu.Count) { $sel = 0 }
            }
            "Enter" {
                $act = $menu[$sel].Action
                [Console]::CursorVisible = $true
                Clear-Host

                switch -Wildcard ($act) {
                    "i-claude" {
                        Write-Host "`n  Installing Claude Code...`n" -ForegroundColor Cyan
                        $ok = Run-Install "Claude Code" { npm install -g @anthropic-ai/claude-code }
                        if ($ok) { Show-Success "Claude Code" "https://claude.ai/code" "claude --version" }
                    }
                    "i-codex" {
                        Write-Host "`n  Installing OpenAI Codex CLI...`n" -ForegroundColor Cyan
                        $ok = Run-Install "OpenAI Codex" { npm install -g @openai/codex@latest }
                        if ($ok) { Show-Success "OpenAI Codex CLI" "https://github.com/openai/codex" "codex --version" }
                    }
                    "i-opencode" {
                        Write-Host "`n  Installing OpenCode CLI...`n" -ForegroundColor Cyan
                        $ok = Run-Install "OpenCode" { npm install -g opencode-ai@latest }
                        if ($ok) { Show-Success "OpenCode CLI" "https://opencode.ai" "opencode --version" }
                    }
                    "i-hermes" {
                        Write-Host "`n  Installing Hermes (Nous Research)...`n" -ForegroundColor Cyan
                        $ok = Run-Install "Hermes" {
                            if (Get-Command uv -ErrorAction SilentlyContinue) { uv pip install hermes-agent }
                            else { Write-Host "  uv not found, trying pip..." -ForegroundColor Yellow; pip install hermes-agent }
                        }
                        if ($ok) { Show-Success "Hermes" "https://hermes-agent.nousresearch.com" "hermes --version" }
                    }
                    "lang-en" { Invoke-LanguagePackAction "en" "English" }
                    "lang-*" {
                        $code = $act -replace "^lang-", ""
                        $pack = $LANGUAGE_PACKS | Where-Object { $_.Code -eq $code } | Select-Object -First 1
                        if ($pack) { Invoke-LanguagePackAction $pack.Code $pack.Label }
                    }
                    "u-claude" {
                        Write-Host "`n  Uninstalling Claude Code...`n" -ForegroundColor Yellow
                        Run-Uninstall "Claude Code" { npm uninstall -g @anthropic-ai/claude-code }
                    }
                    "u-codex" {
                        Write-Host "`n  Uninstalling OpenAI Codex CLI...`n" -ForegroundColor Yellow
                        Run-Uninstall "OpenAI Codex CLI" { npm uninstall -g @openai/codex }
                    }
                    "u-opencode" {
                        Write-Host "`n  Uninstalling OpenCode CLI...`n" -ForegroundColor Yellow
                        Run-Uninstall "OpenCode CLI" { npm uninstall -g opencode-ai }
                    }
                    "u-hermes" {
                        Write-Host "`n  Uninstalling Hermes...`n" -ForegroundColor Yellow
                        Run-Uninstall "Hermes" {
                            if (Get-Command uv -ErrorAction SilentlyContinue) { uv pip uninstall hermes-agent -y }
                            else { pip uninstall hermes-agent -y }
                        }
                    }
                }

                [Console]::CursorVisible = $false
                Clear-Host
            }
            "Escape" {
                Clear-Host
                Write-Host "`n  Goodbye!`n"
                return
            }
        }
    }
} finally {
    [Console]::CursorVisible = $true
}
