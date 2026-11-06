@echo off
rem Publishes the launcher release and the launcher setup. Run it ON the VPS, from this folder (the GitHub clone),
rem connected over Remote Desktop with the build PC's C: drive shared (Local Resources > More > Drives).
rem It checks the release's signature, copies the game files to C:\culling\updates and the setup to the website's
rem download folder (deploy\publish_release.ps1). It publishes the newest release built on the PC
rem (releases\LATEST, written by patch\make_release.py); another one: Publish Release.bat <version>
rem A release that removes files the live one has is refused unless asked for: Publish Release.bat <version> -AllowRemovals
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
rem ==============
if /i not "%~1"=="pulled" (
  setlocal EnableDelayedExpansion
  echo Getting the latest scripts: git pull --ff-only
  git pull --ff-only
  if errorlevel 1 (
    echo.
    echo PUBLISH FAILED: "git pull" failed, see above. Nothing was published: fix that and run this again.
    if not defined CULLING_NO_PAUSE pause
    exit /b 1
  )
  call "%~f0" pulled %1 %2
  exit /b !errorlevel!
)
shift
setlocal DisableDelayedExpansion
rem Why it is written like this (docs\SERVER_AUDIT_2.md, D1):
rem  - cmd reads a batch file a line at a time, from where it stopped. "git pull" can rewrite this file while it runs;
rem    a copy that kept running after the pull then read the rest from the wrong place in the new file and stopped
rem    without publishing anything. So the pull and the call to the updated file are one block, read whole before it
rem    runs, and the updated file runs from its start (the "pulled" pass, which skips the block).
rem  - The lines above the block are exactly those of the version before this one, and the "rem ===" line is as
rem    long as the "git pull --ff-only" line it replaced, so a copy of that version, which resumes right after its
rem    pull, lands on the block. Lines above the block may change from now on.
rem  - CULLING_NO_PAUSE=1 skips the pauses (unattended runs, deploy\bats.test.js).
rem  - The publish's own output goes to C:\culling\logs\publish-*.log; this window ends with PUBLISHED or a red
rem    PUBLISH FAILED, and the exit code is publish_release.ps1's (0 only when the release is live and checked).
if not defined CULLING_RELEASES set "CULLING_RELEASES=\\tsclient\C\Culling\releases"
set "VERSION=%~1"
set "EXTRA="
if /i "%~2"=="-AllowRemovals" set "EXTRA=-AllowRemovals"
set "LATEST=%CULLING_RELEASES%\LATEST"
if "%VERSION%"=="" if exist "%LATEST%" set /p VERSION=<"%LATEST%"
if "%VERSION%"=="" (
  echo.
  echo PUBLISH FAILED: no release version given, and none in %LATEST%.
  echo Share the build PC's C: drive over Remote Desktop, or run: "Publish Release.bat" ^<version^>
  if not defined CULLING_NO_PAUSE pause
  exit /b 1
)
echo Publishing release %VERSION%
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\publish_release.ps1" -Release "%CULLING_RELEASES%\%VERSION%\publish" %EXTRA%
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo ===== PUBLISHED %VERSION% =====
) else (
  color 4F
  echo ===== PUBLISH FAILED, exit code %RC%. See the red lines above, and the log in C:\culling\logs =====
)
if not defined CULLING_NO_PAUSE pause
exit /b %RC%
