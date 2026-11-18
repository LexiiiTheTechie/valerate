const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.7z': 'application/x-7z-compressed'
};

const SAFE_DISK_NAME_RE = /^[A-Za-z0-9._-]+$/;

// CSP for the app pages. Inline scripts and inline event handlers have been
// removed from the client, so script-src is locked to same-origin files only.
// style-src keeps 'unsafe-inline' because the client uses style attributes.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // http: is required when ALLOW_HTTP=1 (local / trusted LAN development).
  "img-src 'self' http: https: data: blob:",
  "media-src 'self' http: https: blob:",
  "connect-src 'self' http: https: ws: wss:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join('; ');

class FileService {
  constructor(uploadsDir, vaultDir, publicDir, rootCaPath) {
    this.uploadsDir = uploadsDir;
    this.vaultDir = vaultDir;
    this.publicDir = publicDir;
    this.rootCaPath = rootCaPath;
  }

  getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
  }

  sanitizeFileName(rawName) {
    const base = path.basename(String(rawName || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
    return base.slice(0, 180) || `file_${Date.now()}`;
  }

  _contentDisposition(fileName, disposition = 'attachment') {
    const ascii = String(fileName || 'download')
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\]/g, '_');
    const kind = disposition === 'inline' ? 'inline' : 'attachment';
    return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName || 'download')}`;
  }

  _isInlineMedia(contentType) {
    return (
      contentType.startsWith('image/') ||
      contentType.startsWith('video/') ||
      contentType.startsWith('audio/')
    );
  }

  handleUpload(req, res, searchParams, options = {}) {
    const isVault = Boolean(options.isVault);
    const rawName = searchParams.get('filename') || `file_${Date.now()}`;
    const safeBase = this.sanitizeFileName(rawName);
    const ext = path.extname(safeBase).toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
    // Random disk name: no timestamp collisions, no original-name leakage.
    const diskName = `${crypto.randomUUID()}${safeExt}`;
    const dir = isVault ? this.vaultDir : this.uploadsDir;
    const targetPath = path.join(dir, diskName);

    fs.mkdirSync(dir, { recursive: true });

    let responded = false;
    const respond = (status, body) => {
      if (responded) return;
      responded = true;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify(body));
    };

    const cleanup = () => {
      try {
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      } catch (_) { /* best effort */ }
    };

    let writeStream;
    try {
      writeStream = fs.createWriteStream(targetPath, { flags: 'wx' });
    } catch (_) {
      respond(500, { error: 'Upload could not be stored.' });
      return;
    }

    const onAbort = () => {
      cleanup();
      respond(400, { error: 'Upload was interrupted.' });
    };
    req.once('aborted', onAbort);
    req.once('error', onAbort);

    writeStream.on('finish', () => {
      req.removeListener('aborted', onAbort);
      req.removeListener('error', onAbort);
      let stats;
      try {
        stats = fs.statSync(targetPath);
      } catch (_) {
        cleanup();
        respond(500, { error: 'Upload could not be stored.' });
        return;
      }
      respond(200, {
        success: true,
        url: isVault ? `/api/vault/${diskName}` : `/uploads/${diskName}`,
        fileName: safeBase,
        fileSize: stats.size,
        vault: isVault
      });
    });

    writeStream.on('error', (err) => {
      req.removeListener('aborted', onAbort);
      req.removeListener('error', onAbort);
      cleanup();
      console.error('[upload] write failed:', err.message);
      respond(500, { error: 'Upload could not be stored.' });
    });

    req.pipe(writeStream);
  }

  _serveFromDir(req, res, pathname, dir) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch (_) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    if (decoded.includes('\0')) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    const filename = path.basename(decoded);
    if (!SAFE_DISK_NAME_RE.test(filename)) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    const resolved = path.resolve(dir, filename);
    const relative = path.relative(path.resolve(dir), resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const stat = fs.statSync(resolved);
    const contentType = this.getMimeType(resolved);
    // Images/media must be inline so avatars and chat previews render. CORP is
    // cross-origin because the Tauri desktop client loads these from a
    // different origin than the LAN server.
    const disposition = this._isInlineMedia(contentType) ? 'inline' : 'attachment';
    const baseHeaders = {
      'Content-Type': contentType,
      'Content-Disposition': this._contentDisposition(filename, disposition),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'private, no-store'
    };
    const range = req.headers.range;

    if (range) {
      const parts = String(range).replace(/bytes=/, '').split('-');
      const rawStart = parseInt(parts[0], 10);
      const rawEnd = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;

      const start = Math.max(0, Number.isNaN(rawStart) ? 0 : rawStart);
      const end = Math.min(stat.size - 1, Number.isNaN(rawEnd) ? stat.size - 1 : rawEnd);

      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }

      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1
      });
      fs.createReadStream(resolved, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        ...baseHeaders,
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes'
      });
      fs.createReadStream(resolved).pipe(res);
    }
  }

  serveUploadFile(req, res, pathname) {
    this._serveFromDir(req, res, pathname, this.uploadsDir);
  }

  serveVaultFile(req, res, pathname) {
    this._serveFromDir(req, res, pathname, this.vaultDir);
  }

  serveRootCa(res) {
    if (fs.existsSync(this.rootCaPath)) {
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="rootCA.pem"',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(this.rootCaPath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Root CA not found');
    }
  }

  serveStatic(pathname, res) {
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch (_) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    if (decoded.includes('\0')) {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }

    const publicRoot = path.resolve(this.publicDir);
    const relativePath = decoded.replace(/^\/+/, '');
    let filePath = path.resolve(publicRoot, relativePath || 'index.html');

    const inside = (candidate) => {
      const rel = path.relative(publicRoot, candidate);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };

    if (!inside(filePath)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(publicRoot, 'index.html');
    }

    if (!inside(filePath) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': this.getMimeType(filePath),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer'
    };

    if (ext === '.html') {
      headers['Content-Security-Policy'] = APP_CSP;
      headers['Cache-Control'] = 'no-store';
    } else {
      headers['Cache-Control'] = 'public, max-age=3600';
    }

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  }
}

module.exports = { FileService, APP_CSP };
