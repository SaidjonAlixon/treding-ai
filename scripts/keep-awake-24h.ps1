#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Kompyuterni 24/7 uyg'oq tutadi: sleep/hibernate o'chiriladi, ekran o'chmasligi mumkin.
  Admin PowerShell da ishga tushiring.
#>

$ErrorActionPreference = "Stop"

function Write-Info([string]$msg) {
  Write-Host "[KEEP-AWAKE] $msg" -ForegroundColor Cyan
}

Write-Info "Administrator huquqi tekshirilmoqda..."
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "XATO: Bu skriptni Admin PowerShell da ishga tushiring (Run as administrator)." -ForegroundColor Red
  exit 1
}

Write-Info "Sleep / Hibernate o'chirilmoqda (AC + Battery)..."
# 0 = Never
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change standby-timeout-dc 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-dc 0 | Out-Null
powercfg /change monitor-timeout-ac 0 | Out-Null
powercfg /change monitor-timeout-dc 0 | Out-Null
powercfg /change disk-timeout-ac 0 | Out-Null
powercfg /change disk-timeout-dc 0 | Out-Null
powercfg /hibernate off | Out-Null

# USB selective suspend off (ba'zan uyquga olib ketadi)
try {
  powercfg /SETACVALUEINDEX SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0 | Out-Null
  powercfg /SETDCVALUEINDEX SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0 | Out-Null
  powercfg /S SCHEME_CURRENT | Out-Null
} catch {}

Write-Info "Joriy quvvat rejimlari:"
powercfg /query SCHEME_CURRENT SUB_SLEEP | Select-String -Pattern "Current|Timeout|Name" | ForEach-Object { $_.Line.Trim() }

# ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Awake {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
  public const uint ES_CONTINUOUS = 0x80000000;
  public const uint ES_SYSTEM_REQUIRED = 0x00000001;
  public const uint ES_DISPLAY_REQUIRED = 0x00000002;
}
"@

[void][Awake]::SetThreadExecutionState(
  [Awake]::ES_CONTINUOUS -bor [Awake]::ES_SYSTEM_REQUIRED -bor [Awake]::ES_DISPLAY_REQUIRED
)

Write-Host ""
Write-Host "OK: Kompyuter endi uxlmaydi / hibernate qilmaydi." -ForegroundColor Green
Write-Host "Bu oynani YOPMANG — yopilsa 'uyg'oq' holat tugashi mumkin." -ForegroundColor Yellow
Write-Host "To'xtatish: Ctrl+C  yoki  scripts\\restore-sleep.ps1" -ForegroundColor Yellow
Write-Host ""

try {
  while ($true) {
    [void][Awake]::SetThreadExecutionState(
      [Awake]::ES_CONTINUOUS -bor [Awake]::ES_SYSTEM_REQUIRED -bor [Awake]::ES_DISPLAY_REQUIRED
    )
    Start-Sleep -Seconds 60
  }
} finally {
  # Continuous only — tizim defaultga qaytadi (powercfg sozlamalari saqlanadi)
  [void][Awake]::SetThreadExecutionState([Awake]::ES_CONTINUOUS)
  Write-Info "ExecutionState bo'shatildi. Sleep timeoutlar powercfg da 0 bo'lib qolgan bo'lishi mumkin."
}
