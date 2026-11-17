@echo off
setlocal EnableExtensions
title Valerate Suite
color 0b
cd /d "%~dp0"

echo ==============================================================
echo                     VALERATE SUITE
echo ==============================================================
echo.

set "VALERATE_ROOT=%~dp0"
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"

if not exist "%~dp0valerate-dashboard.exe" (
    echo ERROR: valerate-dashboard.exe is missing from this folder.
    echo Download the complete Valerate-Portable package and try again.
    echo.
    pause
    exit /b 1
)

echo Starting the Valerate control center...
echo Use "Start Server Only.bat" if you only want web access from phones
echo or other devices on this network.
echo.
start "" "%~dp0valerate-dashboard.exe"
exit /b 0
