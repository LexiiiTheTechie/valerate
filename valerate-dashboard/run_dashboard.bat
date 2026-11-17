@echo off
setlocal EnableExtensions
title Valerate Control Center
color 0b
cd /d "%~dp0"

echo ==============================================================
echo                 VALERATE MASTER CONTROL CENTER
echo ==============================================================
echo.

set "VALERATE_ROOT=%~dp0.."
if exist "%~dp0..\node\node.exe" set "PATH=%~dp0..\node;%PATH%"

if exist "src-tauri\target\release\valerate-dashboard.exe" (
    start "" "src-tauri\target\release\valerate-dashboard.exe"
    exit /b 0
)

if exist "src-tauri\target\debug\valerate-dashboard.exe" (
    start "" "src-tauri\target\debug\valerate-dashboard.exe"
    exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js was not found and no compiled dashboard exists.
    echo Use the prebuilt portable package, or install Node.js 22.5+.
    echo.
    pause
    exit /b 1
)

echo Dashboard binary not yet compiled. Starting via Tauri CLI...
node node_modules\@tauri-apps\cli\tauri.js dev
pause
