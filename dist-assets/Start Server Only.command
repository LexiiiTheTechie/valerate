#!/usr/bin/env sh
# Run only the Valerate LAN server (browser clients can connect).
cd "$(dirname "$0")"
exec ./start-server.sh
