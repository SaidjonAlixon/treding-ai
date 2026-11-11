@echo off
:: ============================================================
::  Mizan Trader — 24/7 (Admin)
::  Ikki marta bosing. Admin so'rasa HA/Yes bosing.
::  Bu oyna + API + Panel + MT5 ochiq qoladi. UXLAMAYDI.
:: ============================================================
cd /d "%~dp0"

:: Admin bo'lmasa — o'zini Admin qilib qayta ochadi
net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo Admin huquqi so'ralmoqda...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

title Mizan 24H ADMIN — YOPMANG
color 0A
echo.
echo  ==========================================
echo   MIZAN 24/7 — Admin rejim
echo   Sleep OFF + MT5 + API + Panel
echo   Bu oynani YOPMANG
echo  ==========================================
echo.

:: Sleep / Hibernate o'chirish
powercfg /change standby-timeout-ac 0 >nul
powercfg /change standby-timeout-dc 0 >nul
powercfg /change hibernate-timeout-ac 0 >nul
powercfg /change hibernate-timeout-dc 0 >nul
powercfg /change monitor-timeout-ac 0 >nul
powercfg /change monitor-timeout-dc 0 >nul
powercfg /hibernate off >nul
echo [OK] Kompyuter uxlash o'chirildi.

:: Muhit
set "ROOT=%~dp0"
set "PATH=C:\Program Files\Git\bin;%PATH%"
set PORT=8080
set DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/trading_platform
set LOCAL_DEV_AUTH=1
set TRADING_ADMIN_EMAIL=admin@local.dev
set NODE_ENV=development
set EXNESS_MT5_LOGIN=474899661
set EXNESS_MT5_SERVER=Exness-MT5Trial15
set EXNESS_MT5_PASSWORD=1234Said23$&
set EXNESS_MT5_PATH=C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe
set BASE_RISK_USD=0.1
set PROFIT_ONLY_MODE=1
set MAX_OPEN_POSITIONS=10
set MAX_PER_SYMBOL=4
set VITE_LOCAL_DEV_AUTH=1
set VITE_TRADING_ADMIN_EMAIL=admin@local.dev
set API_PROXY_TARGET=http://127.0.0.1:8080
set BASE_PATH=/

:: MT5
if exist "%EXNESS_MT5_PATH%" (
  tasklist /FI "IMAGENAME eq terminal64.exe" | find /I "terminal64.exe" >nul
  if errorlevel 1 (
    echo [..] Exness MT5 ochilmoqda...
    start "" "%EXNESS_MT5_PATH%"
    timeout /t 4 /nobreak >nul
  ) else (
    echo [OK] MT5 allaqachon ochiq.
  )
) else (
  echo [!] MT5 topilmadi: %EXNESS_MT5_PATH%
)

:: Eski portlarni bo'shatish
for %%P in (8080 24704) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%%P" ^| findstr LISTENING') do (
    taskkill /F /PID %%A >nul 2>&1
  )
)
timeout /t 2 /nobreak >nul

:: API alohida CMD (yopilmasin)
echo [..] API 8080 ishga tushirilmoqda...
start "Mizan-API-8080" cmd /k "cd /d "%ROOT%" && set PORT=8080 && set DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/trading_platform && set LOCAL_DEV_AUTH=1 && set TRADING_ADMIN_EMAIL=admin@local.dev && set EXNESS_MT5_LOGIN=474899661 && set EXNESS_MT5_SERVER=Exness-MT5Trial15 && set EXNESS_MT5_PASSWORD=1234Said23$& && set EXNESS_MT5_PATH=C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe && set BASE_RISK_USD=0.1 && set PROFIT_ONLY_MODE=1 && set MAX_OPEN_POSITIONS=10 && set MAX_PER_SYMBOL=4 && pnpm --filter @workspace/api-server run build && pnpm --filter @workspace/api-server run start"

timeout /t 10 /nobreak >nul

:: Frontend alohida CMD
echo [..] Panel 24704 ishga tushirilmoqda...
start "Mizan-UI-24704" cmd /k "cd /d "%ROOT%" && set PORT=24704 && set BASE_PATH=/ && set VITE_LOCAL_DEV_AUTH=1 && set VITE_TRADING_ADMIN_EMAIL=admin@local.dev && set API_PROXY_TARGET=http://127.0.0.1:8080 && pnpm --filter @workspace/smartgold-bitcoin-trader run dev"

timeout /t 6 /nobreak >nul
start "" "http://127.0.0.1:24704/dashboard"

echo.
echo  [OK] Panel: http://127.0.0.1:24704/dashboard
echo  [OK] API:   http://127.0.0.1:8080
echo.
echo  Ochilgan oynalar: Mizan-API-8080, Mizan-UI-24704, MT5
echo  Ularni HAM YOPMANG. Bu oyna ham ochiq tursin.
echo  Chiqish: Ctrl+C
echo.

:: Uyquga ketmaslik + watchdog
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Add-Type -Namespace W -Name A -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'; ^
   while ($true) { ^
     [void][W.A]::SetThreadExecutionState(0x80000003); ^
     if (-not (Get-Process terminal64 -ErrorAction SilentlyContinue)) { if (Test-Path '%EXNESS_MT5_PATH%') { Start-Process '%EXNESS_MT5_PATH%' } }; ^
     $api = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue; ^
     if (-not $api) { Start-Process cmd -ArgumentList '/k','cd /d \"%ROOT%\" ^&^& set PORT=8080 ^&^& set DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/trading_platform ^&^& set LOCAL_DEV_AUTH=1 ^&^& set TRADING_ADMIN_EMAIL=admin@local.dev ^&^& set EXNESS_MT5_LOGIN=474899661 ^&^& set EXNESS_MT5_SERVER=Exness-MT5Trial15 ^&^& set EXNESS_MT5_PASSWORD=1234Said23$&^&^& set EXNESS_MT5_PATH=C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe ^&^& set BASE_RISK_USD=0.1 ^&^& set PROFIT_ONLY_MODE=1 ^&^& set MAX_OPEN_POSITIONS=10 ^&^& set MAX_PER_SYMBOL=4 ^&^& pnpm --filter @workspace/api-server run build ^&^& pnpm --filter @workspace/api-server run start' -WorkingDirectory '%ROOT%' }; ^
     $ui = Get-NetTCPConnection -LocalPort 24704 -State Listen -ErrorAction SilentlyContinue; ^
     if (-not $ui) { Start-Process cmd -ArgumentList '/k','cd /d \"%ROOT%\" ^&^& set PORT=24704 ^&^& set BASE_PATH=/ ^&^& set VITE_LOCAL_DEV_AUTH=1 ^&^& set VITE_TRADING_ADMIN_EMAIL=admin@local.dev ^&^& set API_PROXY_TARGET=http://127.0.0.1:8080 ^&^& pnpm --filter @workspace/smartgold-bitcoin-trader run dev' -WorkingDirectory '%ROOT%' }; ^
     Start-Sleep -Seconds 90 ^
   }"

pause
