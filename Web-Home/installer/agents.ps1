<#
Agents sub-menu. Loaded on demand by menu.ps1.
Lazy-detects prerequisites: only checks npm/Node.js when the user picks an
npm-based agent. Invokes official install commands.

Depends on: Show-Menu (menu.ps1).
#>

function Test-IsChina {
    try {
        Invoke-RestMethod -Uri "https://www.google.com" -TimeoutSec 3 -ErrorAction Stop | Out-Null
        return $false
    } catch {
        return $true
    }
}

function Install-NodeIfMissing {
    if (Get-Command npm -ErrorAction SilentlyContinue) { return $true }

    Write-Host ""
    Write-Host "  npm not found. Node.js is required for this agent." -ForegroundColor Yellow
    $ans = Read-Host "  Install Node.js now? [Y/n]"
    if ($ans -ne "" -and $ans -notmatch "^[Yy]$") { return $false }

    $isChina = Test-IsChina
    $nodeUrl = if ($isChina) {
        "https://npmmirror.com/mirrors/node/v22.13.1/node-v22.13.1-x64.msi"
    } else {
        "https://nodejs.org/dist/v22.13.1/node-v22.13.1-x64.msi"
    }
    $msi = Join-Path $env:TEMP "nodejs-installer.msi"

    Write-Host "  Downloading Node.js..." -ForegroundColor Cyan
    try {
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest -Uri $nodeUrl -OutFile $msi -UseBasicParsing -ErrorAction Stop
        Start-Process "msiexec.exe" -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path","User")
    } catch {
        Write-Host "  [Error] Node.js install failed: $_" -ForegroundColor Red
        return $false
    }

    if (Get-Command npm -ErrorAction SilentlyContinue) {
        if ($isChina) {
            npm config set registry https://registry.npmmirror.com | Out-Null
        }
        Write-Host "  [OK] Node.js installed." -ForegroundColor Green
        return $true
    }
    Write-Host "  [Error] npm still not found after install. Restart shell and retry." -ForegroundColor Red
    return $false
}

function Get-AgentStatus([string]$cmdName) {
    if (Get-Command $cmdName -ErrorAction SilentlyContinue) { return "installed" }
    return ""
}

function Invoke-AgentAction {
    param(
        [string]$Name,
        [string]$Homepage,
        [string]$VerifyCmd,
        [scriptblock]$Install,
        [scriptblock]$Uninstall,
        [string]$DetectCmd,
        [switch]$RequiresNpm
    )

    Clear-Host
    $status = Get-AgentStatus $DetectCmd
    Write-Host ""
    Write-Host "  $Name" -ForegroundColor Cyan
    Write-Host ("  " + ("-" * $Name.Length)) -ForegroundColor DarkGray

    if ($status -eq "installed") {
        Write-Host "  Status: already installed" -ForegroundColor Green
        Write-Host ""
        $sub = Show-Menu -Title "$Name - choose action" -Items @(
            @{ Label = "Reinstall / Upgrade"; Act = "install"   },
            @{ Label = "Uninstall";           Act = "uninstall" },
            @{ Label = "Back";                Action = "__back__" }
        )
        if ($sub.Action -eq "__back__") { return }
        $action = $sub.Act
    } else {
        Write-Host "  Status: not installed" -ForegroundColor DarkGray
        Write-Host ""
        $ans = Read-Host "  Install $Name now? [Y/n]"
        if ($ans -ne "" -and $ans -notmatch "^[Yy]$") { return }
        $action = "install"
    }

    if ($action -eq "install") {
        if ($RequiresNpm -and -not (Install-NodeIfMissing)) {
            Read-Host "`n  Press Enter to continue" | Out-Null
            return
        }
        Write-Host ""
        Write-Host "  Installing $Name..." -ForegroundColor Cyan
        try {
            & $Install
            Write-Host ""
            Write-Host "  [OK] $Name installed" -ForegroundColor Green
            Write-Host "  Homepage : $Homepage" -ForegroundColor DarkGray
            Write-Host "  Verify   : $VerifyCmd" -ForegroundColor DarkGray
        } catch {
            Write-Host "  [Error] Install failed: $_" -ForegroundColor Red
        }
    } elseif ($action -eq "uninstall") {
        Write-Host ""
        Write-Host "  Uninstalling $Name..." -ForegroundColor Yellow
        try {
            & $Uninstall
            Write-Host "  [OK] $Name uninstalled" -ForegroundColor Green
        } catch {
            Write-Host "  [Error] Uninstall failed: $_" -ForegroundColor Red
        }
    }
    Read-Host "`n  Press Enter to continue" | Out-Null
}

# --- Menu loop -----------------------------------------------------------

$agentCatalog = @(
    @{
        Label     = "Claude Code"
        Detect    = "claude"
        Homepage  = "https://claude.ai/code"
        Verify    = "claude --version"
        Npm       = $true
        Install   = { npm install -g "@anthropic-ai/claude-code" }
        Uninstall = { npm uninstall -g "@anthropic-ai/claude-code" }
    },
    @{
        Label     = "Qwen Code"
        Detect    = "qwen"
        Homepage  = "https://qwen.ai/qwencode"
        Verify    = "qwen --version"
        Npm       = $true
        Install   = {
            $bat = Join-Path $env:TEMP "install-qwen.bat"
            Invoke-WebRequest -Uri "https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.bat" -OutFile $bat -UseBasicParsing -ErrorAction Stop
            & cmd /c "$bat --source qwenchat"
        }
        Uninstall = { npm uninstall -g "@qwen-code/qwen-code" }
    },
    @{
        Label     = "OpenCode CLI"
        Detect    = "opencode"
        Homepage  = "https://opencode.ai"
        Verify    = "opencode --version"
        Npm       = $true
        Install   = { npm install -g "opencode-ai@latest" }
        Uninstall = { npm uninstall -g "opencode-ai" }
    },
    @{
        Label     = "Hermes (Nous Research)"
        Detect    = "hermes"
        Homepage  = "https://hermes-agent.nousresearch.com"
        Verify    = "hermes --version"
        Npm       = $false
        Install   = {
            if (Get-Command uv -ErrorAction SilentlyContinue) { uv pip install hermes-agent }
            else { pip install hermes-agent }
        }
        Uninstall = {
            if (Get-Command uv -ErrorAction SilentlyContinue) { uv pip uninstall hermes-agent -y }
            else { pip uninstall hermes-agent -y }
        }
    }
)

while ($true) {
    $items = @()
    foreach ($a in $agentCatalog) {
        $status = Get-AgentStatus $a.Detect
        $suffix = if ($status -eq "installed") { "  [installed]" } else { "" }
        $items += @{ Label = $a.Label + $suffix; Target = $a.Label }
    }
    $items += @{ Label = "Back"; Action = "__back__" }

    $choice = Show-Menu -Title "Install Agents" -Items $items
    if ($choice.Action -eq "__back__") { return }

    $agent = $agentCatalog | Where-Object { $_.Label -eq $choice.Target } | Select-Object -First 1
    if (-not $agent) { continue }

    Invoke-AgentAction `
        -Name        $agent.Label `
        -Homepage    $agent.Homepage `
        -VerifyCmd   $agent.Verify `
        -Install     $agent.Install `
        -Uninstall   $agent.Uninstall `
        -DetectCmd   $agent.Detect `
        -RequiresNpm:$agent.Npm
}
