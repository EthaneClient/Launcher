@echo off
setlocal
title Ethane Launcher - Build
pushd "%~dp0"

:: Builds release\EthaneLauncherSetup.exe, the one file players download.
::   build.bat            build the installer
::   build.bat /nopause   don't wait for a key at the end

set "PAUSE_AT_END=1"
if /i "%~1"=="/nopause" set "PAUSE_AT_END="

if not exist node_modules (
    echo Installing dependencies...
    call npm install || goto fail
)

node scripts\make-installer.js || goto fail

echo.
echo   release\EthaneLauncherSetup.exe
echo.
if defined PAUSE_AT_END pause
popd
exit /b 0

:fail
echo.
echo [ERROR] Build failed.
if defined PAUSE_AT_END pause
popd
exit /b 1
