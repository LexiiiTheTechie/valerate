#!/usr/bin/env sh
# Launch the Valerate Control Center on macOS.
cd "$(dirname "$0")"

APP="./Valerate Control Center.app"
BIN="./valerate-dashboard"

if [ -d "$APP" ]; then
  open -n "$APP"
  exit 0
fi

if [ -x "$BIN" ]; then
  exec "$BIN"
fi

echo "Valerate Control Center not found."
echo "Build it with: ./build-portable-macos.sh"
exit 1
