#Requires -RunAsAdministrator
<#
.SYNOPSIS
  24/7: kompyuter uxlmaydi + API + frontend + (ixtiyoriy) MT5 ochiq turadi.
  Admin PowerShell:
    cd $env:USERPROFILE\Desktop\AI-Trading-Platform
    .\scripts\start-trading-24h.ps1
#>

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root "pnpm-workspace.yaml"))) {
  $Root = "C:\Users\Saidmuhammadalixon\Desktop\AI-Trading-Platform"
}
Set-Location $Root

function Write-Info([string]$msg) { Write-Host "[24H] $msg" -ForegroundColor Cyan }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Admin PowerShell da ishga tushiring." -ForegroundColor Red
  exit 1
}

# --- 1) Sleep o'chirish (bir martalik sozlama) ---
Write-Info "Sleep/hibernate o'chirilmoqda..."
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change standby-timeout-dc 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-dc 0 | Out-Null
powercfg /change monitor-timeout-ac 0 | Out-Null
powercfg /change monitor-timeout-dc 0 | Out-Null
powercfg /hibernate off | Out-Null

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class StayAwake {
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
  public const uint CONT = 0x80000000; public const uint SYS = 0x00000001; public const uint DISP = 0x00000002;
}
"@ | Out-Null

# --- 2) Env ---
$env:Path = "C:\Program Files\Git\bin;" + $env:Path
$env:PORT = "8080"
$env:DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:5432/trading_platform"
$env:LOCAL_DEV_AUTH = "1"
$env:TRADING_ADMIN_EMAIL = "admin@local.dev"
$env:NODE_ENV = "development"
# Secretlar .env.local dan (repoga yozilmaydi)
$envFile = Join-Path $Root ".env.local"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
    $k, $v = $_.Split('=', 2)
    [Environment]::SetEnvironmentVariable($k.Trim(), $v.Trim(), 'Process')
  }
}
if (-not $env:EXNESS_MT5_PATH) {
  $env:EXNESS_MT5_PATH = "C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe"
}
$env:BASE_RISK_USD = "0.1"
$env:PROFIT_ONLY_MODE = "1"
$env:MAX_OPEN_POSITIONS = "10"
$env:MAX_PER_SYMBOL = "4"
$env:VITE_LOCAL_DEV_AUTH = "1"
$env:VITE_TRADING_ADMIN_EMAIL = "admin@local.dev"
$env:API_PROXY_TARGET = "http://127.0.0.1:8080"
$env:BASE_PATH = "/"

# --- 3) MT5 ochiq tutish ---
$mt5 = $env:EXNESS_MT5_PATH
if (Test-Path $mt5) {
  $running = Get-Process -Name "terminal64" -ErrorAction SilentlyContinue
  if (-not $running) {
    Write-Info "Exness MT5 ishga tushirilmoqda..."
    Start-Process -FilePath $mt5
    Start-Sleep 5
  } else {
    Write-Info "MT5 allaqachon ochiq."
  }
}

# --- 4) Portlarni tozalash ---
foreach ($port in 8080, 24704) {
  Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.OwningProcess -gt 0) {
      Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
}
Start-Sleep 2

# --- 5) API + Vite alohida oynada (yopilmasin) ---
$apiCmd = @"
cd /d "$Root"
set PORT=8080
set DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/trading_platform
set LOCAL_DEV_AUTH=1
set TRADING_ADMIN_EMAIL=admin@local.dev
for /f "usebackq tokens=1,* delims==" %%A in (".env.local") do set "%%A=%%B"
set PORT=8080
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run start
"@

$viteCmd = @"
cd /d "$Root"
set PORT=24704
set BASE_PATH=/
set VITE_LOCAL_DEV_AUTH=1
set VITE_TRADING_ADMIN_EMAIL=admin@local.dev
set API_PROXY_TARGET=http://127.0.0.1:8080
pnpm --filter @workspace/smartgold-bitcoin-trader run dev
"@

Write-Info "API oynasi ochilmoqda (8080)..."
Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $apiCmd -WorkingDirectory $Root

Start-Sleep 8
Write-Info "Frontend oynasi ochilmoqda (24704)..."
Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $viteCmd -WorkingDirectory $Root

Start-Sleep 5
Start-Process "http://127.0.0.1:24704/dashboard"

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host " 24/7 rejim: API + Panel + MT5 + No-Sleep" -ForegroundColor Green
Write-Host " Panel: http://127.0.0.1:24704/dashboard" -ForegroundColor Green
Write-Host " API/Vite CMD oynalarini YOPMANG" -ForegroundColor Yellow
Write-Host " Bu oynani ham ochiq qoldiring (uyg'oq tutadi)" -ForegroundColor Yellow
Write-Host " To'xtatish: Ctrl+C  keyin restore-sleep.ps1" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Green
Write-Host ""

try {
  while ($true) {
    [void][StayAwake]::SetThreadExecutionState([StayAwake]::CONT -bor [StayAwake]::SYS -bor [StayAwake]::DISP)

    # MT5 qayta ochish
    if ((Test-Path $mt5) -and -not (Get-Process -Name "terminal64" -ErrorAction SilentlyContinue)) {
      Write-Info "MT5 yopilgan edi — qayta ochilmoqda..."
      Start-Process -FilePath $mt5
    }

    # API port tekshiruvi
    $apiUp = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
    if (-not $apiUp) {
      Write-Info "API o'chgan — qayta ishga tushirilmoqda..."
      Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $apiCmd -WorkingDirectory $Root
    }

    $uiUp = Get-NetTCPConnection -LocalPort 24704 -State Listen -ErrorAction SilentlyContinue
    if (-not $uiUp) {
      Write-Info "Frontend o'chgan — qayta ishga tushirilmoqda..."
      Start-Process -FilePath "cmd.exe" -ArgumentList "/k", $viteCmd -WorkingDirectory $Root
    }

    Start-Sleep -Seconds 90
  }
} finally {
  [void][StayAwake]::SetThreadExecutionState([StayAwake]::CONT)
  Write-Info "24H watchdog to'xtatildi."
}
