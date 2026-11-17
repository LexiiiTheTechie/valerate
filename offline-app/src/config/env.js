const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

/**
 * Auto-detects the machine's LAN IPv4 address so the app works on any network
 * instead of assuming a hardcoded LAN IP. An explicit LAN_IP env var
 * always wins (useful for multi-NIC hosts or reverse proxies).
 */
function detectLanIp() {
  const candidates = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      candidates.push(info.address);
    }
  }
  return (
    candidates.find((ip) => ip.startsWith('192.168.')) ||
    candidates.find((ip) => ip.startsWith('10.')) ||
    candidates.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) ||
    candidates[0] ||
    '127.0.0.1'
  );
}
const DATA_DIR = path.join(ROOT_DIR, 'data');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
const VAULT_DIR = path.join(DATA_DIR, 'vault');
const CERTS_DIR = path.join(ROOT_DIR, 'certs');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

[DATA_DIR, UPLOADS_DIR, VAULT_DIR, CERTS_DIR, PUBLIC_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Prefer a generated PFX passphrase file over the legacy default. The file is
// created by gen_certs.ps1 and should be protected with restrictive ACLs.
function resolvePfxPassword() {
  if (process.env.PFX_PASSWORD) return process.env.PFX_PASSWORD;
  const passwordFile = path.join(CERTS_DIR, 'pfx_password.txt');
  try {
    if (fs.existsSync(passwordFile)) {
      const value = fs.readFileSync(passwordFile, 'utf8').trim();
      if (value) return value;
    }
  } catch (_) {
    // Fall through to the legacy default so existing installs keep working.
  }
  return 'offline_pass';
}

module.exports = {
  PORT_HTTP: parseInt(process.env.PORT_HTTP || '80', 10),
  PORT_HTTPS: parseInt(process.env.PORT_HTTPS || '443', 10),
  LAN_IP: process.env.LAN_IP || detectLanIp(),
  ROOT_DIR,
  DATA_DIR,
  UPLOADS_DIR,
  VAULT_DIR,
  CERTS_DIR,
  PUBLIC_DIR,
  DB_PATH: path.join(DATA_DIR, 'offline_messenger.sqlite3'),
  PFX_PATH: path.join(CERTS_DIR, 'cert.pfx'),
  ROOT_CA_PATH: path.join(CERTS_DIR, 'rootCA.pem'),
  PFX_PASSWORD: resolvePfxPassword(),
  AUDIT_LOG_PATH: path.join(DATA_DIR, 'security.log'),
  SESSION_IDLE_TTL_MS: parseInt(process.env.SESSION_IDLE_TTL_MS || String(12 * 60 * 60 * 1000), 10),
  SESSION_ABSOLUTE_TTL_MS: parseInt(process.env.SESSION_ABSOLUTE_TTL_MS || String(7 * 24 * 60 * 60 * 1000), 10),
  // Never serve the app over plaintext unless this is explicitly opted into
  // for local development. In production the HTTP listener only redirects.
  ALLOW_HTTP: process.env.ALLOW_HTTP === '1',
  AVATAR_COLORS: ['#38bdf8', '#818cf8', '#c084fc', '#f472b6', '#fb7185', '#34d399', '#fbbf24']
};
