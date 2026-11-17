@echo off
setlocal EnableExtensions
title AirGap Desktop Client (React + Tauri)
color 0b
cd /d "%~dp0"

echo ==============================================================
echo           AIRGAP LAN DESKTOP CLIENT (TAURI + REACT)
echo ==============================================================
echo.

rem Prefer a packaged / release build.
if exist "src-tauri\target\release\offline-tauri-client.exe" (
    start "" "src-tauri\target\release\offline-tauri-client.exe"
    exit /b 0
)

if exist "src-tauri\target\debug\offline-tauri-client.exe" (
    start "" "src-tauri\target\debug\offline-tauri-client.exe"
    exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js was not found and no compiled client exists.
    echo Use the prebuilt portable package, or install Node.js 22.5+ and Rust.
    echo.
    pause
    exit /b 1
)

:: Ensure esbuild binary is installed
if not exist "node_modules\esbuild\esbuild.exe" (
    echo Running esbuild postinstall...
    node node_modules\esbuild\install.js
)

echo Launching native Tauri desktop application...
echo (First run compiles Rust dependencies; this takes 1-2 minutes)
echo.

node node_modules\@tauri-apps\cli\tauri.js dev
pause
