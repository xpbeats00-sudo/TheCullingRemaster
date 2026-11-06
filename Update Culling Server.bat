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
rem ==============
if /i not "%~1"=="pulled" (
  setlocal EnableDelayedExpansion
  echo Getting the latest code: git pull --ff-only
  git pull --ff-only
  if errorlevel 1 (
    echo.
    echo UPDATE FAILED: "git pull" failed, see above. The server was not touched: fix that and run this again.
    if not defined CULLING_NO_PAUSE pause
    exit /b 1
  )
  call "%~f0" pulled
  exit /b !errorlevel!
)
setlocal DisableDelayedExpansion
rem Why it is written like this (docs\SERVER_AUDIT_2.md, D1): cmd reads a batch file a line at a time, from where it
rem stopped, and "git pull" can rewrite this file while it runs. So the pull and the call to the updated file are one
rem block, read whole before it runs; the updated file then runs from its start (the "pulled" pass). The lines above
rem the block are those of the version before this one and the "rem ===" line is as long as the pull line it
rem replaced, so a copy of that version, which resumes right after its pull, lands on the block.
rem install_vps.ps1 backs up C:\culling\data first, rolls the code back if the new one doesn't answer /health, and
rem logs to C:\culling\logs\update-*.log. The exit code is its own. CULLING_NO_PAUSE=1 skips the pauses.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\install_vps.ps1"
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo ===== SERVER UPDATED =====
) else (
  color 4F
  echo ===== UPDATE FAILED, exit code %RC%. See the red lines above, and the log in C:\culling\logs =====
)
if not defined CULLING_NO_PAUSE pause
exit /b %RC%
