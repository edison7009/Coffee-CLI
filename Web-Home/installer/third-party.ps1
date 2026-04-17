<#
Third-party tools sub-menu. Placeholder - populated in a later iteration.
Swap this file's content to add new integrations; users re-loading the
installer will pick it up on their next session.

Depends on: Get-MenuI18n, T (menu.ps1).
#>

$T = Get-MenuI18n "third-party"

Clear-Host
Write-Host ""
Write-Host ("  " + (T $T "title")) -ForegroundColor Cyan
Write-Host ("  " + ("-" * 20)) -ForegroundColor DarkGray
Write-Host ""
Write-Host ("  " + (T $T "msg.coming_soon")) -ForegroundColor Yellow
Write-Host ""
Write-Host ("  " + (T $T "msg.detail_1")) -ForegroundColor DarkGray
Write-Host ("  " + (T $T "msg.detail_2")) -ForegroundColor DarkGray
Write-Host ("  " + (T $T "msg.detail_3")) -ForegroundColor DarkGray
Write-Host ""
Read-Host ("  " + (T $T "prompt.press_enter")) | Out-Null
