#!/usr/bin/env bash
# ==============================================================================
# MATRIX OFFLINE ADMIN USER REGISTRATION SCRIPT
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -f "$ROOT_DIR/.env" ]; then
    set -a
    source "$ROOT_DIR/.env"
    set +a
else
    echo "Error: .env file not found in $ROOT_DIR. Please run ./scripts/start.sh first."
    exit 1
fi

echo "=========================================================="
echo " Offline Matrix Admin User Provisioning"
echo "=========================================================="

read -p "Enter desired Admin Username: " ADMIN_USER
read -s -p "Enter Admin Password: " ADMIN_PASS
echo ""

docker exec -it offline_chat_synapse register_new_matrix_user \
    -u "$ADMIN_USER" \
    -p "$ADMIN_PASS" \
    -a \
    -c /data/homeserver.yaml \
    http://localhost:8008

echo ""
echo " Admin user @${ADMIN_USER}:${SERVER_NAME} registered successfully!"
