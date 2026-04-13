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

$registryArgs = if ($isChina) { @("--registry=https://registry.npmmirror.com") } else { @() }

# ── Language Pack Helpers ─────────────────────────────────────────────────────

$LANG_PACK_BASE_URL = "https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/language-packs"

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

function Invoke-LangPackInstall($code, $label) {
    Write-Host "`n  Installing language pack: $label..." -ForegroundColor Cyan
    $url = "$LANG_PACK_BASE_URL/$code/install.ps1"
    try {
        $script = (Invoke-WebRequest -Uri $url -UseBasicParsing).Content
        Invoke-Expression $script
    } catch {
        Write-Host "`n  [Error] Install failed: $_" -ForegroundColor Red
    }
    Pause-Return
}

function Invoke-LangPackUninstall($code, $label) {
    Write-Host "`n  Uninstalling language pack: $label..." -ForegroundColor Yellow
    $url = "$LANG_PACK_BASE_URL/$code/uninstall.ps1"
    try {
        $script = (Invoke-WebRequest -Uri $url -UseBasicParsing).Content
        Invoke-Expression $script
    } catch {
        Write-Host "`n  [Error] Uninstall failed: $_" -ForegroundColor Red
    }
    Pause-Return
}

function Invoke-LanguagePackAction($targetCode, $targetLabel) {
    $activeCode = Get-ActiveLanguage
    $activeLabel = if ($activeCode) { Get-LangLabel $activeCode } else { "" }

    # Special case: target = "en" means restore original
    if ($targetCode -eq "en") {
        if ($activeCode -eq "") {
            Write-Host "`n  Claude Code is already in English. Nothing to do." -ForegroundColor Cyan
            Pause-Return
            return
        }
        Write-Host "`n  Currently active language pack: $activeLabel" -ForegroundColor Yellow
        Write-Host "  This will restore Claude Code to original English."
        if (-not (Ask-YN "  Continue?")) { return }
        Invoke-LangPackUninstall $activeCode $activeLabel
        return
    }

    # Repeat install (re-patch, e.g. after Claude Code upgrade)
    if ($activeCode -eq $targetCode) {
        Write-Host "`n  $targetLabel is already active." -ForegroundColor Yellow
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
        Write-Host "`n  Currently active language pack: $activeLabel" -ForegroundColor Yellow
        Write-Host "  Switching to $targetLabel will:"
        Write-Host "    1. Uninstall $activeLabel"
        Write-Host "    2. Restore English from backup"
        Write-Host "    3. Apply $targetLabel patch"
        if (-not (Ask-YN "  Continue?")) { return }
        Invoke-LangPackUninstall $activeCode $activeLabel
        Invoke-LangPackInstall $targetCode $targetLabel
        return
    }

    # Clean install
    Write-Host "`n  Will install $targetLabel language pack." -ForegroundColor Cyan
    if (-not (Ask-YN "  Continue?")) { return }
    Invoke-LangPackInstall $targetCode $targetLabel
}

while ($true) {
    Clear-Host

    $activeCode = Get-ActiveLanguage
    $activeMark = if ($activeCode) { " (current: $(Get-LangLabel $activeCode))" } else { "" }

    Write-Host "`n=== Install ===" -ForegroundColor Cyan
    Write-Host "  1.  Claude Code"
    Write-Host "  2.  OpenAI Codex CLI"
    Write-Host "  3.  OpenCode CLI"
    Write-Host "  4.  Hermes (Nous Research)"
    Write-Host "`n=== Language Packs$activeMark ===" -ForegroundColor Cyan
    Write-Host "  L1. 简体中文         (Simplified Chinese)"
    Write-Host "  L2. 日本語           (Japanese)"
    Write-Host "  L3. 한국어           (Korean)"
    Write-Host "  L4. Español          (Spanish)"
    Write-Host "  L5. Français         (French)"
    Write-Host "  L6. Deutsch          (German)"
    Write-Host "  L7. Português (BR)   (Portuguese, Brazil)"
    Write-Host "  L8. Русский          (Russian)"
    Write-Host "  L9. Tiếng Việt       (Vietnamese)"
    Write-Host "  LE. English           (restore default)"
    Write-Host "`n=== Uninstall ===" -ForegroundColor Yellow
    Write-Host "  5.  Claude Code"
    Write-Host "  6.  OpenAI Codex CLI"
    Write-Host "  7.  OpenCode CLI"
    Write-Host "  8.  Hermes"
    Write-Host "`n  q.  Quit" -ForegroundColor DarkGray
    Write-Host "--------------------------------"

    $choice = Read-Host ">>> Select"

    switch ($choice) {
        "1" {
            Write-Host "`n  Installing Claude Code...`n" -ForegroundColor Cyan
            $ok = Run-Install "Claude Code" {
                npm install -g @anthropic-ai/claude-code @registryArgs
            }
            if ($ok) { Show-Success "Claude Code" "https://claude.ai/code" "claude --version" }
        }
        "2" {
            Write-Host "`n  Installing OpenAI Codex CLI...`n" -ForegroundColor Cyan
            $ok = Run-Install "OpenAI Codex" {
                npm install -g @openai/codex@latest @registryArgs
            }
            if ($ok) { Show-Success "OpenAI Codex CLI" "https://github.com/openai/codex" "codex --version" }
        }
        "3" {
            Write-Host "`n  Installing OpenCode CLI...`n" -ForegroundColor Cyan
            $ok = Run-Install "OpenCode" {
                npm install -g opencode-ai@latest @registryArgs
            }
            if ($ok) { Show-Success "OpenCode CLI" "https://opencode.ai" "opencode --version" }
        }
        "4" {
            Write-Host "`n  Installing Hermes (Nous Research)...`n" -ForegroundColor Cyan
            $ok = Run-Install "Hermes" {
                if (Get-Command uv -ErrorAction SilentlyContinue) {
                    uv pip install hermes-agent
                } else {
                    Write-Host "  uv not found, trying pip..." -ForegroundColor Yellow
                    pip install hermes-agent
                }
            }
            if ($ok) { Show-Success "Hermes" "https://hermes-agent.nousresearch.com" "hermes --version" }
        }
        "5" {
            Write-Host "`n  Uninstalling Claude Code...`n" -ForegroundColor Yellow
            Run-Uninstall "Claude Code" { npm uninstall -g @anthropic-ai/claude-code }
        }
        "6" {
            Write-Host "`n  Uninstalling OpenAI Codex CLI...`n" -ForegroundColor Yellow
            Run-Uninstall "OpenAI Codex CLI" { npm uninstall -g @openai/codex }
        }
        "7" {
            Write-Host "`n  Uninstalling OpenCode CLI...`n" -ForegroundColor Yellow
            Run-Uninstall "OpenCode CLI" { npm uninstall -g opencode-ai }
        }
        "8" {
            Write-Host "`n  Uninstalling Hermes...`n" -ForegroundColor Yellow
            Run-Uninstall "Hermes" {
                if (Get-Command uv -ErrorAction SilentlyContinue) {
                    uv pip uninstall hermes-agent -y
                } else {
                    pip uninstall hermes-agent -y
                }
            }
        }
        { $_ -match "^[Ll]([1-9])$" } {
            $idx = [int]$matches[1] - 1
            if ($idx -lt $LANGUAGE_PACKS.Count) {
                $pack = $LANGUAGE_PACKS[$idx]
                Invoke-LanguagePackAction $pack.Code $pack.Label
            } else {
                Write-Host "  Invalid language pack option." -ForegroundColor Red
                Start-Sleep -Seconds 1
            }
        }
        { $_ -eq "LE" -or $_ -eq "le" } { Invoke-LanguagePackAction "en" "English" }
        "q" {
            Write-Host "`n  Goodbye!`n"
            break
        }
        default {
            Write-Host "  Invalid option." -ForegroundColor Red
            Start-Sleep -Seconds 1
        }
    }
}
