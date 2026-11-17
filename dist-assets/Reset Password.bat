@echo off
setlocal EnableExtensions
title Valerate - Reset Account Password
color 0b
cd /d "%~dp0offline-app"

if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"

echo ==============================================================
echo            VALERATE - RESET ACCOUNT PASSWORD
echo ==============================================================
echo.
echo Stop the server first (click "Stop Offline Server" in the control
echo center, or close the server window).
echo.
set /p VALERATE_USER=Username: 
set /p VALERATE_PASS=New password (12+ characters): 

echo.
node reset_password.js "%VALERATE_USER%" "%VALERATE_PASS%"
echo.
pause
