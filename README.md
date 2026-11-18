# Valerate — Offline LAN Messenger

(Named after Estradiol Valerate)

A self-hosted communication suite that works entirely on a local network with **no internet, no cloud account, and no third-party runtime dependencies**.

Valerate gives you real-time chat, direct messages, file sharing, a personal encrypted-vault-style file store, and WebRTC voice/video calls between devices on the same LAN. The reference deployment is a single Windows portable folder that bundles everything, including Node.js.

> **Status:** actively developed. The server has no npm dependencies; the desktop apps are Tauri + React.

---

## Highlights

- **Air-gapped by design** — all traffic stays on the LAN. No telemetry, no remote APIs.
- **Zero-dependency server** — pure Node.js standard library (`http`, `https`, `crypto`, `node:sqlite`, custom WebSocket implementation).
- **Web client included** — the server serves a full browser UI, so phones and tablets need no install.
- **Native desktop client** — Tauri + React app for Windows, with local certificate handling built in.
- **Control center** — a second Tauri app that starts/stops the server, streams live logs, launches clients, and wipes data.
- **Channels, DMs, friends, presence, typing indicators, profiles.**
- **File attachments and a Personal Vault** with token-gated downloads.
- **WebRTC voice/video signaling** over the same WebSocket (HTTPS required for camera/mic).
- **Security-minded** — scrypt password hashing, in-memory session tokens, per-socket and per-IP rate limits, TLS 1.2+, audit log, Origin validation.

---

## Repository layout

| Path | What it is |
| --- | --- |
| `offline-app/` | Node.js server, SQLite persistence, WebSocket dispatcher, built-in web UI |
| `offline-tauri-client/` | Native desktop chat client (Tauri 2 + React 18 + Vite) |
| `valerate-dashboard/` | Native control center (Tauri 2 + React 18 + Vite) |
| `dist-assets/` | Launchers and README used by the portable build |
| `build-portable.ps1` | Builds the self-contained Windows portable bundle |
| `offline-chat-server/` | Optional/legacy Matrix + Synapse + Coturn Docker stack |
| `tests/` | End-to-end protocol test |

Build output, runtime data, certificates and dependencies are excluded by `.gitignore`.

---

## Requirements

| Component | Requirement |
| --- | --- |
| Server | Node.js **22.5+** (uses `node:sqlite`) |
| Web UI | Any modern browser |
| Desktop apps | Rust toolchain with MSVC target, Node.js 22+, WebView2 (preinstalled on Windows 10/11) |
| Portable bundle | Nothing — Node.js is bundled |

---

## Quick start (development)

### 1. Run the server

```bash
cd offline-app

# Windows PowerShell
$env:ALLOW_HTTP = "1"
$env:PORT_HTTP = "8080"
node server.js
```

```bash
# macOS / Linux
ALLOW_HTTP=1 PORT_HTTP=8080 node server.js
```

Open <http://localhost:8080> in a browser. The web UI uses the same API as the desktop client.

> `ALLOW_HTTP=1` serves plaintext HTTP and is intended for local development / trusted LANs only. Without it, the server requires a PFX certificate and redirects HTTP to HTTPS.

### 2. Desktop client

```bash
cd offline-tauri-client
npm install
npm run tauri dev
```

The client defaults to `http://localhost:8080`. Change the **Server URL** field to connect to another machine on the LAN.

### 3. Control center

```bash
cd valerate-dashboard
npm install
npm run tauri dev
```

---

## Portable Windows build

```powershell
powershell -ExecutionPolicy Bypass -File .\build-portable.ps1
```

Output: `dist\Valerate-Portable\` (and zip it for distribution). The bundle contains:

- `valerate-dashboard.exe`
- `client\offline-tauri-client.exe`
- `offline-app\` (server + web client)
- `node\node.exe` (bundled runtime)
- Launchers: `Start Valerate.bat`, `Start Server Only.bat`, `Generate Certificates.bat`, `Reset Password.bat`

A fresh bundle contains **no accounts and no data**. The server creates an empty database on first start.

## Portable macOS build

```bash
chmod +x ./build-portable-macos.sh
./build-portable-macos.sh
```

Output: `dist/Valerate-macOS/`. The bundle contains:

- `Valerate Control Center.app` (and `valerate-dashboard` binary)
- `client/Valerate Messenger.app` (and bare client binary)
- `offline-app/` (server + web client)
- `node/node` (bundled runtime)
- Launchers: `Start Valerate.command`, `Start Server Only.command`, `Generate Certificates.command`, `Reset Password.command`

Double-click **Start Valerate.command**. If macOS blocks it the first time, right-click → Open, or run `xattr -cr dist/Valerate-macOS`.

TLS certs on macOS/Linux: `./offline-app/gen_certs.sh` (or the Generate Certificates.command launcher).

---

## Configuration

Environment variables read by `offline-app/src/config/env.js`:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT_HTTP` | `80` | HTTP port (web UI; redirects to HTTPS unless `ALLOW_HTTP=1`) |
| `PORT_HTTPS` | `443` | HTTPS port (falls back to 8443/8444/8445/9443 if busy) |
| `LAN_IP` | auto-detected | Override the advertised LAN address |
| `ALLOW_HTTP` | off | `1` serves the full app over plain HTTP (development) |
| `PFX_PASSWORD` | from `certs/pfx_password.txt` | Passphrase for the PFX certificate |
| `SESSION_IDLE_TTL_MS` | `43200000` (12 h) | Session idle timeout |
| `SESSION_ABSOLUTE_TTL_MS` | `604800000` (7 d) | Session absolute lifetime |

Port collisions are handled gracefully: the server tries one port per candidate, logs one warning, and never loops.

---

## HTTPS and calls

Browsers only expose camera and microphone on secure origins. For calls between devices:

1. Generate a local certificate once:
   ```powershell
   # from the portable folder
   .\Generate Certificates.bat
   # or in a source checkout
   powershell -ExecutionPolicy Bypass -File .\offline-app\gen_certs.ps1
   ```
2. Install `offline-app\certs\rootCA.pem` as a trusted root on each client device.
3. Connect over `https://<lan-ip>:8443`.

The desktop client accepts the local certificate automatically.

---

## Data and privacy

Runtime data lives next to the server:

```
offline-app/data/       SQLite database, vault files, audit log
offline-app/uploads/    Chat attachments
offline-app/certs/      Generated TLS material (never commit)
```

These paths are git-ignored. **They are never part of a release.**

### Reset an account password

With the server stopped:

```bash
cd offline-app
node reset_password.js <username> <new-password>
```

### Delete all server data

Use **Wipe ALL Server Data** in the control center, or stop the server and delete:

```
offline-app/data/
offline-app/uploads/
```

This removes accounts, chats, vault contents, uploads and the audit log.

---

## Security model

- Passwords: scrypt with `N=32768, r=8, p=1`; legacy PBKDF2-SHA512 hashes still verify and are upgraded on successful login.
- Session tokens: 256-bit, stored in memory only, never logged.
- Rate limiting: per WebSocket and per IP for authentication.
- Authorization: uploads require a bearer token; vault downloads require ownership and a valid token.
- Origin validation: loopback, RFC1918 hosts, the advertised LAN IP, and Tauri's `*.localhost` origin.
- Audit log: authentication and file events are appended to `data/security.log`.
- No external network calls from the server or clients.

See [`SECURITY.md`](SECURITY.md) for more detail.

---

## Testing the protocol

With a server running (for example on port 8080):

```bash
node tests/protocol.mjs http://127.0.0.1:8080
```

The test exercises registration, login, channels, DMs, friends, profiles, uploads, the vault, and authorization failures over the real WebSocket + HTTP API. It creates throwaway users; use a development database.

---

## License

[MIT](LICENSE) © Valerate contributors

The optional `offline-chat-server/` stack orchestrates third-party software (Synapse, Coturn, PostgreSQL, NGINX) and is subject to their respective licenses.
