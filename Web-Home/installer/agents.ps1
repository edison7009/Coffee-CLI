<#
Agents sub-menu. Loaded on demand by menu.ps1.
Lazy-detects prerequisites: only checks npm/Node.js when the user picks an
npm-based agent. Invokes official install commands.

Depends on: Show-Menu, Get-MenuI18n, T (menu.ps1).
#>

$T = Get-MenuI18n "agents"

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
    Write-Host ("  " + (T $T "node.required")) -ForegroundColor Yellow
    $ans = Read-Host ("  " + (T $T "node.install_prompt"))
    if ($ans -ne "" -and $ans -notmatch "^[Yy]$") { return $false }

    $isChina = Test-IsChina
    $nodeUrl = if ($isChina) {
        "https://npmmirror.com/mirrors/node/v22.13.1/node-v22.13.1-x64.msi"
    } else {
        "https://nodejs.org/dist/v22.13.1/node-v22.13.1-x64.msi"
    }
    $msi = Join-Path $env:TEMP "nodejs-installer.msi"

    Write-Host ("  " + (T $T "node.downloading")) -ForegroundColor Cyan
    try {
        $ProgressPreference = "SilentlyContinue"
        Invoke-WebRequest -Uri $nodeUrl -OutFile $msi -UseBasicParsing -ErrorAction Stop
        Start-Process "msiexec.exe" -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("Path","User")
    } catch {
        Write-Host ("  " + (T $T "node.download_err" @{ err = $_ })) -ForegroundColor Red
        return $false
    }

    if (Get-Command npm -ErrorAction SilentlyContinue) {
        if ($isChina) {
            npm config set registry https://registry.npmmirror.com | Out-Null
        }
        Write-Host ("  " + (T $T "node.install_ok")) -ForegroundColor Green
        return $true
    }
    Write-Host ("  " + (T $T "node.npm_not_found")) -ForegroundColor Red
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
        Write-Host ("  " + (T $T "status.installed")) -ForegroundColor Green
        Write-Host ""
        $sub = Show-Menu -Title (T $T "action.title" @{ name = $Name }) -Items @(
            @{ Label = (T $T "action.reinstall"); Act = "install"   },
            @{ Label = (T $T "action.uninstall"); Act = "uninstall" },
            @{ Label = (T $T "action.back");      Action = "__back__" }
        )
        if ($sub.Action -eq "__back__") { return }
        $action = $sub.Act
    } else {
        Write-Host ("  " + (T $T "status.not_installed")) -ForegroundColor DarkGray
        Write-Host ""
        $ans = Read-Host ("  " + (T $T "prompt.install_confirm" @{ name = $Name }))
        if ($ans -ne "" -and $ans -notmatch "^[Yy]$") { return }
        $action = "install"
    }

    if ($action -eq "install") {
        if ($RequiresNpm -and -not (Install-NodeIfMissing)) {
            Read-Host ("`n  " + (T $T "msg.skipped_needs_node")) | Out-Null
            return
        }
        Write-Host ""
        Write-Host ("  " + (T $T "msg.installing" @{ name = $Name })) -ForegroundColor Cyan
        try {
            & $Install
            Write-Host ""
            Write-Host ("  " + (T $T "msg.install_ok" @{ name = $Name })) -ForegroundColor Green
            Write-Host ("  " + (T $T "msg.homepage" @{ url = $Homepage })) -ForegroundColor DarkGray
            Write-Host ("  " + (T $T "msg.verify"   @{ cmd = $VerifyCmd })) -ForegroundColor DarkGray
        } catch {
            Write-Host ("  " + (T $T "msg.install_err" @{ err = $_ })) -ForegroundColor Red
        }
    } elseif ($action -eq "uninstall") {
        Write-Host ""
        Write-Host ("  " + (T $T "msg.uninstalling" @{ name = $Name })) -ForegroundColor Yellow
        try {
            & $Uninstall
            Write-Host ("  " + (T $T "msg.uninstall_ok" @{ name = $Name })) -ForegroundColor Green
        } catch {
            Write-Host ("  " + (T $T "msg.uninstall_err" @{ err = $_ })) -ForegroundColor Red
        }
    }
    $menuDict = Get-MenuI18n "menu"
    Read-Host ("`n  " + (T $menuDict "common.press_enter_continue")) | Out-Null
}

# --- Menu loop -----------------------------------------------------------

$agentCatalog = @(
    @{
        Key       = "label.claude"
        Detect    = "claude"
        Homepage  = "https://claude.ai/code"
        Verify    = "claude --version"
        Npm       = $false
        Install   = {
            # Anthropic official native installer (Bun-compiled standalone).
            # Guard against GFW/CDN interception returning the marketing HTML page
            # instead of the actual PowerShell script (seen in CN networks where
            # the URL resolves to a Webflow landing page and the embedded JS
            # gets fed to iex, producing parser errors).
            $url = "https://claude.ai/install.ps1"
            $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
            $script = if ($resp.Content -is [byte[]]) {
                [System.Text.Encoding]::UTF8.GetString($resp.Content)
            } else {
                [string]$resp.Content
            }
            # Build HTML-doc prefixes by concatenation so this file does not
            # literally contain "<!DOCTYPE" / "<html" substrings, which would
            # make the bootstrap's own HTML-sanity grep reject agents.ps1 when
            # it loads us. Self-reference trap dodged.
            $pfxDoctype = '{0}{1}DOCTYPE' -f [char]0x3C, [char]0x21
            $pfxHtml    = '{0}html'       -f [char]0x3C
            $pfxComment = '{0}{1}--'      -f [char]0x3C, [char]0x21
            $pfxXml     = '{0}{1}xml'     -f [char]0x3C, [char]0x3F
            $head = $script.TrimStart([char]0xFEFF, ' ', "`t", "`r", "`n")
            $isHtml = $head.StartsWith($pfxDoctype, [StringComparison]::OrdinalIgnoreCase) `
                  -or $head.StartsWith($pfxHtml,    [StringComparison]::OrdinalIgnoreCase) `
                  -or $head.StartsWith($pfxComment) `
                  -or $head.StartsWith($pfxXml)
            if ($isHtml) {
                throw "claude.ai/install.ps1 returned a webpage instead of a script (likely network interception or CDN edge error). Try a different network, or install manually: https://docs.anthropic.com/claude-code/install"
            }
            if ($script.Length -lt 200) {
                throw "claude.ai/install.ps1 returned a suspiciously short response ($($script.Length) bytes)"
            }
            Invoke-Expression $script
        }
        Uninstall = {
            # Native installer places the binary at ~/.local/bin and versioned
            # copies under ~/.local/share/claude/versions/. Remove both.
            $bin = Join-Path $env:USERPROFILE ".local\bin\claude.exe"
            $share = Join-Path $env:USERPROFILE ".local\share\claude"
            if (Test-Path $bin)   { Remove-Item -Force $bin }
            if (Test-Path $share) { Remove-Item -Recurse -Force $share }
        }
    },
    @{
        Key       = "label.qwen"
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
        Key       = "label.opencode"
        Detect    = "opencode"
        Homepage  = "https://opencode.ai"
        Verify    = "opencode --version"
        Npm       = $true
        Install   = { npm install -g "opencode-ai@latest" }
        Uninstall = { npm uninstall -g "opencode-ai" }
    },
    @{
        Key       = "label.hermes"
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
        $name = T $T $a.Key
        $status = Get-AgentStatus $a.Detect
        $suffix = if ($status -eq "installed") { T $T "status.installed_suffix" } else { "" }
        $items += @{ Label = "$name$suffix"; Target = $a.Key }
    }
    $items += @{ Label = (T $T "action.back"); Action = "__back__" }

    $choice = Show-Menu -Title (T $T "title") -Items $items
    if ($choice.Action -eq "__back__") { return }

    $agent = $agentCatalog | Where-Object { $_.Key -eq $choice.Target } | Select-Object -First 1
    if (-not $agent) { continue }

    Invoke-AgentAction `
        -Name        (T $T $agent.Key) `
        -Homepage    $agent.Homepage `
        -VerifyCmd   $agent.Verify `
        -Install     $agent.Install `
        -Uninstall   $agent.Uninstall `
        -DetectCmd   $agent.Detect `
        -RequiresNpm:$agent.Npm
}
