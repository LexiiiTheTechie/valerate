@echo off
setlocal EnableExtensions
title Valerate - Web Server
color 0b
cd /d "%~dp0"

if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"

if not exist "%~dp0offline-app\server.js" (
    echo ERROR: offline-app\server.js is missing.
    echo.
    pause
    exit /b 1
)

echo ==============================================================
echo        VALERATE - SERVER ONLY (WEB / ANY DEVICE)
echo ==============================================================
echo.
echo Once the server starts, open the printed LAN URL in a browser on
echo any phone, tablet, or PC connected to the same network.
echo.
echo Default port: http://^<this-pc-ip^>:8080
echo.

cd /d "%~dp0offline-app"
call run_server.bat
