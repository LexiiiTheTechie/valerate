#!/usr/bin/env sh
# Reset a user password (interactive).
cd "$(dirname "$0")"

NODE_BIN="node"
if [ -x "./node/node" ]; then
  NODE_BIN="$(pwd)/node/node"
fi

if [ ! -f "./offline-app/reset_password.js" ]; then
  echo "offline-app/reset_password.js not found."
  exit 1
fi

cd offline-app
"$NODE_BIN" reset_password.js "$@"
echo ""
echo "Press Enter to close…"
read -r _
