# Air-Gapped 100% Offline LAN Communication Platform

An enterprise-grade, zero-trust, completely offline communication platform designed for local area networks (LANs). Operates without internet connectivity, cloud dependencies, or external STUN/TURN servers.

## Features
- **Direct Messages & Public/Private Channels** (Matrix Synapse)
- **Zero External Telemetry or Phone-Home** (Air-gapped whitelist)
- **Local WebRTC Voice & Video Calling** (Embedded Coturn STUN/TURN server)
- **Offline Large Media Transfers** (500MB+ photos, videos, and files)
- **Cross-Platform Local TLS** (Hardware/OS-level certificate generation)
- **Built-in Web Application & Native Client Support** (Element Desktop on macOS & Windows)

---

## Directory Structure

```text
offline-chat-server/
├── docker-compose.yml
├── .env.example
├── config/
│   ├── synapse/
│   │   └── homeserver.yaml
│   ├── coturn/
│   │   └── turnserver.conf
│   └── nginx/
│       └── conf.d/default.conf
├── certs/
│   └── generate_certs.sh
├── scripts/
│   ├── setup_admin.sh
│   └── start.sh
└── client/
    ├── package.json
    └── dist/
        └── index.html
```

---

## Quickstart

### 1. Start the Server Stack
On the host server machine (macOS or Windows WSL2/Docker Desktop):
```bash
cd offline-chat-server
chmod +x scripts/*.sh certs/*.sh
./scripts/start.sh
```
The script will:
1. Detect host LAN IP (e.g. `192.168.1.100`).
2. Generate secure random secrets and configure `.env`.
3. Generate local CA and TLS SAN certificates (`certs/server.crt`, `certs/rootCA.pem`).
4. Spin up PostgreSQL, Synapse, Coturn, and NGINX with persistent volumes.

### 2. Register Initial Admin User
```bash
./scripts/setup_admin.sh
```

---

## Client Setup (macOS & Windows)

WebRTC camera and microphone access require secure contexts (`https://`). Because this is an offline server, client machines must trust the local Root CA certificate (`certs/rootCA.pem`).

### Step 1: Install Local CA Certificate on Client Machines

Copy `offline-chat-server/certs/rootCA.pem` to client machines:

- **macOS:**
  ```bash
  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain rootCA.pem
  ```
- **Windows (Run Command Prompt as Administrator):**
  ```cmd
  certutil -addstore -f "ROOT" rootCA.pem
  ```

---

### Step 2: Connect via Built-in Web App
Open any browser on the LAN:
```
https://<LAN_IP>    (e.g., https://192.168.1.100)
```
- Sign in with the registered credentials or click **"Create New Local Account"**.
- Start real-time chats, upload videos/files, or click **🎥 Video Call** / **🎤 Voice Call**.

---

### Step 3: Connect via Element Desktop (macOS & Windows)

1. Download and install **Element Desktop** on client machines.
2. Launch Element and click **Sign In**.
3. Under **Homeserver**, click **Change** (or **Edit**).
4. Select **Other homeserver** and enter:
   ```
   https://<LAN_IP>    (e.g., https://192.168.1.100)
   ```
5. Enter your username and password.
6. WebRTC 1-to-1 voice/video calls and group channels will route completely offline through the local Coturn container.
