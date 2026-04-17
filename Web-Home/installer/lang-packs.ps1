<#
Language packs sub-menu. Loaded on demand by menu.ps1.
Detects the user's Claude Code engine (npm vs bun-compiled native) and
dispatches accordingly. Engine-aware so users get a clear message when
they hit the still-WIP native support path.

Depends on: Show-Menu, Get-MenuI18n, T (menu.ps1).
#>

$T = Get-MenuI18n "lang-packs"

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
    Write-Host ("  " + (T $T "msg.installing_pack" @{ name = $english })) -ForegroundColor Cyan
    try {
        $script = Get-LangPackScript "$code/install.ps1"
        Invoke-Expression $script
    } catch {
        Write-Host ""
        Write-Host ("  " + (T $T "msg.install_err" @{ err = $_ })) -ForegroundColor Red
    }
}

function Invoke-LangUninstall([string]$code) {
    $english = Get-LangEnglish $code
    Write-Host ""
    Write-Host ("  " + (T $T "msg.uninstalling_pack" @{ name = $english })) -ForegroundColor Yellow
    try {
        $script = Get-LangPackScript "$code/uninstall.ps1"
        Invoke-Expression $script
    } catch {
        Write-Host ""
        Write-Host ("  " + (T $T "msg.uninstall_err" @{ err = $_ })) -ForegroundColor Red
    }
}

function Wait-PressEnter {
    $menuDict = Get-MenuI18n "menu"
    Read-Host ("`n  " + (T $menuDict "common.press_enter_continue")) | Out-Null
}

function Invoke-LanguageAction([string]$targetCode) {
    $engine = Get-ClaudeEngine
    if (-not $engine) {
        Clear-Host
        Write-Host ""
        Write-Host ("  " + (T $T "err.no_claude")) -ForegroundColor Red
        Write-Host ("  " + (T $T "err.no_claude_detail")) -ForegroundColor DarkGray
        Write-Host ""
        Wait-PressEnter
        return
    }

    if ($engine.Type -eq "bun") {
        Clear-Host
        Write-Host ""
        Write-Host ("  " + (T $T "msg.native_detected" @{ ver = $engine.Version })) -ForegroundColor Yellow
        Write-Host ("  " + (T $T "msg.native_path"     @{ path = $engine.Path })) -ForegroundColor DarkGray
        Write-Host ""
        Write-Host ("  " + (T $T "msg.native_unsupported")) -ForegroundColor Yellow
        Write-Host ("  " + (T $T "msg.workaround_intro")) -ForegroundColor DarkGray
        Write-Host ("  " + (T $T "msg.workaround_target")) -ForegroundColor DarkGray
        Write-Host ("    " + (T $T "msg.workaround_step_1" @{ path = $engine.Path })) -ForegroundColor DarkGray
        Write-Host ("    " + (T $T "msg.workaround_step_2")) -ForegroundColor DarkGray
        Write-Host ""
        Wait-PressEnter
        return
    }

    Clear-Host
    $activeCode = Get-ActiveLanguage
    $activeEnglish = if ($activeCode) { Get-LangEnglish $activeCode } else { "" }
    $targetEnglish = Get-LangEnglish $targetCode

    if ($targetCode -eq "en") {
        if (-not $activeCode) {
            Write-Host ""
            Write-Host ("  " + (T $T "msg.already_english")) -ForegroundColor Cyan
            Write-Host ""
            Wait-PressEnter
            return
        }
        Write-Host ""
        Write-Host ("  " + (T $T "msg.currently_active" @{ active = $activeEnglish })) -ForegroundColor Yellow
        Write-Host ("  " + (T $T "msg.restore_english_intro")) -ForegroundColor DarkGray
        $ans = Read-Host ("  " + (T $T "prompt.continue"))
        if ($ans -ne "" -and $ans -notmatch "^[Yy]$") { return }
        Invoke-LangUninstall $activeCode
        Wait-PressEnter
        return
    }

    if ($activeCode -eq $targetCode) {
        $sub = Show-Menu -Title (T $T "title.already_active" @{ name = $targetEnglish }) -Items @(
            @{ Label = (T $T "action.reapply");          Act = "reapply"   },
            @{ Label = (T $T "action.uninstall_english"); Act = "uninstall" },
            @{ Label = (T $T "label.back");              Action = "__back__" }
        )
        if ($sub.Action -eq "__back__") { return }
        if ($sub.Act -eq "reapply")   { Invoke-LangInstall   $targetCode }
        if ($sub.Act -eq "uninstall") { Invoke-LangUninstall $targetCode }
        Wait-PressEnter
        return
    }

    if ($activeCode -and $activeCode -ne $targetCode) {
        Clear-Host
        Write-Host ""
        Write-Host ("  " + (T $T "msg.currently_active" @{ active = $activeEnglish })) -ForegroundColor Yellow
        Write-Host ("  " + (T $T "msg.switch_intro"     @{ target = $targetEnglish })) -ForegroundColor DarkGray
        Write-Host ("    " + (T $T "msg.switch_step_1"  @{ current = $activeEnglish })) -ForegroundColor DarkGray
        Write-Host ("    " + (T $T "msg.switch_step_2")) -ForegroundColor DarkGray
        Write-Host ("    " + (T $T "msg.switch_step_3"  @{ target = $targetEnglish })) -ForegroundColor DarkGray
        Write-Host ""
        $ans = Read-Host ("  " + (T $T "prompt.continue"))
        if ($ans -ne "" -and $ans -notmatch "^[Yy]$") { return }
        Invoke-LangUninstall $activeCode
        Invoke-LangInstall   $targetCode
        Wait-PressEnter
        return
    }

    Clear-Host
    Write-Host ""
    Write-Host ("  " + (T $T "msg.clean_install_intro" @{ target = $targetEnglish })) -ForegroundColor Cyan
    $ans = Read-Host ("  " + (T $T "prompt.continue"))
    if ($ans -ne "" -and $ans -notmatch "^[Yy]$") { return }
    Invoke-LangInstall $targetCode
    Wait-PressEnter
}

# --- Menu loop -----------------------------------------------------------

while ($true) {
    $engine = Get-ClaudeEngine
    $activeCode = Get-ActiveLanguage
    $engineTag = if ($null -eq $engine) {
        T $T "engine.tag.none"
    } elseif ($engine.Type -eq "npm") {
        T $T "engine.tag.npm" @{ ver = $engine.Version }
    } elseif ($engine.Type -eq "bun") {
        T $T "engine.tag.bun" @{ ver = $engine.Version }
    } else { "" }

    $title = (T $T "title.base") + $engineTag
    if ($activeCode) {
        $title += T $T "title.active_suffix" @{ lang = (Get-LangEnglish $activeCode) }
    }

    $items = @()
    foreach ($lp in $LANGUAGE_PACKS) {
        $marker = if ($lp.Code -eq $activeCode) { "  *" } else { "" }
        $items += @{
            Label = "$($lp.Label) ($($lp.English))$marker"
            Code  = $lp.Code
        }
    }
    $items += @{ Label = (T $T "label.english_restore"); Code = "en" }
    $items += @{ Label = (T $T "label.back");            Action = "__back__" }

    $choice = Show-Menu -Title $title -Items $items
    if ($choice.Action -eq "__back__") { return }
    if ($choice.Code) { Invoke-LanguageAction $choice.Code }
}
