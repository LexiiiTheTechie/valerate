#!/usr/bin/env sh
# Generate local TLS certificates for HTTPS / camera+mic support.
cd "$(dirname "$0")"

if [ -x "./offline-app/gen_certs.sh" ]; then
  ./offline-app/gen_certs.sh
elif [ -f "./offline-app/gen_certs.sh" ]; then
  sh ./offline-app/gen_certs.sh
else
  echo "offline-app/gen_certs.sh not found."
  exit 1
fi

echo ""
echo "Press Enter to close…"
read -r _
