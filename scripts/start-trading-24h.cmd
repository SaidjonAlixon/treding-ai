@echo off
:: Admin CMD orqali 24/7 trading + no-sleep
cd /d "%~dp0\.."
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0start-trading-24h.ps1\"'"
