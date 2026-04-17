<#
Root menu + shared helpers. Invoked by agent-tools-installer.ps1 via iex.

Exposes globally (so sub-scripts reuse them after being loaded via iex):
  Show-Menu          arrow-key selector with Esc-to-back
  Invoke-SubMenu     fetch + iex a sub-menu script
  Get-InstallerLang  resolve UI locale (user pref > Claude active-language > OS > en)
  Set-InstallerLang  persist user locale choice
  Get-MenuI18n       fetch + cache i18n/<menu>.json
  T                  lookup a key in a menu dict, interpolate {vars}

Depends on: Get-InstallerScript (defined in agent-tools-installer.ps1).
#>

$SUPPORTED_LANGS = @(
    @{ Code = "en";    Label = "English"   },
    @{ Code = "zh-CN"; Label = "简体中文"   }
)

function Global:Get-InstallerLang {
    # 1. user preference (highest priority)
    $pref = Join-Path $env:USERPROFILE ".coffee-cli\installer-lang"
    if (Test-Path $pref) {
        $v = (Get-Content $pref -Raw -ErrorAction SilentlyContinue).Trim()
        if ($v) { return $v }
    }
    # 2. active Claude Code language pack (probably the user's language)
    $active = Join-Path $env:USERPROFILE ".coffee-cli\active-language"
    if (Test-Path $active) {
        $v = (Get-Content $active -Raw -ErrorAction SilentlyContinue).Trim()
        if ($v) { return $v }
    }
    # 3. OS locale mapped to our supported set
    try {
        $sys = (Get-Culture).Name
        if ($sys -match "^zh") { return "zh-CN" }
        if ($sys -match "^ja") { return "ja-JP" }
        if ($sys -match "^ko") { return "ko-KR" }
    } catch { }
    return "en"
}

function Global:Set-InstallerLang([string]$code) {
    $dir = Join-Path $env:USERPROFILE ".coffee-cli"
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $f = Join-Path $dir "installer-lang"
    [System.IO.File]::WriteAllText($f, $code, [System.Text.UTF8Encoding]::new($false))
}

function Global:Get-MenuI18n([string]$menuName) {
    if ($Global:CoffeeI18nCache.ContainsKey($menuName)) {
        return $Global:CoffeeI18nCache[$menuName]
    }
    try {
        $json = Get-InstallerScript "i18n/$menuName.json"
        $dict = $json | ConvertFrom-Json
        $Global:CoffeeI18nCache[$menuName] = $dict
        return $dict
    } catch {
        return $null
    }
}

function Global:T {
    param(
        [Parameter(Mandatory)][object]$Dict,
        [Parameter(Mandatory)][string]$Key,
        [hashtable]$Vars
    )
    if ($null -eq $Dict) { return $Key }
    $lang = Get-InstallerLang
    $entry = $Dict.$Key
    if ($null -eq $entry) { return $Key }
    $text = $entry.$lang
    if (-not $text) { $text = $entry.'en' }
    if (-not $text) { return $Key }
    if ($Vars) {
        foreach ($k in $Vars.Keys) {
            $text = $text.Replace("{$k}", [string]$Vars[$k])
        }
    }
    return $text
}

function Global:Show-Menu {
    param(
        [Parameter(Mandatory)][string]$Title,
        [Parameter(Mandatory)][array]$Items,
        [switch]$RootMenu
    )

    $menuDict = Get-MenuI18n "menu"
    $navHint = if ($RootMenu) {
        T $menuDict "nav.root_hint"
    } else {
        T $menuDict "nav.sub_hint"
    }

    $sel = 0
    [Console]::CursorVisible = $false
    try {
        while ($true) {
            Clear-Host
            Write-Host ""
            Write-Host "  $Title" -ForegroundColor Cyan
            Write-Host ("  " + ("-" * [Math]::Min(60, $Title.Length))) -ForegroundColor DarkGray
            Write-Host "  $navHint" -ForegroundColor DarkGray
            Write-Host ""

            for ($i = 0; $i -lt $Items.Count; $i++) {
                $label = [string]$Items[$i].Label
                $pad = $label.PadRight(52)
                if ($i -eq $sel) {
                    Write-Host "  > $pad" -ForegroundColor White -BackgroundColor DarkCyan
                } else {
                    Write-Host "    $pad"
                }
            }
            Write-Host ""

            $key = [Console]::ReadKey($true)
            switch ($key.Key) {
                "UpArrow"   { if ($sel -le 0) { $sel = $Items.Count - 1 } else { $sel-- } }
                "DownArrow" { if ($sel -ge $Items.Count - 1) { $sel = 0 } else { $sel++ } }
                "Enter"     { return $Items[$sel] }
                "Escape"    { return @{ Action = "__back__" } }
            }
        }
    } finally {
        [Console]::CursorVisible = $true
    }
}

function Global:Invoke-SubMenu([string]$scriptName) {
    $menuDict = Get-MenuI18n "menu"
    try {
        $script = Get-InstallerScript $scriptName
        Invoke-Expression $script
    } catch {
        Clear-Host
        Write-Host ""
        Write-Host (T $menuDict "common.error_load_submenu" @{ name = $scriptName }) -ForegroundColor Red
        Write-Host "  $($_.Exception.Message)" -ForegroundColor DarkGray
        Write-Host ""
        Read-Host ("  " + (T $menuDict "common.press_enter_continue")) | Out-Null
    }
}

function Invoke-LanguagePicker {
    $menuDict = Get-MenuI18n "menu"
    $current = Get-InstallerLang

    $items = @()
    foreach ($l in $SUPPORTED_LANGS) {
        $marker = if ($l.Code -eq $current) { "  *" } else { "" }
        $items += @{ Label = "$($l.Label)$marker"; Code = $l.Code }
    }
    $items += @{ Label = (T $menuDict "root.exit"); Action = "__back__" }

    $choice = Show-Menu -Title (T $menuDict "lang_picker.title") -Items $items
    if ($choice.Action -eq "__back__") { return }
    if ($choice.Code) {
        Set-InstallerLang $choice.Code
        # Invalidate i18n cache so next render uses new locale immediately.
        $Global:CoffeeI18nCache.Clear()
        Clear-Host
        Write-Host ""
        Write-Host (T (Get-MenuI18n "menu") "lang_picker.saved") -ForegroundColor Green
        Write-Host ""
        Start-Sleep -Milliseconds 700
    }
}

# --- Root menu loop -----------------------------------------------------

while ($true) {
    $menuDict = Get-MenuI18n "menu"
    $rootItems = @(
        @{ Label = (T $menuDict "root.install_agents");   Target = "agents.ps1" },
        @{ Label = (T $menuDict "root.third_party");      Target = "third-party.ps1" },
        @{ Label = (T $menuDict "root.language_picker");  Action = "__lang__" },
        @{ Label = (T $menuDict "root.exit");             Action = "__exit__" }
    )

    $choice = Show-Menu -Title (T $menuDict "title") -Items $rootItems -RootMenu
    if ($choice.Action -eq "__exit__" -or $choice.Action -eq "__back__") {
        Clear-Host
        Write-Host ""
        Write-Host ("  " + (T $menuDict "common.goodbye"))
        Write-Host ""
        return
    }
    if ($choice.Action -eq "__lang__") {
        Invoke-LanguagePicker
        continue
    }
    if ($choice.Target) {
        Invoke-SubMenu $choice.Target
    }
}
