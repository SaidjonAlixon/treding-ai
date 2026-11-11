@echo off
:: Faqat kompyuter UXLAMASIN. Admin qilib ikki marta bosing.
cd /d "%~dp0"

net session >nul 2>&1
if %errorlevel% NEQ 0 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

title NO-SLEEP — Bu oynani yopmang
color 0A
echo.
echo  Kompyuter uxlash o'chirilmoqda...
echo.

powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change hibernate-timeout-dc 0
powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0
powercfg /hibernate off

echo  [OK] Sleep / Hibernate o'chirildi.
echo  Bu oynani ochiq qoldiring. Yopsangiz ham sleep sozlamasi 0 bo'lib qoladi.
echo  Chiqish: oynani yoping.
echo.

:: Oddiy loop — hech qanday PowerShell C# yo'q
:loop
timeout /t 300 /nobreak >nul
goto loop
