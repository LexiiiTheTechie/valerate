// Allowed URL schemes for media/file URLs served from the LAN server
const SAFE_URL_SCHEMES = ['http:', 'https:', 'blob:', 'data:'];
const DANGEROUS_CHARS_RE = /[\u0000-\u001F\u007F"'<>\\`]/;

let sessionToken = null;
let mediaBaseUrl = null;

/**
 * Returns true if the URL is safe to load (relative path or allowed scheme).
 * Blocks javascript:, vbscript:, protocol-relative URLs, and other dangerous
 * protocols.
 */
function isSafeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (DANGEROUS_CHARS_RE.test(url)) return false;
  if (url.startsWith('//')) return false; // protocol-relative -> external host
  if (url.startsWith('/') || url.startsWith('./')) return true; // relative — safe
  try {
    const parsed = new URL(url);
    return SAFE_URL_SCHEMES.includes(parsed.protocol);
  } catch {
    return false; // unparseable — reject
  }
}

/**
 * Resolves relative /uploads and /api/vault paths against the active server so
 * the Tauri webview (different origin) can load avatars and attachments.
 */
function resolveMediaUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (!mediaBaseUrl) return url;
  if (url.startsWith('/') && !url.startsWith('//')) {
    return `${mediaBaseUrl.replace(/\/$/, '')}${url}`;
  }
  return url;
}

/**
 * Appends the current session token to protected media URLs. Tokens are only
 * added to /uploads/ and /api/vault/ paths, never to third-party URLs.
 */
function withMediaToken(url) {
  if (!sessionToken || typeof url !== 'string') return url;
  try {
    const parsed = new URL(url, mediaBaseUrl || 'https://local.invalid');
    if (!/^\/(?:uploads|api\/vault)\/[A-Za-z0-9._-]+$/.test(parsed.pathname)) return url;
    if (parsed.searchParams.has('token')) return url;
    parsed.searchParams.set('token', sessionToken);
    if (url.startsWith('/') && !mediaBaseUrl) {
      return `${parsed.pathname}${parsed.search}`;
    }
    // Prefer an absolute URL when we know the server base (Tauri needs this).
    if (mediaBaseUrl) {
      const base = new URL(mediaBaseUrl);
      parsed.protocol = base.protocol;
      parsed.host = base.host;
      return parsed.toString();
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

export const ApiService = {
  /**
   * Stores the session token in memory for authenticated media requests.
   * Pass null on logout.
   */
  setSessionToken(token) {
    sessionToken = typeof token === 'string' && token ? token : null;
  },

  /**
   * Records the LAN server origin used to resolve relative media URLs inside
   * the desktop webview (which is not same-origin with the Node server).
   */
  setMediaBaseUrl(url) {
    if (typeof url === 'string' && url) {
      mediaBaseUrl = url.replace(/\/$/, '');
    } else {
      mediaBaseUrl = null;
    }
  },

  /**
   * Returns the URL unchanged (with the session token appended for protected
   * media) if it is safe, otherwise returns null. Use this before rendering
   * any server-supplied URL in <img>, <video>, <audio>, or <a href>.
   */
  sanitizeUrl(url) {
    if (!isSafeUrl(url)) return null;
    return withMediaToken(resolveMediaUrl(url));
  },

  /**
   * Fetches a media URL and triggers a real Save dialog via a same-origin
   * blob: link. Needed because the HTML download attribute is ignored for
   * cross-origin URLs (Tauri webview → LAN server), and WKWebView often
   * swallows attachment navigations without prompting.
   */
  async downloadFile(url, fileName = 'download') {
    const safe = this.sanitizeUrl(url);
    if (!safe) {
      return { error: 'Invalid download URL.' };
    }
    try {
      const res = await fetch(safe);
      if (!res.ok) {
        return { error: `Download failed (${res.status})` };
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = fileName || 'download';
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoke after the browser has had a chance to start the download.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 2_000);
      return { success: true };
    } catch (err) {
      return { error: `Download failed: ${err.message}` };
    }
  },

  async uploadFile(serverUrl, file, token = null, options = {}) {
    const endpoint = options.vault ? '/api/vault/upload' : '/api/upload';
    const base = String(serverUrl || '').replace(/\/$/, '');
    const headers = {
      'Content-Type': file.type || 'application/octet-stream'
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const res = await fetch(
        `${base}${endpoint}?filename=${encodeURIComponent(file.name)}`,
        { method: 'POST', headers, body: file }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { error: data.error || `Upload failed (${res.status})` };
      }
      return data;
    } catch (err) {
      return { error: `Upload failed: ${err.message}` };
    }
  },

  async uploadMultipleFiles(serverUrl, fileList, token = null, onProgress = null, options = {}) {
    const results = [];
    const base = String(serverUrl || '').replace(/\/$/, '');
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const relPath = file.webkitRelativePath || '';
      const folderPath = relPath.includes('/') ? '/' + relPath.substring(0, relPath.lastIndexOf('/')) : '/';
      const data = await this.uploadFile(base, file, token, options);
      if (data.url) {
        const ext = file.name.split('.').pop().toLowerCase();
        results.push({
          id: `file_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          fileName: file.name,
          folderPath,
          fileSize: file.size,
          fileUrl: `${base}${data.url}`,
          fileType: ext
        });
      }
      if (onProgress) onProgress(i + 1, fileList.length);
    }
    return results;
  },

  formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  },

  getFileIcon(ext) {
    const lower = (ext || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(lower)) return '🖼️';
    if (['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(lower)) return '🎬';
    if (['mp3', 'wav', 'ogg', 'flac'].includes(lower)) return '🎵';
    if (['pdf', 'doc', 'docx', 'txt', 'md'].includes(lower)) return '📄';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(lower)) return '📦';
    if (['js', 'jsx', 'ts', 'tsx', 'rs', 'py', 'json', 'html', 'css'].includes(lower)) return '💻';
    return '📁';
  }
};
