@echo off
rem Starts the local ClientWeb server, then The Culling pointed at it.
setlocal
set ROOT=%~dp0
set WIN64=%ROOT%TheCulling\Victory\Binaries\Win64

if not exist "%ROOT%logs" mkdir "%ROOT%logs"

rem Patched client DLL (local server URL) and the UI patch pak.
if not exist "%WIN64%\Func.Client.Local.dll" (
  python -I "%ROOT%patch\patch_client_dll.py" "%WIN64%\Func.Client.dll" "%WIN64%\Func.Client.Local.dll" || goto :fail
)
copy /y "%ROOT%patch\LocalServer-WindowsClient_P.pak" "%ROOT%TheCulling\Victory\Content\Paks\" >nul || goto :fail

rem Our pak already carries the Func mod's patch files (with its server URL
rem pointed here), so stop Func.Client mounting its own copy.
set FUNC_CLIENT_DISABLE_PAK_MOUNT=1

rem Start the server unless one is already answering on port 8000.
curl -s -o nul http://127.0.0.1:8000/health
if errorlevel 1 (
  if not exist "%ROOT%server\node_modules" (
    pushd "%ROOT%server" && call npm install --no-audit --no-fund && popd
  )
  start "The Culling local server" cmd /k "cd /d "%ROOT%server" && node server.js"
  "%SystemRoot%\System32\timeout.exe" /t 2 /nobreak >nul
)

pushd "%WIN64%"
start "" Func.Launcher.exe -FuncSkipUpdateCheck "-FuncClientDll=%WIN64%\Func.Client.Local.dll" "-FuncClientLog=%ROOT%logs\Func.Client.log"
popd
exit /b 0

:fail
echo Setup failed - see the messages above.
pause
exit /b 1
