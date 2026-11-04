@echo off
rem Copies a profile from a local (home PC) Culling server into a Remaster account on the live server, once.
rem Run it ON the VPS, after "Update Culling Server.bat", over Remote Desktop with your PC's C: drive shared
rem ("Connect to VPS (shares C drive).rdp"). Create the account in the launcher first.
rem The account's current profile is backed up in C:\culling\data\import-backups before it is replaced.
title Import a local profile into a Remaster account
setlocal
set "NODE=C:\culling\node\node.exe"
set "ADMIN=C:\culling\app\tools\account_admin.js"
set "LOCAL=\\tsclient\C\Culling\server\data\profiles.json"
if not exist "%ADMIN%" (
  echo The account server isn't installed with accounts yet: run "Update Culling Server.bat" first.
  goto done
)
echo Local profiles file [%LOCAL%]:
set /p "INPUT=> "
if not "%INPUT%"=="" set "LOCAL=%INPUT%"
if not exist "%LOCAL%" (
  echo Can't find %LOCAL%. Connect with "Connect to VPS (shares C drive).rdp" so your PC's C: drive is shared.
  goto done
)
echo.
echo Profiles in that file:
"%NODE%" -e "const p=require(process.argv[1]);for(const[k,v]of Object.entries(p))console.log('  '+k+'  level '+((v.stats||{}).level||1)+', '+((v.stats||{}).xp||0)+' XP, '+(v.cullCredits||0)+' credits')" "%LOCAL%"
echo.
set /p "LOCALID=Local profile to copy (the steam:... ID above): "
set /p "ACCOUNT=Remaster account username to copy it into: "
if "%LOCALID%"=="" goto done
if "%ACCOUNT%"=="" goto done
echo.
"%NODE%" "%ADMIN%" import "%ACCOUNT%" "%LOCAL%" "%LOCALID%"
:done
echo.
pause
