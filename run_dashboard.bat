@echo off
setlocal EnableExtensions
title Valerate Control Center
color 0b
cd /d "%~dp0"

echo ==============================================================
echo                 VALERATE MASTER CONTROL CENTER
echo ==============================================================
echo.

set "VALERATE_ROOT=%~dp0"
rem Use a bundled Node runtime (portable builds) when available.
if exist "%~dp0node\node.exe" set "PATH=%~dp0node;%PATH%"
if exist "%~dp0runtime\node.exe" set "PATH=%~dp0runtime;%PATH%"

rem Prefer the release build, then the copied root binary, then a debug build.
set "DASH="
if exist "%~dp0valerate-dashboard\src-tauri\target\release\valerate-dashboard.exe" set "DASH=%~dp0valerate-dashboard\src-tauri\target\release\valerate-dashboard.exe"
if not defined DASH if exist "%~dp0valerate-dashboard.exe" set "DASH=%~dp0valerate-dashboard.exe"
if not defined DASH if exist "%~dp0valerate-dashboard\src-tauri\target\debug\valerate-dashboard.exe" set "DASH=%~dp0valerate-dashboard\src-tauri\target\debug\valerate-dashboard.exe"

if defined DASH (
    echo Launching dashboard: %DASH%
    start "" "%DASH%"
    exit /b 0
)

echo Dashboard binary not found. Attempting to run it via the Tauri CLI...
if not exist "%~dp0valerate-dashboard\node_modules\@tauri-apps\cli\tauri.js" (
    echo.
    echo ERROR: Cannot find the dashboard executable or the Tauri CLI.
    echo Install Node.js and run "npm install" inside valerate-dashboard, or
    echo use the prebuilt portable package in the "dist" folder.
    echo.
    pause
    exit /b 1
)

cd /d "%~dp0valerate-dashboard"
node node_modules\@tauri-apps\cli\tauri.js dev
pause
