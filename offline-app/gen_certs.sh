#!/usr/bin/env sh
# ==============================================================================
# macOS / Linux TLS certificate generator for Valerate LAN HTTPS / WebRTC
# Produces the same files as gen_certs.ps1: cert.pfx, pfx_password.txt, rootCA.pem
# ==============================================================================
set -e

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
OUT_DIR="${2:-$SCRIPT_DIR/certs}"
LAN_IP="${1:-}"

if [ -z "$LAN_IP" ]; then
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
  if [ -z "$LAN_IP" ]; then
    LAN_IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
  fi
  if [ -z "$LAN_IP" ]; then
    LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  if [ -z "$LAN_IP" ]; then
    LAN_IP="127.0.0.1"
  fi
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL is required to generate certificates."
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "=========================================================="
echo " Generating TLS SAN Certificate for Offline LAN WebRTC"
echo " LAN IP: $LAN_IP"
echo "=========================================================="

PFX_PASSWORD="$(openssl rand -hex 16)"
KEY_FILE="$(mktemp)"
CRT_FILE="$(mktemp)"
CFG_FILE="$(mktemp)"
trap 'rm -f "$KEY_FILE" "$CRT_FILE" "$CFG_FILE"' EXIT

cat > "$CFG_FILE" <<EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = $LAN_IP
O = OfflineLAN
OU = WebRTC

[v3_req]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
IP.1 = $LAN_IP
IP.2 = 127.0.0.1
DNS.1 = localhost
EOF

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$KEY_FILE" \
  -out "$CRT_FILE" \
  -days 1825 \
  -config "$CFG_FILE" \
  >/dev/null 2>&1

openssl pkcs12 -export \
  -out "$OUT_DIR/cert.pfx" \
  -inkey "$KEY_FILE" \
  -in "$CRT_FILE" \
  -passout "pass:$PFX_PASSWORD" \
  >/dev/null 2>&1

cp "$CRT_FILE" "$OUT_DIR/rootCA.pem"
cp "$CRT_FILE" "$OUT_DIR/server.crt"
printf '%s\n' "$PFX_PASSWORD" > "$OUT_DIR/pfx_password.txt"
chmod 600 "$OUT_DIR/pfx_password.txt" "$OUT_DIR/cert.pfx"

echo "[+] Certificates successfully created in $OUT_DIR"
echo "    - cert.pfx (Used directly by Node.js HTTPS server)"
echo "    - pfx_password.txt (Generated PFX passphrase; keep private)"
echo "    - rootCA.pem (Install on client macOS / Windows systems)"
echo ""
echo "To trust on this Mac:"
echo "  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \"$OUT_DIR/rootCA.pem\""
