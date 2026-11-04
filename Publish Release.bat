@echo off
rem Publishes the launcher release and the launcher setup. Run it ON the VPS, from this folder (the GitHub clone),
rem connected over Remote Desktop with the build PC's C: drive shared (Local Resources > More > Drives).
rem It checks the release's signature, copies the game files to C:\culling\updates and the setup to the website's
rem download folder (deploy\publish_release.ps1). Another release: Publish Release.bat <version>
title Publish The Culling Remaster
fltmc >nul 2>&1 && goto run
if /i "%~1"=="elevated" goto no_admin
echo Asking Windows for administrator rights ...
powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0' -ArgumentList 'elevated %*'"
if errorlevel 1 goto no_admin
exit /b
:no_admin
echo.
echo This needs administrator rights: run it again and answer Yes when Windows asks.
pause
exit /b 1
:run
if /i "%~1"=="elevated" shift
cd /d "%~dp0"
git pull --ff-only
set "VERSION=%~1"
if "%VERSION%"=="" set "VERSION=1.1.0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\publish_release.ps1" -Release "\\tsclient\C\Culling\releases\%VERSION%\publish" & echo. & pause & exit /b
