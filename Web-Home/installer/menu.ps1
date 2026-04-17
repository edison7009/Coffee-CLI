<#
Root menu. Invoked by agent-tools-installer.ps1 via iex.
Exposes Show-Menu globally so sub-scripts (agents.ps1 / lang-packs.ps1 /
third-party.ps1) can reuse the same renderer and key handling.

Depends on Get-InstallerScript (defined in agent-tools-installer.ps1).
#>

function Global:Show-Menu {
    param(
        [Parameter(Mandatory)][string]$Title,
        [Parameter(Mandatory)][array]$Items,
        [switch]$RootMenu  # when set, Esc quits; otherwise Esc returns __back__
    )

    $sel = 0
    [Console]::CursorVisible = $false
    try {
        while ($true) {
            Clear-Host
            Write-Host ""
            Write-Host "  $Title" -ForegroundColor Cyan
            Write-Host ("  " + ("-" * [Math]::Min(60, $Title.Length))) -ForegroundColor DarkGray
            if ($RootMenu) {
                Write-Host "  Up/Down to move, Enter to select, Esc to quit" -ForegroundColor DarkGray
            } else {
                Write-Host "  Up/Down to move, Enter to select, Esc to go back" -ForegroundColor DarkGray
            }
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
    try {
        $script = Get-InstallerScript $scriptName
        Invoke-Expression $script
    } catch {
        Clear-Host
        Write-Host ""
        Write-Host "  [Error] Failed to load $scriptName" -ForegroundColor Red
        Write-Host "  $($_.Exception.Message)" -ForegroundColor DarkGray
        Write-Host ""
        Read-Host "  Press Enter to continue" | Out-Null
    }
}

$rootItems = @(
    @{ Label = "Install Agents";    Target = "agents.ps1" },
    @{ Label = "Language Packs";    Target = "lang-packs.ps1" },
    @{ Label = "Third-party Tools"; Target = "third-party.ps1" },
    @{ Label = "Exit";              Action = "__exit__" }
)

while ($true) {
    $choice = Show-Menu -Title "Coffee CLI Agent Installer" -Items $rootItems -RootMenu
    if ($choice.Action -eq "__exit__" -or $choice.Action -eq "__back__") {
        Clear-Host
        Write-Host ""
        Write-Host "  Goodbye!"
        Write-Host ""
        return
    }
    if ($choice.Target) {
        Invoke-SubMenu $choice.Target
    }
}
