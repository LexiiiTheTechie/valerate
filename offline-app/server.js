// ==============================================================================
// AIR-GAP OFFLINE LAN SERVER (SOLID & DRY REFACTORED ARCHITECTURE)
// Composition Root: Injects dependencies and binds servers
// Zero external dependencies - pure Node.js standard library
// ==============================================================================
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');

// Config & Services
const config = require('./src/config/env');
const { OfflineDatabase } = require('./database');
const { FileService } = require('./src/services/FileService');
const { SessionManager } = require('./src/services/SessionManager');
const { AuditLog } = require('./src/services/AuditLog');
const { Router } = require('./src/http/Router');
const { PureWebSocketServer } = require('./websocket');
const { WebSocketDispatcher } = require('./src/websocket/WebSocketDispatcher');

// 1. Initialize Persistent Storage (Dependency Injection)
const db = new OfflineDatabase(config.DB_PATH);

// 2. Initialize Core Domain Services
const auditLog = new AuditLog(config.AUDIT_LOG_PATH);
const audit = (event, details) => auditLog.write(event, details);

const fileService = new FileService(
  config.UPLOADS_DIR,
  config.VAULT_DIR,
  config.PUBLIC_DIR,
  config.ROOT_CA_PATH
);
const sessionManager = new SessionManager({
  idleTtlMs: config.SESSION_IDLE_TTL_MS,
  absoluteTtlMs: config.SESSION_ABSOLUTE_TTL_MS
});
const router = new Router(fileService, sessionManager, config.LAN_IP, {
  vaultAccessCheck: (username, filename) => db.isVaultFileOwnedBy(username, filename),
  audit
});

// 3. HTTP Request Listener
const requestListener = (req, res) => {
  try {
    router.handle(req, res);
  } catch (err) {
    console.error('[-] Request handling error:', err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'Internal server error.' }));
  }
};

// 4. Initialize HTTPS Server with Local PFX TLS Certificate
let httpsServer = null;
if (fs.existsSync(config.PFX_PATH)) {
  try {
    const pfx = fs.readFileSync(config.PFX_PATH);
    httpsServer = https.createServer({ pfx, passphrase: config.PFX_PASSWORD }, requestListener);
  } catch (err) {
    console.error('[-] Failed to load PFX certificate:', err.message);
  }
}

if (!httpsServer && !config.ALLOW_HTTP) {
  console.error('[-] Refusing to start: TLS certificate is missing or invalid.');
  console.error('    Generate certs with gen_certs.ps1, or set ALLOW_HTTP=1 for local development only.');
  process.exit(1);
}
if (!httpsServer && config.ALLOW_HTTP) {
  console.warn('[!] ALLOW_HTTP=1: serving plaintext HTTP. Never use this on a shared network.');
}

// 5. HTTP Server: strict redirect to HTTPS in production, full app only in
// explicit development mode.
let activeHttpsPort = config.PORT_HTTPS;

function buildRedirectUrl(req) {
  let host = req.headers.host;
  if (typeof host !== 'string' || !/^[A-Za-z0-9.\-:\[\]]{1,255}$/.test(host)) {
    host = config.LAN_IP;
  }
  host = host.replace(/:\d+$/, '');
  const portPart = activeHttpsPort === 443 ? '' : `:${activeHttpsPort}`;
  const target = typeof req.url === 'string' && req.url.startsWith('/') ? req.url : '/';
  return `https://${host}${portPart}${target}`;
}

const httpServer = http.createServer((req, res) => {
  if (config.ALLOW_HTTP) {
    requestListener(req, res);
    return;
  }
  res.writeHead(301, {
    Location: buildRedirectUrl(req),
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8'
  });
  res.end('Redirecting to HTTPS');
});

// 6. WebSocket Real-time Signaling Engine. In production it only runs on the
// HTTPS listener; the HTTP listener never carries WebSocket traffic.
// True for loopback and RFC1918 private LAN hosts. This lets any device on the
// same local network (phone, tablet, another PC) connect through the built-in
// web client, no matter which LAN IP this host was assigned.
function isPrivateHost(hostname) {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  // Tauri/WebView2 serves the bundled desktop client from tauri.localhost
  // (or tauri://localhost). Treat any *.localhost name as loopback so the
  // packaged client can open its WebSocket connection and log in.
  if (host === 'tauri.localhost' || host.endsWith('.localhost')) return true;
  if (host === String(config.LAN_IP).toLowerCase()) return true;
  return (
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host)
  );
}

function originCheck(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // native client without Origin
  try {
    const parsed = new URL(origin);
    if (isPrivateHost(parsed.hostname)) return true;
    // Also accept the exact host the request was addressed to (handles
    // hostnames / mDNS names such as my-pc.local).
    const requestHost = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    return Boolean(requestHost) && parsed.hostname.toLowerCase() === requestHost;
  } catch (_) {
    return false;
  }
}

const wssHttps = httpsServer ? new PureWebSocketServer(httpsServer, { originCheck }) : null;
const wssHttp = config.ALLOW_HTTP ? new PureWebSocketServer(httpServer, { originCheck }) : null;

const dispatcher = new WebSocketDispatcher(db, sessionManager, null, config.AVATAR_COLORS, {
  lanIp: config.LAN_IP,
  audit
});

// Create a unified broadcast wrapper
const unifiedWss = {
  broadcast: (data, filterFn = null) => {
    if (wssHttps) wssHttps.broadcast(data, filterFn);
    if (wssHttp) wssHttp.broadcast(data, filterFn);
  }
};
dispatcher.wss = unifiedWss;

const setupWsEvents = (wssInstance) => {
  if (!wssInstance) return;
  wssInstance.on('connection', (ws) => {
    ws.on('message', (msg) => {
      Promise.resolve(dispatcher.handleMessage(ws, msg)).catch((err) => {
        console.error('[WS] unhandled dispatch error:', err.message);
        try {
          dispatcher._alert(ws, 'error', 'Request could not be processed.');
        } catch (_) { /* ignore */ }
      });
    });
    ws.on('close', () => {
      try {
        dispatcher.handleDisconnect(ws);
      } catch (err) {
        console.error('[WS] disconnect handler error:', err.message);
      }
    });
    ws.on('error', () => {
      try {
        dispatcher.handleDisconnect(ws);
      } catch (_) { /* ignore */ }
    });
  });
};

setupWsEvents(wssHttps);
setupWsEvents(wssHttp);

if (!config.ALLOW_HTTP) {
  httpServer.on('upgrade', (req, socket) => {
    socket.destroy();
  });
}

// 7. Resilient Port Listener Helpers
//
// Each port is attempted exactly once with a one-shot error handler. The
// original implementation re-entered listen() from an 'error' listener, which
// caused an infinite loop of EADDRINUSE errors when a port was already taken.
function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
    };
    const onListening = () => { cleanup(); resolve(port); };
    const onError = (err) => { cleanup(); reject(err); };
    server.once('listening', onListening);
    server.once('error', onError);
    try {
      server.listen(port, host);
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

async function bindWithFallback(server, label, preferredPort, fallbacks) {
  const candidates = [preferredPort, ...fallbacks]
    .filter((p, i, all) => Number.isInteger(p) && p > 0 && all.indexOf(p) === i);
  const failures = [];

  for (const port of candidates) {
    try {
      await listenOnce(server, port, '0.0.0.0');
      if (port !== preferredPort) {
        console.warn(`[!] ${label} port ${preferredPort} was busy; listening on ${port} instead.`);
      }
      return port;
    } catch (err) {
      failures.push(`${port} (${err.code || err.message})`);
      if (err.code && err.code !== 'EADDRINUSE' && err.code !== 'EACCES') break;
    }
  }

  console.error(`[-] ${label} listener could not start. Tried: ${failures.join(', ')}`);
  return null;
}

// Detects an already-running Valerate server so we never start a duplicate
// against the same database.
async function existingValerateServer(port) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 700);
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    const text = await res.text();
    clearTimeout(timer);
    return res.ok && /AirGap LAN Messenger|AirGap Desktop/i.test(text);
  } catch (_) {
    return false;
  }
}

async function startServer() {
  const startedAt = Date.now();
  if (config.ALLOW_HTTP && await existingValerateServer(config.PORT_HTTP)) {
    console.log(`[!] A Valerate server is already running at http://localhost:${config.PORT_HTTP}.`);
    console.log('[!] Reusing that instance instead of starting a duplicate.');
    // Exit on the next tick so the aborted health-check request can fully
    // close. Calling process.exit() immediately can trip a libuv assertion
    // on Windows while the socket handle is still closing.
    setTimeout(() => process.exit(0), 150);
    return;
  }

  let httpsPort = null;
  if (httpsServer) {
    httpsPort = await bindWithFallback(httpsServer, 'HTTPS', config.PORT_HTTPS, [8443, 8444, 8445, 9443]);
    if (httpsPort) {
      activeHttpsPort = httpsPort;
      console.log(`[+] Offline Secure LAN Server running: https://${config.LAN_IP}:${httpsPort}`);
      console.log(`[+] Local Access URL: https://localhost:${httpsPort}`);
      console.log(`[+] SQLite Persistent Database: ${config.DB_PATH}`);
      console.log(`[+] Audit log: ${config.AUDIT_LOG_PATH}`);
    }
  }

  const httpPort = await bindWithFallback(httpServer, 'HTTP', config.PORT_HTTP, [8081, 8082, 8083, 8084, 8090]);
  if (httpPort == null) {
    if (!httpsPort) {
      console.error('[-] No network ports available. Another Valerate server may already be running.');
      process.exit(1);
    }
    console.error('[-] HTTP listener unavailable; only HTTPS is running.');
    return;
  }

  if (config.ALLOW_HTTP) {
    console.log(`[!] HTTP development listener running: http://${config.LAN_IP}:${httpPort}`);
  } else {
    console.log(`[+] HTTP redirect running: http://${config.LAN_IP}:${httpPort} -> https://...`);
  }
  console.log(`[+] Startup complete in ${Date.now() - startedAt} ms`);
}

// Malformed TLS handshakes / sockets must not crash the process.
const onClientError = (err, socket) => {
  if (socket && !socket.destroyed) {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } catch (_) { /* ignore */ }
  }
};
if (httpsServer) httpsServer.on('clientError', onClientError);
httpServer.on('clientError', onClientError);

process.on('uncaughtException', (err) => {
  console.error('[!] Uncaught exception, shutting down:', err.message);
  audit('process_uncaught_exception', { message: err.message });
  setTimeout(() => process.exit(1), 250).unref();
});

process.on('unhandledRejection', (reason) => {
  console.error('[!] Unhandled promise rejection:', reason);
  audit('process_unhandled_rejection', { message: String(reason) });
});

startServer().catch((err) => {
  console.error('[-] Failed to start server:', err.message);
  process.exit(1);
});
