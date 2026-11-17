#!/usr/bin/env bash
# ==============================================================================
# OFFLINE LAN CHAT SERVER BOOTSTRAP & START SCRIPT
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

echo "=========================================================="
echo "    AIR-GAPPED OFFLINE LAN CHAT SERVER BOOTSTRAP         "
echo "=========================================================="

# 1. Validate Docker & Docker Compose
if ! command -v docker >/dev/null 2>&1; then
    echo "[-] Error: docker is not installed or not in PATH."
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    echo "[-] Error: docker compose (v2) is not available."
    exit 1
fi

# 2. Determine Local LAN IP
if [ -z "${LAN_IP:-}" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        DETECTED_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "127.0.0.1")
    else
        DETECTED_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")
    fi
else
    DETECTED_IP="$LAN_IP"
fi

echo "[+] Detected LAN Host IP: $DETECTED_IP"
read -p "Use this LAN IP for clients ($DETECTED_IP)? [Y/n]: " CONFIRM_IP
CONFIRM_IP=${CONFIRM_IP:-Y}
if [[ "$CONFIRM_IP" =~ ^[Nn]$ ]]; then
    read -p "Enter custom LAN IP or Domain: " DETECTED_IP
fi

# 3. Initialize .env if missing or update values
if [ ! -f ".env" ]; then
    echo "[+] Generating .env file with cryptographically secure random secrets..."
    cp .env.example .env
    
    # Generate high-entropy secrets
    GEN_REG_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p)
    GEN_MACAROON=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p)
    GEN_FORM=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p)
    GEN_TURN=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p)
    GEN_PG_PASS=$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | xxd -p)

    sed -i.bak "s/^LAN_IP=.*/LAN_IP=$DETECTED_IP/" .env
    sed -i.bak "s/^SERVER_NAME=.*/SERVER_NAME=$DETECTED_IP/" .env
    sed -i.bak "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$GEN_PG_PASS/" .env
    sed -i.bak "s/^SYNAPSE_REGISTRATION_SHARED_SECRET=.*/SYNAPSE_REGISTRATION_SHARED_SECRET=$GEN_REG_SECRET/" .env
    sed -i.bak "s/^SYNAPSE_MACAROON_SECRET_KEY=.*/SYNAPSE_MACAROON_SECRET_KEY=$GEN_MACAROON/" .env
    sed -i.bak "s/^SYNAPSE_FORM_SECRET=.*/SYNAPSE_FORM_SECRET=$GEN_FORM/" .env
    sed -i.bak "s/^TURN_SHARED_SECRET=.*/TURN_SHARED_SECRET=$GEN_TURN/" .env
    rm -f .env.bak
else
    echo "[+] Using existing .env file."
fi

chmod 600 .env 2>/dev/null || true

# 3b. Render the Synapse config template with the real secrets. Docker Compose
# does not expand ${VAR} inside mounted files, so this must happen on the host.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

render_synapse_config() {
    local template="config/synapse/homeserver.yaml"
    local output="config/synapse/homeserver.runtime.yaml"
    cp "$template" "$output"

    local names=(
        SERVER_NAME POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB LAN_IP
        SYNAPSE_REGISTRATION_SHARED_SECRET SYNAPSE_MACAROON_SECRET_KEY
        SYNAPSE_FORM_SECRET TURN_SHARED_SECRET
    )
    for name in "${names[@]}"; do
        local value="${!name:-}"
        if [ -z "$value" ]; then
            echo "[-] Error: $name is missing from .env"
            exit 1
        fi
        if [[ "$value" == CHANGE_ME* ]]; then
            echo "[-] Error: $name still contains a CHANGE_ME placeholder"
            exit 1
        fi
        local escaped
        escaped=$(printf '%s' "$value" | sed -e 's/[\\/&|]/\\&/g')
        sed -i.bak "s|\${$name}|$escaped|g" "$output"
    done
    rm -f "$output.bak"

    if grep -q '\${' "$output"; then
        echo "[-] Error: unrendered \${...} placeholders remain in $output"
        exit 1
    fi
    chmod 600 "$output" 2>/dev/null || true
    echo "[+] Rendered Synapse config: $output"
}

render_synapse_config

# 4. Generate Certificates if missing or invalid
if [ ! -s "certs/server.crt" ] || [ ! -s "certs/server.key" ] \
    || ! openssl x509 -in "certs/server.crt" -noout >/dev/null 2>&1 \
    || ! openssl pkey -in "certs/server.key" -noout >/dev/null 2>&1; then
    echo "[+] SSL Certificates missing or invalid. Invoking cert generation..."
    bash certs/generate_certs.sh "$DETECTED_IP"
else
    echo "[+] SSL Certificates already present and valid."
fi

# 5. Build client static assets if client/dist is missing
if [ ! -d "client/dist" ]; then
    echo "[+] Building client frontend..."
    if command -v npm >/dev/null 2>&1; then
        (cd client && npm install && npm run build) || echo "[!] Client build skipped or package.json pending."
    fi
fi

# 6. Start the Stack
echo "[+] Starting Docker Compose stack..."
docker compose up -d

echo ""
echo "======================================================================"
echo "    AIR-GAPPED OFFLINE LAN SERVER RUNNING SUCCESSFULLY!               "
echo "======================================================================"
echo " 1. Web / Desktop Client URL: https://${DETECTED_IP}"
echo " 2. Matrix Homeserver URL:    https://${DETECTED_IP}"
echo " 3. Coturn STUN/TURN:         turn:${DETECTED_IP}:3478 (UDP/TCP)"
echo " 4. Admin Setup Script:       ./scripts/setup_admin.sh"
echo "======================================================================"
echo " CLIENT TRUST STEP:"
echo " Ensure client computers have imported: certs/rootCA.pem"
echo "======================================================================"
