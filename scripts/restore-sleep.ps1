#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Sleep/hibernate ni odatiy qiymatlarga qaytaradi (masalan 30 daqiqa).
#>

$ErrorActionPreference = "Stop"
Write-Host "[RESTORE] Sleep qayta yoqilmoqda..." -ForegroundColor Cyan

powercfg /hibernate on | Out-Null
powercfg /change standby-timeout-ac 30 | Out-Null
powercfg /change standby-timeout-dc 15 | Out-Null
powercfg /change hibernate-timeout-ac 60 | Out-Null
powercfg /change hibernate-timeout-dc 30 | Out-Null
powercfg /change monitor-timeout-ac 10 | Out-Null
powercfg /change monitor-timeout-dc 5 | Out-Null

Write-Host "OK: Sleep qayta yoqildi (AC 30 daq / Battery 15 daq)." -ForegroundColor Green
