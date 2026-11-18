const path = require('node:path');

// Blocked upload file extensions. Markup/script containers are included
// because they would execute on the application origin if served inline.
const BLOCKED_EXTENSIONS = new Set([
  // Executables / libraries
  '.exe', '.bat', '.cmd', '.com', '.msi', '.dll', '.sys', '.scr', '.pif',
  '.cpl', '.inf', '.reg', '.lnk', '.msc', '.gadget',
  // Scripts
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.psd1',
  '.vbs', '.vbe', '.js', '.mjs', '.cjs', '.jse', '.wsf', '.wsh', '.hta', '.htc',
  '.jar', '.class', '.py', '.rb', '.pl', '.php',
  // Active/markup content that can execute in a browser
  '.html', '.htm', '.xhtml', '.shtml', '.svg', '.svgz', '.xml', '.xsl', '.xslt',
  '.mht', '.mhtml', '.webmanifest'
]);

class Router {
  constructor(fileService, sessionManager, lanIp, options = {}) {
    this.fileService = fileService;
    this.sessionManager = sessionManager;
    this.lanIp = lanIp;
    this.vaultAccessCheck = options.vaultAccessCheck || null;
    this.audit = options.audit || null;
  }

  /**
   * Validates the Authorization header (or ?token= for media subresources)
   * and returns the username, or null if invalid.
   */
  _resolveToken(req, parsedUrl) {
    const auth = req.headers['authorization'] || '';
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      const user = this.sessionManager.getUserByToken(token);
      if (user) return user;
    }
    const queryToken = parsedUrl.searchParams.get('token');
    if (queryToken) {
      return this.sessionManager.getUserByToken(queryToken) || null;
    }
    return null;
  }

  /**
   * Desktop Tauri clients (and other LAN browsers) are cross-origin relative to
   * this server. Allow same-host, private-LAN, and Tauri webview origins so
   * authenticated uploads and media fetches work. Public internet origins are
   * still rejected.
   */
  _isAllowedCorsOrigin(origin, requestHost) {
    if (!origin || typeof origin !== 'string') return false;

    // Custom schemes used by Tauri 2 webviews (esp. macOS WKWebView).
    const tauriSchemes = [
      'tauri://localhost',
      'asset://localhost',
      'ipc://localhost',
      'http://tauri.localhost',
      'https://tauri.localhost',
      'http://ipc.localhost',
      'https://ipc.localhost'
    ];
    if (tauriSchemes.includes(origin.toLowerCase())) return true;

    let parsedOrigin;
    try {
      parsedOrigin = new URL(origin);
    } catch (_) {
      return false;
    }

    if (!['http:', 'https:'].includes(parsedOrigin.protocol)) return false;

    const originHost = parsedOrigin.host.toLowerCase();
    if (originHost === String(requestHost || '').toLowerCase()) return true;

    const hostname = parsedOrigin.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === 'tauri.localhost' ||
      hostname === 'ipc.localhost'
    ) {
      return true;
    }

    // Private / link-local IPv4 (LAN clients talking to this host).
    return (
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      /^169\.254\./.test(hostname)
    );
  }

  _setCommonHeaders(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');

    const origin = req.headers.origin;
    const requestHost = (req.headers.host || '').toLowerCase();
    if (this._isAllowedCorsOrigin(origin, requestHost)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Vary', 'Origin');
    }
  }

  _json(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(body));
  }

  _handleUpload(req, res, parsedUrl, isVault) {
    const username = this._resolveToken(req, parsedUrl);
    if (!username) {
      this._json(res, 401, { error: 'Unauthorized: valid session token required.' });
      return;
    }

    const rawName = parsedUrl.searchParams.get('filename') || '';
    const ext = path.extname(rawName).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      this.audit?.('upload_rejected', { username, ext, vault: isVault });
      this._json(res, 400, { error: 'This file type is not permitted.' });
      return;
    }

    this.audit?.('upload_accepted', { username, vault: isVault, ext: ext || '(none)' });
    this.fileService.handleUpload(req, res, parsedUrl.searchParams, { isVault });
  }

  handle(req, res) {
    this._setCommonHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Use a fixed base rather than the attacker-controlled Host header. Only
    // pathname/searchParams are used, so the authority is irrelevant.
    let parsedUrl;
    try {
      parsedUrl = new URL(req.url, 'https://localhost');
    } catch (_) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    const pathname = parsedUrl.pathname;
    const method = req.method;

    if (pathname === '/api/upload' && method === 'POST') {
      this._handleUpload(req, res, parsedUrl, false);
      return;
    }

    if (pathname === '/api/vault/upload' && method === 'POST') {
      this._handleUpload(req, res, parsedUrl, true);
      return;
    }

    if (pathname.startsWith('/api/vault/') && method === 'GET') {
      const username = this._resolveToken(req, parsedUrl);
      if (!username) {
        this._json(res, 401, { error: 'Unauthorized: valid session token required.' });
        return;
      }
      const filename = path.basename(pathname);
      const allowed = this.vaultAccessCheck ? this.vaultAccessCheck(username, filename) : false;
      if (!allowed) {
        // Return 404 rather than 403 so file existence is not disclosed.
        this.audit?.('vault_access_denied', { username, filename });
        this._json(res, 404, { error: 'Not Found' });
        return;
      }
      this.audit?.('vault_download', { username, filename });
      this.fileService.serveVaultFile(req, res, pathname);
      return;
    }

    if (pathname.startsWith('/uploads/') && method === 'GET') {
      const username = this._resolveToken(req, parsedUrl);
      if (!username) {
        this._json(res, 401, { error: 'Unauthorized: valid session token required.' });
        return;
      }
      this.fileService.serveUploadFile(req, res, pathname);
      return;
    }

    if ((pathname === '/ca' || pathname === '/rootCA.pem') && method === 'GET') {
      this.fileService.serveRootCa(res);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD, POST, OPTIONS' });
      res.end('Method Not Allowed');
      return;
    }

    this.fileService.serveStatic(pathname, res);
  }
}

module.exports = { Router, BLOCKED_EXTENSIONS };
