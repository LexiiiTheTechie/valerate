#!/usr/bin/env bash
# ==============================================================================
# VALERATE - BUILD A SELF-CONTAINED PORTABLE PACKAGE (macOS)
# ==============================================================================
# Requirements on the BUILD machine only:
#   - Node.js 22.5+ (node:sqlite) and npm
#   - Rust toolchain (rustc / cargo)
#   - Xcode Command Line Tools (for linking Tauri / WKWebView)
# The produced dist/Valerate-macOS folder needs only this Mac to run.
# ==============================================================================
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
OUT="$ROOT/dist/Valerate-macOS"
ARCH="$(uname -m)"

step() { printf '\n==> %s\n' "$*"; }

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required tool: $1" >&2
    exit 1
  fi
}

# Wrap a Mach-O binary in a minimal .app so Finder / Dock / open(1) work.
make_app() {
  local bin_src="$1"
  local app_dir="$2"
  local bundle_name="$3"
  local display_name="$4"
  local identifier="$5"
  local exe_name="$6"

  rm -rf "$app_dir"
  mkdir -p "$app_dir/Contents/MacOS" "$app_dir/Contents/Resources"
  cp "$bin_src" "$app_dir/Contents/MacOS/$exe_name"
  chmod +x "$app_dir/Contents/MacOS/$exe_name"

  cat > "$app_dir/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>${exe_name}</string>
  <key>CFBundleIdentifier</key>
  <string>${identifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${bundle_name}</string>
  <key>CFBundleDisplayName</key>
  <string>${display_name}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSCameraUsageDescription</key>
  <string>Valerate uses the camera for voice and video calls on your local network.</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>Valerate uses the microphone for voice and video calls on your local network.</string>
</dict>
</plist>
PLIST
}

need node
need npm
need cargo
need rustc

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22.5+ is required (found $(node -v))." >&2
  exit 1
fi

step "Installing frontend dependencies"
(
  cd "$ROOT/offline-tauri-client"
  npm install
)
(
  cd "$ROOT/valerate-dashboard"
  npm install
)

step "Building frontends"
( cd "$ROOT/offline-tauri-client" && npm run build )
( cd "$ROOT/valerate-dashboard" && npm run build )

# Use each crate's own target/ folder so the package is self-describing even
# when the shell has an overriding CARGO_TARGET_DIR (e.g. CI sandboxes).
export CARGO_TARGET_DIR="$ROOT/.cargo-target"
mkdir -p "$CARGO_TARGET_DIR"

step "Compiling release binaries (this can take several minutes)"
( cd "$ROOT/offline-tauri-client/src-tauri" && cargo build --release )
( cd "$ROOT/valerate-dashboard/src-tauri" && cargo build --release )

CLIENT_BIN="$CARGO_TARGET_DIR/release/offline-tauri-client"
DASH_BIN="$CARGO_TARGET_DIR/release/valerate-dashboard"

if [ ! -x "$CLIENT_BIN" ]; then
  echo "Client binary missing: $CLIENT_BIN" >&2
  exit 1
fi
if [ ! -x "$DASH_BIN" ]; then
  echo "Dashboard binary missing: $DASH_BIN" >&2
  exit 1
fi

step "Assembling portable package at $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/node" "$OUT/client" "$OUT/offline-app"

# Server + web client (exclude machine-specific runtime data)
rsync -a \
  --exclude 'data/' \
  --exclude 'uploads/' \
  --exclude 'certs/' \
  --exclude 'node_modules/' \
  "$ROOT/offline-app/" "$OUT/offline-app/"

chmod +x "$OUT/offline-app/gen_certs.sh" 2>/dev/null || true

# Bundled Node runtime
cp "$(command -v node)" "$OUT/node/node"
chmod +x "$OUT/node/node"

# Desktop apps as .app bundles (+ keep bare binaries as fallback)
make_app "$CLIENT_BIN" \
  "$OUT/client/Valerate Messenger.app" \
  "Valerate Messenger" \
  "Valerate Messenger" \
  "com.offline.valerate" \
  "offline-tauri-client"

make_app "$DASH_BIN" \
  "$OUT/Valerate Control Center.app" \
  "Valerate Control Center" \
  "Valerate Control Center" \
  "com.valerate.dashboard" \
  "valerate-dashboard"

cp "$CLIENT_BIN" "$OUT/client/offline-tauri-client"
cp "$DASH_BIN" "$OUT/valerate-dashboard"
chmod +x "$OUT/client/offline-tauri-client" "$OUT/valerate-dashboard"

# Launchers + docs
for file in \
  "Start Valerate.command" \
  "Start Server Only.command" \
  "Generate Certificates.command" \
  "Reset Password.command" \
  "start-server.sh" \
  "README-macOS.txt"
do
  if [ -f "$ROOT/dist-assets/$file" ]; then
    cp "$ROOT/dist-assets/$file" "$OUT/$file"
    chmod +x "$OUT/$file" 2>/dev/null || true
  fi
done

# Clear quarantine so double-click .command / .app works on a fresh copy
if command -v xattr >/dev/null 2>&1; then
  xattr -cr "$OUT" 2>/dev/null || true
fi

step "Done"
echo "Portable package ready: $OUT"
echo "Architecture: $ARCH"
echo "Distribute the whole folder, or zip it for delivery."
echo ""
echo "Quick start: open \"$OUT/Start Valerate.command\""
