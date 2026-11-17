@echo off
setlocal EnableExtensions
title Valerate - Generate TLS Certificates
color 0b
cd /d "%~dp0offline-app"

if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"

echo ==============================================================
echo          VALERATE - GENERATE TLS CERTIFICATES
echo ==============================================================
echo.
echo This creates certs\cert.pfx so the server can run over HTTPS.
echo HTTPS is required for camera/microphone (calls) from other devices.
echo Normally you only need this once per machine.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "gen_certs.ps1"
if errorlevel 1 (
    echo.
    echo Certificate generation failed.
    pause
    exit /b 1
)

echo.
echo Done. Start the server again to use HTTPS.
pause
