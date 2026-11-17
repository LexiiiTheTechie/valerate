const DEFAULT_IDLE_TTL_MS = 12 * 60 * 60 * 1000;      // 12 hours idle
const DEFAULT_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days absolute
const MAX_SESSIONS_PER_USER = 20;

class SessionManager {
  constructor(options = {}) {
    this.sessions = new Map(); // token -> { username, createdAt, lastUsed }
    this.activeConnections = new Map(); // username -> Set of sockets
    this.idleTtlMs = options.idleTtlMs || DEFAULT_IDLE_TTL_MS;
    this.absoluteTtlMs = options.absoluteTtlMs || DEFAULT_ABSOLUTE_TTL_MS;
  }

  createSession(token, username) {
    const clean = username.toLowerCase();
    const now = Date.now();
    this.sessions.set(token, { username: clean, createdAt: now, lastUsed: now });
    this._enforceSessionCap(clean);
  }

  _enforceSessionCap(username) {
    const owned = [];
    for (const [token, session] of this.sessions.entries()) {
      if (session.username === username) owned.push([token, session]);
    }
    if (owned.length <= MAX_SESSIONS_PER_USER) return;
    owned.sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [token] of owned.slice(0, owned.length - MAX_SESSIONS_PER_USER)) {
      this.sessions.delete(token);
    }
  }

  _isExpired(session, now) {
    return (
      now - session.lastUsed > this.idleTtlMs ||
      now - session.createdAt > this.absoluteTtlMs
    );
  }

  getSession(token) {
    if (typeof token !== 'string' || !token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    const now = Date.now();
    if (this._isExpired(session, now)) {
      this.sessions.delete(token);
      return null;
    }
    session.lastUsed = now;
    return session;
  }

  /**
   * Returns the username associated with a token, or null if the token is
   * unknown or expired.
   */
  getUserByToken(token) {
    const session = this.getSession(token);
    return session ? session.username : null;
  }

  /**
   * Invalidates a session token.
   */
  revokeToken(token) {
    return this.sessions.delete(token);
  }

  /**
   * Invalidates every session for a user (e.g. password change or logout-all).
   */
  revokeUserSessions(username) {
    const clean = username.toLowerCase();
    for (const [token, session] of this.sessions.entries()) {
      if (session.username === clean) this.sessions.delete(token);
    }
  }

  addConnection(username, ws) {
    const clean = username.toLowerCase();
    if (!this.activeConnections.has(clean)) {
      this.activeConnections.set(clean, new Set());
    }
    this.activeConnections.get(clean).add(ws);
  }

  removeConnection(username, ws) {
    const clean = username.toLowerCase();
    if (this.activeConnections.has(clean)) {
      const sockets = this.activeConnections.get(clean);
      sockets.delete(ws);
      if (sockets.size === 0) {
        this.activeConnections.delete(clean);
        return true; // Last connection removed
      }
    }
    return false;
  }

  sendToUser(username, payload) {
    const clean = username.toLowerCase();
    const sockets = this.activeConnections.get(clean);
    if (sockets) {
      const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
      for (const s of sockets) {
        if (s.readyState === 1) s.send(data);
      }
    }
  }

  getOnlineUsers() {
    return Array.from(this.activeConnections.keys());
  }

  isOnline(username) {
    return this.activeConnections.has(username.toLowerCase());
  }
}

module.exports = { SessionManager };
