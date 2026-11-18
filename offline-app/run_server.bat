@echo off
setlocal EnableExtensions
title Valerate Offline LAN Messenger - Server
color 0b
cd /d "%~dp0"

echo ==============================================================
echo       AIR-GAP OFFLINE LAN MESSENGER AND WEBRTC CALLING
echo ==============================================================
echo.

rem Use a bundled Node runtime when this folder is part of a portable package.
if exist "%~dp0..\node\node.exe" set "PATH=%~dp0..\node;%PATH%"
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js was not found.
    echo Install Node.js 22.5 or newer, or use the portable package that
    echo ships its own Node runtime.
    echo.
    pause
    exit /b 1
)

rem Portable defaults: plain HTTP on 8080 so no Administrator rights are needed.
rem Uncomment the HTTPS lines below and install certs\rootCA.pem on client
rem devices if you need camera/microphone access from other machines.
if not defined PORT_HTTP set "PORT_HTTP=8080"
if not defined PORT_HTTPS set "PORT_HTTPS=8443"
if not defined ALLOW_HTTP set "ALLOW_HTTP=1"

if not exist "certs\cert.pfx" (
    if "%ALLOW_HTTP%"=="1" (
        rem Portable mode serves plain HTTP, so no certificate is needed to
        rem start. Generating one with PowerShell can take a long time on some
        rem machines, so only do it when HTTPS is actually required.
        echo [!] No TLS certificate yet. Running in HTTP mode on port %PORT_HTTP%.
        echo     Run "Generate Certificates.bat" if you need HTTPS for camera/mic.
    ) else (
        echo Generating local TLS certificate for this machine...
        powershell -NoProfile -ExecutionPolicy Bypass -File "gen_certs.ps1"
    )
)

echo.
echo Starting the offline communication server...
echo Open the printed LAN URL in any browser on this network.
echo.
node server.js
pause
