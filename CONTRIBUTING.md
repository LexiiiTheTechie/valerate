# Contributing

Thanks for taking a look at Valerate. This project is small and dependency-light
by design; please keep it that way.

## Development setup

Requirements: Node.js 22.5+ and, for the desktop apps, Rust with the MSVC
toolchain (Windows) or the platform Tauri prerequisites.

```bash
# server + web client
cd offline-app
ALLOW_HTTP=1 PORT_HTTP=8080 node server.js     # PowerShell: $env:ALLOW_HTTP="1"

# desktop client
cd offline-tauri-client
npm install
npm run tauri dev

# control center
cd valerate-dashboard
npm install
npm run tauri dev
```

Run `npm run build` in each frontend before a production build. To produce the
portable bundle, run `build-portable.ps1` on Windows.

## Guidelines

- The server must remain **free of third-party npm dependencies**. Use the Node
  standard library.
- Validate and bound all input from WebSocket and HTTP handlers. Preserve the
  existing rate limits and authorization checks.
- Never log passwords, session tokens, or full message contents.
- Keep destructive actions behind an explicit confirmation constant shared by
  the UI and the Rust command (for example `WIPE ALL DATA`).
- Follow the existing style:
  - server: CommonJS, 2-space indent, `_private` helpers on classes
  - frontend: React function components and hooks, inline styles for small
    components, CSS variables for theming
- Keep changes focused. Avoid reformatting unrelated files.

## Checks

```bash
# syntax check every server file
node --check offline-app/server.js

# frontend production builds
(cd offline-tauri-client && npm run build)
(cd valerate-dashboard && npm run build)

# protocol smoke test against a running dev server
node tests/protocol.mjs http://127.0.0.1:8080
```

GitHub Actions runs these checks on Windows for every push and pull request.

## Secrets and personal data

Before committing, confirm that no certificates, databases, uploads, logs, or
`.env` files are staged. They should already be covered by `.gitignore`.

## Pull requests

- Describe the problem and the approach.
- Note any security-relevant behaviour changes.
- Include the commands you ran to verify the change.
