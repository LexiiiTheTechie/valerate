# AirGap LAN Messenger - Desktop App (Tauri v2 + React)

A native desktop application built with **Rust (Tauri v2)** and **React 18** that connects to your offline LAN server over local Wi-Fi / Ethernet.

## Features
- **Native OS Window** (Hardware accelerated, low RAM ~30MB)
- **React 18 + Vite** frontend
- **Left-aligned chat stream with 46px avatars**
- **Discord-style pop-out profile cards**
- **WebRTC Voice & Video calling** over LAN
- **Offline file, audio, and video sharing**

---

## How to Run in Development Mode

From this folder (`offline-tauri-client`):

1. **Install Frontend Dependencies:**
   ```bash
   npm install
   ```

2. **Run Desktop App in Dev Mode:**
   ```bash
   npm run tauri dev
   ```
   *(Or if using cargo directly: `cargo tauri dev`)*

---

## How to Build the Production Executable (.exe)

To compile a standalone `.exe` installer or portable binary:

```bash
npm run tauri build
```

The compiled release `.exe` will be located in:
`src-tauri/target/release/AirGap Messenger.exe`
