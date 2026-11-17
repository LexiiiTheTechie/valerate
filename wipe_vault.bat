@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Use the bundled Node runtime when running from a portable package.
if exist "node\node.exe" set "PATH=%~dp0node;%PATH%"
if exist "runtime\node.exe" set "PATH=%~dp0runtime;%PATH%"

echo ==============================================================
echo                 WIPE PERSONAL VAULT SCRIPT
echo ==============================================================
echo.
echo WARNING: This will permanently delete all files in the
echo Personal Vault database and remove all uploaded vault files.
echo (User accounts, channels, and chat messages will remain safe.)
echo.
set "CONFIRM="
set /p "CONFIRM=Are you sure you want to proceed? (Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo Operation cancelled by user.
    pause
    exit /b 0
)

echo.
echo Wiping vault records and uploaded files...
node offline-app\wipe_vault.js

echo.
echo ==============================================================
echo Vault wipe completed.
echo ==============================================================
pause
