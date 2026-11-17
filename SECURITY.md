# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub's **Security → Report a vulnerability** feature
(Security Advisories) for this repository. If that is unavailable, open a
minimal issue asking for a private contact channel without disclosing details.

Include:

- affected component (server, web client, desktop client, dashboard)
- steps to reproduce
- impact and any proof-of-concept details
- the commit or release you tested

You can expect an initial response within a few days. Please allow time for a
fix before public disclosure.

## Supported versions

Security fixes target the latest release on the default branch. Older builds
and prebuilt portable bundles are not maintained — rebuild from source.

## Design notes

Valerate is designed for trusted local networks and air-gapped machines.

- **Transport:** TLS 1.2+ when certificates exist. `ALLOW_HTTP=1` serves
  plaintext HTTP and is strictly for development or a trusted LAN.
- **Passwords:** scrypt (`N=32768, r=8, p=1`). Legacy PBKDF2-SHA512 hashes
  verify and are upgraded after a successful login.
- **Sessions:** 256-bit tokens held in memory only, with idle and absolute
  lifetimes. Restarting the server invalidates all sessions.
- **Authorization:** uploads need a bearer token; vault downloads require both
  a valid token and recorded ownership.
- **Rate limiting:** per-socket and per-IP limits on authentication.
- **Origin validation:** WebSocket upgrades are accepted only from loopback,
  RFC1918 private addresses, the advertised LAN IP, or Tauri's
  `*.localhost` origin.
- **Audit log:** authentication and file events are written to
  `offline-app/data/security.log`.

## Handling secrets

Never commit:

- `offline-app/certs/` (PFX files and `pfx_password.txt`)
- `offline-app/data/`, `offline-app/uploads/`
- `.env` files
- audit logs or SQLite databases

These are covered by `.gitignore`. If a secret is committed accidentally,
rotate it and treat the history as compromised.
