const fs = require('node:fs');
const path = require('node:path');

const SENSITIVE_KEY_RE = /(pass(word)?|token|secret|authorization|cookie)/i;

function sanitize(value, depth = 0) {
  if (depth > 3) return '[truncated]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 300 ? value.slice(0, 300) + '…' : value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? '[redacted]' : sanitize(val, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Append-only JSON-lines audit log for security-relevant events. Never throws
 * into request/WS handlers: a logging failure must not take the app down.
 */
class AuditLog {
  constructor(filePath) {
    this.filePath = filePath;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (_) { /* best effort */ }
  }

  write(event, details = {}) {
    const entry = {
      ts: new Date().toISOString(),
      event,
      ...sanitize(details)
    };
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch (err) {
      console.error('[audit] failed to write log entry:', err.message);
    }
  }
}

module.exports = { AuditLog };
