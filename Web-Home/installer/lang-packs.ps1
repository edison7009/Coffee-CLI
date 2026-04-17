<#
Language packs sub-menu. Loaded on demand by menu.ps1.
Detects the user's Claude Code engine (npm vs bun-compiled native) and
dispatches accordingly. Engine-aware so users get a clear message when
they hit the still-WIP native support path.

Depends on: Show-Menu (menu.ps1).
#>

$LANG_PACK_BASES = @(
    "https://coffeecli.com/lang-packs",
    "https://cdn.jsdelivr.net/gh/edison7009/Coffee-CLI@main/language-packs",
    "https://raw.githubusercontent.com/edison7009/Coffee-CLI/main/language-packs"
)

$LANGUAGE_PACKS = @(
    @{ Code = "zh-CN"; Label = "简体中文";       English = "Simplified Chinese"   },
    @{ Code = "ja-JP"; Label = "日本語";         English = "Japanese"             },
    @{ Code = "ko-KR"; Label = "한국어";         English = "Korean"               },
    @{ Code = "es-ES"; Label = "Español";        English = "Spanish"              },
    @{ Code = "fr-FR"; Label = "Français";       English = "French"               },
    @{ Code = "de-DE"; Label = "Deutsch";        English = "German"               },
    @{ Code = "pt-BR"; Label = "Português (BR)"; English = "Portuguese (Brazil)"  },
    @{ Code = "ru-RU"; Label = "Русский";        English = "Russian"              },
    @{ Code = "vi-VN"; Label = "Tiếng Việt";     English = "Vietnamese"           }
)

function Get-ActiveLanguage {
    $f = Join-Path $env:USERPROFILE ".coffee-cli\active-language"
    if (Test-Path $f) { return (Get-Content $f -Raw).Trim() }
    return ""
}

function Get-LangEnglish([string]$code) {
    $p = $LANGUAGE_PACKS | Where-Object { $_.Code -eq $code } | Select-Object -First 1
    if ($p) { return $p.English }
    return $code
}

function Get-ClaudeEngine {
    # Native Bun-compiled install (preferred by Anthropic going forward).
    $nativeExe = Join-Path $env:USERPROFILE ".local\bin\claude.exe"
    if (Test-Path $nativeExe) {
        $ver = "unknown"
        $versionsDir = Join-Path $env:USERPROFILE ".local\share\claude\versions"
        if (Test-Path $versionsDir) {
            $latest = Get-ChildItem $versionsDir -ErrorAction SilentlyContinue |
                      Sort-Object Name -Descending | Select-Object -First 1
            if ($latest) { $ver = $latest.Name }
        }
        return @{ Type = "bun"; Path = $nativeExe; Version = $ver }
    }

    # Legacy npm install - what existing lang-packs target.
    $npmRoot = $null
    try { $npmRoot = (& npm root -g 2>$null).Trim() } catch { }
    if ($npmRoot) {
        $cli = Join-Path $npmRoot "@anthropic-ai\claude-code\cli.js"
        if (Test-Path $cli) {
            $ver = "unknown"
            $pkg = Join-Path $npmRoot "@anthropic-ai\claude-code\package.json"
            if (Test-Path $pkg) {
                try { $ver = (Get-Content $pkg -Raw | ConvertFrom-Json).version } catch { }
            }
            return @{ Type = "npm"; Path = $cli; Version = $ver }
        }
    }

    return $null
}

function Get-LangPackScript([string]$relPath) {
    $errors = @()
    foreach ($base in $LANG_PACK_BASES) {
        $url = "$base/$relPath"
        try {
            $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20 -ErrorAction Stop
            $content = if ($resp.Content -is [byte[]]) {
                [System.Text.Encoding]::UTF8.GetString($resp.Content)
            } else {
                [string]$resp.Content
            }
            if ($content -match '(?i)<!DOCTYPE|<html') {
                $errors += "$url -> HTML (not a script)"
                continue
            }
            return $content
        } catch {
            $errors += "$url -> $($_.Exception.Message)"
        }
    }
    throw "Failed to fetch $relPath`n$($errors -join "`n")"
}

function Invoke-LangInstall([string]$code) {
    $english = Get-LangEnglish $code
    Write-Host ""
    Write-Host "  Installing language pack: $english..." -ForegroundColor Cyan
    try {
        $script = Get-LangPackScript "$code/install.ps1"
        Invoke-Expression $script
    } catch {
        Write-Host ""
        Write-Host "  [Error] Install failed: $_" -ForegroundColor Red
    }
}

function Invoke-LangUninstall([string]$code) {
    $english = Get-LangEnglish $code
    Write-Host ""
    Write-Host "  Uninstalling language pack: $english..." -ForegroundColor Yellow
    try {
        $script = Get-LangPackScript "$code/uninstall.ps1"
        Invoke-Expression $script
    } catch {
        Write-Host ""
        Write-Host "  [Error] Uninstall failed: $_" -ForegroundColor Red
    }
}

function Invoke-LanguageAction([string]$targetCode) {
    $engine = Get-ClaudeEngine
    if (-not $engine) {
        Clear-Host
        Write-Host ""
        Write-Host "  Claude Code not detected." -ForegroundColor Red
        Write-Host "  Install it first from the Install Agents menu." -ForegroundColor DarkGray
        Write-Host ""
        Read-Host "  Press Enter to continue" | Out-Null
        return
    }

    if ($engine.Type -eq "bun") {
        Clear-Host
        Write-Host ""
        Write-Host "  Native (Bun-compiled) Claude Code v$($engine.Version) detected" -ForegroundColor Yellow
        Write-Host "  at: $($engine.Path)" -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "  Language pack support for the native installer is under development." -ForegroundColor Yellow
        Write-Host "  Workaround: switch to the npm-installed Claude Code, which the" -ForegroundColor DarkGray
        Write-Host "  current language packs target:" -ForegroundColor DarkGray
        Write-Host "    1) Remove the native install (delete $($engine.Path))" -ForegroundColor DarkGray
        Write-Host "    2) Run: npm install -g @anthropic-ai/claude-code" -ForegroundColor DarkGray
        Write-Host ""
        Read-Host "  Press Enter to continue" | Out-Null
        return
    }

    Clear-Host
    $activeCode = Get-ActiveLanguage
    $activeEnglish = if ($activeCode) { Get-LangEnglish $activeCode } else { "" }
    $targetEnglish = Get-LangEnglish $targetCode

    if ($targetCode -eq "en") {
        if (-not $activeCode) {
            Write-Host ""
            Write-Host "  Claude Code is already in English. Nothing to do." -ForegroundColor Cyan
            Write-Host ""
            Read-Host "  Press Enter to continue" | Out-Null
            return
        }
        Write-Host ""
        Write-Host "  Currently active: $activeEnglish" -ForegroundColor Yellow
        Write-Host "  This will restore Claude Code to the original English." -ForegroundColor DarkGray
        $ans = Read-Host "  Continue? [Y/n]"
        if ($ans -ne "" -and $ans -notmatch "^[Yy]$") { return }
        Invoke-LangUninstall $activeCode
        Read-Host "`n  Press Enter to continue" | Out-Null
        return
    }

    if ($activeCode -eq $targetCode) {
        $sub = Show-Menu -Title "$targetEnglish is already active" -Items @(
            @{ Label = "Re-apply patch (fix after Claude upgrade)"; Act = "reapply"   },
            @{ Label = "Uninstall (restore English)";               Act = "uninstall" },
            @{ Label = "Back";                                      Action = "__back__" }
        )
        if ($sub.Action -eq "__back__") { return }
        if ($sub.Act -eq "reapply")   { Invoke-LangInstall   $targetCode }
        if ($sub.Act -eq "uninstall") { Invoke-LangUninstall $targetCode }
        Read-Host "`n  Press Enter to continue" | Out-Null
        return
    }

    if ($activeCode -and $activeCode -ne $targetCode) {
        Clear-Host
        Write-Host ""
        Write-Host "  Currently active: $activeEnglish" -ForegroundColor Yellow
        Write-Host "  Switching to $targetEnglish will:" -ForegroundColor DarkGray
        Write-Host "    1. Uninstall $activeEnglish" -ForegroundColor DarkGray
        Write-Host "    2. Restore English from backup" -ForegroundColor DarkGray
        Write-Host "    3. Apply $targetEnglish patch" -ForegroundColor DarkGray
        Write-Host ""
        $ans = Read-Host "  Continue? [Y/n]"
        if ($ans -ne "" -and $ans -notmatch "^[Yy]$") { return }
        Invoke-LangUninstall $activeCode
        Invoke-LangInstall   $targetCode
        Read-Host "`n  Press Enter to continue" | Out-Null
        return
    }

    Clear-Host
    Write-Host ""
    Write-Host "  Will install $targetEnglish language pack." -ForegroundColor Cyan
    $ans = Read-Host "  Continue? [Y/n]"
    if ($ans -ne "" -and $ans -notmatch "^[Yy]$") { return }
    Invoke-LangInstall $targetCode
    Read-Host "`n  Press Enter to continue" | Out-Null
}

# --- Menu loop -----------------------------------------------------------

while ($true) {
    $engine = Get-ClaudeEngine
    $activeCode = Get-ActiveLanguage
    $engineTag = if ($engine -eq $null) {
        "  [Claude Code not found]"
    } elseif ($engine.Type -eq "npm") {
        "  [npm v$($engine.Version)]"
    } elseif ($engine.Type -eq "bun") {
        "  [native v$($engine.Version) - unsupported]"
    } else { "" }

    $title = "Language Packs$engineTag"
    if ($activeCode) {
        $title += " - active: $(Get-LangEnglish $activeCode)"
    }

    $items = @()
    foreach ($lp in $LANGUAGE_PACKS) {
        $marker = if ($lp.Code -eq $activeCode) { "  *" } else { "" }
        $items += @{
            Label = "$($lp.Label) ($($lp.English))$marker"
            Code  = $lp.Code
        }
    }
    $items += @{ Label = "English (restore default)"; Code = "en" }
    $items += @{ Label = "Back"; Action = "__back__" }

    $choice = Show-Menu -Title $title -Items $items
    if ($choice.Action -eq "__back__") { return }
    if ($choice.Code) { Invoke-LanguageAction $choice.Code }
}
