# ==============================================================================
# VALERATE - BUILD A SELF-CONTAINED PORTABLE PACKAGE (WINDOWS)
# ==============================================================================
# Requirements on the BUILD machine only:
#   - Node.js 22.5+ (node:sqlite) and npm
#   - Rust toolchain with the MSVC target
# The produced dist\Valerate-Portable folder needs none of these to run.
# ==============================================================================
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$out  = Join-Path $root "dist\Valerate-Portable"

function Invoke-Step($description, $block) {
    Write-Host "==> $description" -ForegroundColor Cyan
    & $block
    if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
        throw "Step failed: $description (exit $LASTEXITCODE)"
    }
}

Write-Host "==> Building frontends" -ForegroundColor Cyan
Push-Location (Join-Path $root "offline-tauri-client")
npm run build
Pop-Location
Push-Location (Join-Path $root "valerate-dashboard")
npm run build
Pop-Location

Write-Host "==> Compiling release binaries (this can take several minutes)" -ForegroundColor Cyan
Push-Location (Join-Path $root "offline-tauri-client\src-tauri")
cargo build --release
Pop-Location
Push-Location (Join-Path $root "valerate-dashboard\src-tauri")
cargo build --release
Pop-Location

Write-Host "==> Assembling portable package at $out" -ForegroundColor Cyan
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $out "node") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $out "client") | Out-Null

# Server + web client (exclude machine-specific runtime data)
robocopy (Join-Path $root "offline-app") (Join-Path $out "offline-app") /E `
    /XD data uploads certs /NFL /NDL /NJH /NJS /NP | Out-Null

# Bundled Node runtime (copy the whole folder so any sibling DLLs come along)
$nodeDir = Split-Path -Parent (Get-Command node).Source
Copy-Item (Join-Path $nodeDir "node.exe") (Join-Path $out "node\node.exe") -Force

# Compiled desktop apps
Copy-Item (Join-Path $root "valerate-dashboard\src-tauri\target\release\valerate-dashboard.exe") `
    (Join-Path $out "valerate-dashboard.exe") -Force
Copy-Item (Join-Path $root "offline-tauri-client\src-tauri\target\release\offline-tauri-client.exe") `
    (Join-Path $out "client\offline-tauri-client.exe") -Force

# Launchers + docs
foreach ($file in @("Start Valerate.bat", "Start Server Only.bat", "Generate Certificates.bat", "Reset Password.bat", "start-server.sh", "README.txt")) {
    Copy-Item (Join-Path $root "dist-assets\$file") (Join-Path $out $file) -Force
}

Write-Host ""
Write-Host "Portable package ready: $out" -ForegroundColor Green
Write-Host "Distribute the whole folder, or zip it for delivery." -ForegroundColor Green
