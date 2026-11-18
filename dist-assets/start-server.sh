#!/usr/bin/env sh
# Valerate server launcher for macOS / Linux (requires Node.js 22.5+).
set -e
cd "$(dirname "$0")"

if [ -x "./node/node" ]; then
  PATH="$(pwd)/node:$PATH"
  export PATH
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.5 or newer is required (node:sqlite)."
  echo "Install it from https://nodejs.org, or place a node binary in ./node/."
  exit 1
fi

cd offline-app
PORT_HTTP="${PORT_HTTP:-8080}" \
PORT_HTTPS="${PORT_HTTPS:-8443}" \
ALLOW_HTTP="${ALLOW_HTTP:-1}" \
exec node server.js
