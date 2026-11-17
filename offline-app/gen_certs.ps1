# ==============================================================================
# WINDOWS OFFLINE TLS CERTIFICATE GENERATOR
# Generates PFX and exportable CRT for LAN HTTPS WebRTC
# ==============================================================================
param(
    [string]$LanIp = "",
    [string]$OutDir = "$PSScriptRoot\certs"
)

Add-Type -AssemblyName System.Security

# Auto-detect the primary LAN IPv4 when no IP was supplied, so certificates are
# valid on whatever network this machine is currently connected to.
if ([string]::IsNullOrWhiteSpace($LanIp)) {
    $detected = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.PrefixOrigin -ne "WellKnown" } |
        Select-Object -First 1 -ExpandProperty IPAddress
    if ([string]::IsNullOrWhiteSpace($detected)) { $detected = "127.0.0.1" }
    $LanIp = $detected
}

if (!(Test-Path $OutDir)) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Generating TLS SAN Certificate for Offline LAN WebRTC" -ForegroundColor Cyan
Write-Host " LAN IP: $LanIp" -ForegroundColor Yellow
Write-Host "=========================================================="

$rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider(2048)
$dn = New-Object System.Security.Cryptography.X509Certificates.X500DistinguishedName("CN=$LanIp, O=OfflineLAN, OU=WebRTC")

$req = New-Object System.Security.Cryptography.X509Certificates.CertificateRequest(
    $dn,
    $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)

# Subject Alternative Names for LAN IP and localhost
$sanBuilder = New-Object System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder
$sanBuilder.AddIpAddress([System.Net.IPAddress]::Parse($LanIp))
$sanBuilder.AddIpAddress([System.Net.IPAddress]::Parse("127.0.0.1"))
$sanBuilder.AddDnsName("localhost")
$req.CertificateExtensions.Add($sanBuilder.Build())

# Self-sign
$notBefore = [DateTimeOffset]::UtcNow.AddDays(-1)
$notAfter = [DateTimeOffset]::UtcNow.AddYears(5)
$cert = $req.CreateSelfSigned($notBefore, $notAfter)

# 1. Export PFX with private key for Node.js
$pwBytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($pwBytes)
$PfxPassword = [System.BitConverter]::ToString($pwBytes).Replace('-', '').ToLower()
$pfxBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $PfxPassword)
[System.IO.File]::WriteAllBytes("$OutDir\cert.pfx", $pfxBytes)

# Store the generated passphrase next to the PFX and restrict access to the
# current user. env.js reads this file when PFX_PASSWORD is not set.
$pwPath = "$OutDir\pfx_password.txt"
[System.IO.File]::WriteAllText($pwPath, $PfxPassword)
try {
    & icacls $pwPath /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
} catch {
    Write-Host "[!] Could not tighten ACLs on $pwPath; restrict it manually." -ForegroundColor Yellow
}

# 2. Export CRT for client OS trust installation
$certBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
$certBase64 = [System.Convert]::ToBase64String($certBytes, [System.Base64FormattingOptions]::InsertLineBreaks)
$certPem = @"
-----BEGIN CERTIFICATE-----
$certBase64
-----END CERTIFICATE-----
"@
[System.IO.File]::WriteAllText("$OutDir\rootCA.pem", $certPem)
[System.IO.File]::WriteAllText("$OutDir\server.crt", $certPem)

Write-Host "[+] Certificates successfully created in $OutDir" -ForegroundColor Green
Write-Host "    - cert.pfx (Used directly by Node.js HTTPS server)" -ForegroundColor White
Write-Host "    - pfx_password.txt (Generated PFX passphrase; keep private)" -ForegroundColor White
Write-Host "    - rootCA.pem (Install on client macOS / Windows systems)" -ForegroundColor White
