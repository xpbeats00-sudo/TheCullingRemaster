@echo off
rem Updates The Culling Remaster account server. Run it ON the VPS, from this folder (the GitHub clone):
rem double-click it and say Yes when Windows asks for administrator rights. It pulls the latest code from GitHub and
rem runs deploy\install_vps.ps1 (Node, the service, HTTPS on port 8443). Player data in C:\culling\data stays.
title Update The Culling Remaster server
fltmc >nul 2>&1 && goto run
if /i "%~1"=="elevated" goto no_admin
echo Asking Windows for administrator rights ...
powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0' -ArgumentList 'elevated'"
if errorlevel 1 goto no_admin
exit /b
:no_admin
echo.
echo This needs administrator rights: run it again and answer Yes when Windows asks.
pause
exit /b 1
:run
cd /d "%~dp0"
git pull --ff-only
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\install_vps.ps1" & echo. & pause & exit /b
