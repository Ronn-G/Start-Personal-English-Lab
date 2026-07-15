@echo off
set "APP_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%tools\start_app.ps1"
