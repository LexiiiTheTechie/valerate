const { AuthService, USERNAME_RE } = require('../services/AuthService');

// Rate-limit: max messages allowed per window per connection
const RATE_LIMIT_MAX = 60;        // max messages
const RATE_LIMIT_WINDOW_MS = 10000; // per 10-second window

// Authentication brute-force protection per connection
const AUTH_MAX_ATTEMPTS = 10;
const AUTH_WINDOW_MS = 5 * 60 * 1000;

// Cross-connection protection: an attacker can open many sockets, so limits are
// also enforced per source IP and per (IP, username) pair.
const IP_AUTH_MAX_ATTEMPTS = 30;
const IP_AUTH_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_FAILURE_MAX = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const IP_REGISTER_MAX = 10;
const IP_REGISTER_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAP_MAX_ENTRIES = 10000;

// Friend-request / channel-creation spam limits
const SOCIAL_MAX_ACTIONS = 20;
const SOCIAL_WINDOW_MS = 10 * 60 * 1000;

const MAX_TEXT_LEN = 10000;
const MAX_MEDIA_URL_LEN = 2048;
const MAX_FILE_NAME_LEN = 255;
const MAX_FOLDER_LEN = 512;
const MAX_DISPLAY_NAME_LEN = 64;
const MAX_BIO_LEN = 500;
const MAX_CHANNEL_NAME_LEN = 64;

const CHANNEL_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const SAFE_FILE_NAME_RE = /^[A-Za-z0-9._-]{1,255}$/;
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value, maxLen) {
  if (typeof value !== 'string') return null;
  if (value.length > maxLen) return null;
  return value;
}

function sanitizeDisplayName(value) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return clean ? clean.slice(0, MAX_DISPLAY_NAME_LEN) : null;
}

function sanitizeBio(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, MAX_BIO_LEN);
}

function sanitizeFolderPath(value) {
  if (typeof value !== 'string' || value.length > MAX_FOLDER_LEN) return '/';
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((p) => p === '.' || p === '..' || p.includes('\0'))) return '/';
  return '/' + parts.join('/');
}

/**
 * Accepts a relative /api/vault/<file> or /uploads/<file> URL, optionally
 * prefixed with the LAN server origin. Returns the original string or null.
 */
/**
 * True when a hostname is loopback or a private LAN address. Stored media URLs
 * may legitimately be prefixed with a different local IP than the one this
 * process auto-detected (multi-homed hosts, DHCP changes, phones using mDNS).
 */
function isPrivateHostname(hostname, lanIp) {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  if (host === String(lanIp).toLowerCase()) return true;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  return (
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host)
  );
}

function sanitizeStoredFileUrl(value, lanIp) {
  if (typeof value !== 'string' || !value || value.length > MAX_MEDIA_URL_LEN) return null;
  if (/[\s"'<>\\`]/.test(value)) return null;
  try {
    const base = `https://${lanIp}`;
    const parsed = new URL(value, base);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (!/^\/(?:api\/vault|uploads)\/[A-Za-z0-9._-]+$/.test(parsed.pathname)) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
      if (!isPrivateHostname(parsed.hostname, lanIp)) {
        return null;
      }
    }
    return value;
  } catch (_) {
    return null;
  }
}

function sanitizeMediaUrl(value, lanIp) {
  const stored = sanitizeStoredFileUrl(value, lanIp);
  if (!stored) return null;
  try {
    const parsed = new URL(stored, `https://${lanIp}`);
    return /^\/uploads\/[A-Za-z0-9._-]+$/.test(parsed.pathname) ? stored : null;
  } catch (_) {
    return null;
  }
}

class WebSocketDispatcher {
  constructor(db, sessionManager, wss, avatarColors, options = {}) {
    this.db = db;
    this.sessions = sessionManager;
    this.wss = wss;
    this.avatarColors = avatarColors;
    this.lanIp = options.lanIp || '127.0.0.1';
    this.audit = options.audit || null;

    // Cross-connection auth state. Kept in memory and pruned opportunistically.
    this.ipAuthAttempts = new Map();   // ip -> { count, windowStart }
    this.ipRegistrations = new Map();  // ip -> { count, windowStart }
    this.loginFailures = new Map();    // `${ip}|${username}` -> { count, firstAt, lockedUntil }
  }

  broadcastPresence() {
    if (this.wss) {
      this.wss.broadcast({
        type: 'presence_update',
        onlineUsers: this.sessions.getOnlineUsers()
      });
    }
  }

  _send(ws, payload) {
    try {
      if (ws && ws.readyState === 1) ws.send(payload);
    } catch (err) {
      console.error('[WS] send failed:', err.message);
    }
  }

  _alert(ws, level, message) {
    this._send(ws, { type: 'system_alert', level, message });
  }

  _remote(ws) {
    return ws?.req?.socket?.remoteAddress || 'unknown';
  }

  _checkWindow(ws, key, max, windowMs) {
    const now = Date.now();
    if (!ws[key] || now - ws[key].windowStart > windowMs) {
      ws[key] = { count: 0, windowStart: now };
    }
    ws[key].count++;
    return ws[key].count <= max;
  }

  _pruneRateMap(map, maxAgeMs) {
    const now = Date.now();
    for (const [key, entry] of map.entries()) {
      const started = entry.windowStart || entry.firstAt || 0;
      const until = entry.lockedUntil || 0;
      if (until && until > now) continue;
      if (now - started > maxAgeMs) map.delete(key);
    }
    while (map.size > RATE_MAP_MAX_ENTRIES) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
  }

  _checkIpWindow(map, ip, max, windowMs) {
    const now = Date.now();
    const entry = map.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      map.set(ip, { count: 1, windowStart: now });
      this._pruneRateMap(map, Math.max(windowMs, 60 * 60 * 1000));
      return true;
    }
    entry.count++;
    return entry.count <= max;
  }

  _loginKey(ws, username) {
    return `${this._remote(ws)}|${username}`;
  }

  _isLoginLocked(ws, username) {
    const key = this._loginKey(ws, username);
    const entry = this.loginFailures.get(key);
    if (!entry) return false;
    if (entry.lockedUntil && entry.lockedUntil > Date.now()) return true;
    if (entry.lockedUntil) this.loginFailures.delete(key);
    return false;
  }

  _recordLoginFailure(ws, username) {
    const key = this._loginKey(ws, username);
    const now = Date.now();
    let entry = this.loginFailures.get(key);
    if (!entry || now - entry.firstAt > LOGIN_FAILURE_WINDOW_MS) {
      entry = { count: 0, firstAt: now, lockedUntil: 0 };
    }
    entry.count++;
    if (entry.count >= LOGIN_FAILURE_MAX) {
      entry.lockedUntil = now + LOGIN_LOCKOUT_MS;
      this.audit?.('auth_lockout', {
        username,
        remote: this._remote(ws),
        failures: entry.count
      });
    }
    this.loginFailures.set(key, entry);
    this._pruneRateMap(
      this.loginFailures,
      Math.max(LOGIN_FAILURE_WINDOW_MS, LOGIN_LOCKOUT_MS) * 2
    );
  }

  _clearLoginFailures(ws, username) {
    this.loginFailures.delete(this._loginKey(ws, username));
  }

  async handleMessage(ws, msg) {
    try {
      if (!isPlainObject(msg) || typeof msg.type !== 'string') {
        this._alert(ws, 'error', 'Malformed message.');
        return;
      }

      // ── Per-connection rate limiting ────────────────────────────────────────
      if (!this._checkWindow(ws, '_rl', RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
        this._alert(ws, 'error', 'Rate limit exceeded. Slow down.');
        return;
      }
      // ───────────────────────────────────────────────────────────────────────

      switch (msg.type) {
        case 'auth':
          await this.handleAuth(ws, msg);
          break;
        case 'logout':
          this.handleLogout(ws, msg);
          break;
        case 'update_profile':
          this.handleUpdateProfile(ws, msg);
          break;
        case 'get_user_card':
          this.handleGetUserCard(ws, msg);
          break;
        case 'friend_request_send':
          this.handleFriendRequestSend(ws, msg);
          break;
        case 'friend_request_accept':
          this.handleFriendRequestAccept(ws, msg);
          break;
        case 'friend_request_decline':
          this.handleFriendRequestDecline(ws, msg);
          break;
        case 'create_channel':
          this.handleCreateChannel(ws, msg);
          break;
        case 'chat_message':
          this.handleChatMessage(ws, msg);
          break;
        case 'typing':
          this.handleTyping(ws, msg);
          break;
        case 'personal_file_add':
          this.handlePersonalFileAdd(ws, msg);
          break;
        case 'personal_file_add_batch':
          this.handlePersonalFileAddBatch(ws, msg);
          break;
        case 'personal_file_delete':
          this.handlePersonalFileDelete(ws, msg);
          break;
        case 'webrtc_call_invite':
        case 'webrtc_call_answer':
        case 'webrtc_ice_candidate':
        case 'webrtc_call_hangup':
          this.handleWebRtcSignaling(ws, msg);
          break;
        default:
          console.warn('[WS] Unknown message type:', msg.type);
      }
    } catch (err) {
      // A malformed message must never take down the process.
      console.error('[WS] handler error:', err.message);
      this._alert(ws, 'error', 'Request could not be processed.');
    }
  }

  async handleAuth(ws, msg) {
    const remote = this._remote(ws);

    if (!this._checkWindow(ws, '_authRl', AUTH_MAX_ATTEMPTS, AUTH_WINDOW_MS)) {
      this.audit?.('auth_rate_limited', { remote });
      this._send(ws, { type: 'auth_response', success: false, error: 'Too many attempts. Try again later.' });
      return;
    }

    // Per-IP cap stops an attacker from bypassing the per-socket limit by
    // opening many WebSocket connections.
    if (!this._checkIpWindow(this.ipAuthAttempts, remote, IP_AUTH_MAX_ATTEMPTS, IP_AUTH_WINDOW_MS)) {
      this.audit?.('auth_ip_rate_limited', { remote });
      this._send(ws, { type: 'auth_response', success: false, error: 'Too many attempts from this device. Try again later.' });
      return;
    }

    const isRegister = msg.isRegister === true;
    const validation = AuthService.validateCredentials(msg.username, msg.password, { isRegister });

    if (!validation.valid) {
      this._send(ws, { type: 'auth_response', success: false, error: validation.error });
      return;
    }

    const cleanUser = validation.cleanUser;
    let userRecord = this.db.getUser(cleanUser);

    if (isRegister) {
      if (!this._checkIpWindow(this.ipRegistrations, remote, IP_REGISTER_MAX, IP_REGISTER_WINDOW_MS)) {
        this.audit?.('register_rate_limited', { remote });
        this._send(ws, { type: 'auth_response', success: false, error: 'Too many accounts created from this device. Try again later.' });
        return;
      }

      if (userRecord) {
        this._send(ws, { type: 'auth_response', success: false, error: 'Username is already taken.' });
        return;
      }

      const { salt, hash } = await AuthService.hashPassword(msg.password);
      const color = this.avatarColors[Math.floor(Math.random() * this.avatarColors.length)];
      const displayName = sanitizeDisplayName(msg.username) || cleanUser;
      this.db.createUser(cleanUser, displayName, salt, hash, color);
      userRecord = this.db.getUser(cleanUser);
      this.audit?.('register_success', { username: cleanUser, remote });
    } else {
      if (this._isLoginLocked(ws, cleanUser)) {
        this.audit?.('auth_locked', { username: cleanUser, remote });
        this._send(ws, { type: 'auth_response', success: false, error: 'Too many failed attempts. Try again later.' });
        return;
      }

      if (!userRecord) {
        // Perform a dummy derivation at the same cost as a real scrypt verify
        // to reduce username-enumeration timing differences.
        await AuthService.hashPassword('invalid-password', '00000000000000000000000000000000');
        this._recordLoginFailure(ws, cleanUser);
        this.audit?.('auth_failed', { username: cleanUser, remote, reason: 'unknown_user' });
        this._send(ws, { type: 'auth_response', success: false, error: 'Invalid username or password.' });
        return;
      }

      const passwordOk = await AuthService.verifyPassword(
        msg.password,
        userRecord.salt,
        userRecord.hash
      );

      if (!passwordOk) {
        this._recordLoginFailure(ws, cleanUser);
        this.audit?.('auth_failed', { username: cleanUser, remote, reason: 'bad_password' });
        this._send(ws, { type: 'auth_response', success: false, error: 'Invalid username or password.' });
        return;
      }

      this._clearLoginFailures(ws, cleanUser);

      // Transparently upgrade legacy PBKDF2 records (and any future weaker
      // scrypt cost) now that the plaintext password is available.
      if (AuthService.needsRehash(userRecord.hash)) {
        const previousHash = userRecord.hash;
        try {
          const upgraded = await AuthService.hashPassword(msg.password);
          this.db.updateUserPassword(cleanUser, upgraded.salt, upgraded.hash);
          userRecord.salt = upgraded.salt;
          userRecord.hash = upgraded.hash;
          this.audit?.('password_rehash', {
            username: cleanUser,
            from: AuthService.isLegacyHash(previousHash) ? 'pbkdf2' : 'scrypt'
          });
        } catch (err) {
          // A failed upgrade must not block a valid login.
          console.error('[auth] password rehash failed:', err.message);
        }
      }

      this.audit?.('auth_success', { username: cleanUser, remote });
    }

    // Re-authenticating on the same socket must not leave the old session or
    // presence entry dangling.
    if (ws.token) this.sessions.revokeToken(ws.token);
    if (ws.username) this.sessions.removeConnection(ws.username, ws);

    ws.username = cleanUser;
    this.sessions.addConnection(cleanUser, ws);

    const token = AuthService.generateSessionToken();
    ws.token = token;
    this.sessions.createSession(token, cleanUser);

    const userChannels = this.db.getChannelsForUser(cleanUser);
    const rawFriends = this.db.getFriends(cleanUser);
    const friendsList = rawFriends.map(f => ({
      username: f.username,
      displayName: f.display_name,
      avatarColor: f.avatar_color,
      avatarUrl: f.avatar_url,
      bio: f.bio,
      isOnline: this.sessions.isOnline(f.username)
    }));
    const personalFiles = this.db.getPersonalFiles(cleanUser);

    this._send(ws, {
      type: 'auth_response',
      success: true,
      token,
      user: {
        username: cleanUser,
        displayName: userRecord.display_name,
        avatarColor: userRecord.avatar_color,
        avatarUrl: userRecord.avatar_url,
        bio: userRecord.bio
      },
      channels: userChannels,
      friends: friendsList,
      friendRequests: this.db.getFriendRequests(cleanUser),
      personalFiles,
      onlineUsers: this.sessions.getOnlineUsers(),
      messages: this.db.getAllMessagesForUser(cleanUser)
    });

    this.broadcastPresence();
  }

  handleLogout(ws) {
    if (ws.token) this.sessions.revokeToken(ws.token);
    const username = ws.username;
    if (username) {
      this.sessions.removeConnection(username, ws);
      this.audit?.('logout', { username, remote: this._remote(ws) });
    }
    ws.username = null;
    ws.token = null;
    this._send(ws, { type: 'auth_logged_out' });
    this.broadcastPresence();
  }

  handleUpdateProfile(ws, msg) {
    if (!ws.username) return;

    const displayName = sanitizeDisplayName(msg.displayName);
    const bio = sanitizeBio(msg.bio);

    // Only allow relative /uploads/ URLs or absolute URLs on this LAN server.
    let avatarUrl = msg.avatarUrl || null;
    if (avatarUrl) {
      avatarUrl = sanitizeMediaUrl(avatarUrl, this.lanIp);
    }

    this.db.updateProfile(ws.username, displayName, bio, avatarUrl);

    const updated = this.db.getUserCard(ws.username);
    this._send(ws, { type: 'profile_updated', user: updated });

    if (this.wss) {
      this.wss.broadcast({
        type: 'user_card_updated',
        user: {
          ...updated,
          isOnline: this.sessions.isOnline(ws.username)
        }
      });
    }
  }

  handleGetUserCard(ws, msg) {
    if (!ws.username) return;
    const target = asString(msg.username, 32);
    if (!target || !USERNAME_RE.test(target.toLowerCase())) return;
    const card = this.db.getUserCard(target.toLowerCase());
    if (card) {
      this._send(ws, {
        type: 'user_card_data',
        card: {
          ...card,
          isOnline: this.sessions.isOnline(target),
          isFriend: this.db.isFriend(ws.username, target)
        }
      });
    }
  }

  _addPersonalFile(ws, file) {
    if (!isPlainObject(file)) return false;
    const fileName = asString(file.fileName, MAX_FILE_NAME_LEN);
    if (!fileName || !SAFE_FILE_NAME_RE.test(fileName)) return false;

    const fileUrl = sanitizeStoredFileUrl(file.fileUrl, this.lanIp);
    if (!fileUrl) return false;

    const fileSize = Number.isFinite(file.fileSize) && file.fileSize >= 0
      ? Math.floor(file.fileSize)
      : 0;
    const folderPath = sanitizeFolderPath(file.folderPath);
    const fileType = asString(file.fileType, 32) || 'file';
    const requestedId = asString(file.id, 128);
    const fileId = requestedId && /^[A-Za-z0-9_.-]+$/.test(requestedId)
      ? requestedId
      : `file_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    this.db.addPersonalFile(fileId, ws.username, fileName, folderPath, fileSize, fileUrl, fileType);
    return true;
  }

  handlePersonalFileAdd(ws, msg) {
    if (!ws.username) return;
    if (!this._addPersonalFile(ws, msg)) {
      this._alert(ws, 'error', 'Invalid vault file metadata.');
      return;
    }

    this._send(ws, {
      type: 'personal_files_updated',
      files: this.db.getPersonalFiles(ws.username)
    });
  }

  handlePersonalFileAddBatch(ws, msg) {
    if (!ws.username || !Array.isArray(msg.files)) return;
    const accepted = [];
    for (const file of msg.files.slice(0, 1000)) {
      if (this._addPersonalFile(ws, file)) accepted.push(file);
    }

    this._send(ws, {
      type: 'personal_files_updated',
      files: this.db.getPersonalFiles(ws.username)
    });
    if (accepted.length !== msg.files.length) {
      this._alert(ws, 'error', 'Some vault files were rejected because their metadata was invalid.');
    }
  }

  handlePersonalFileDelete(ws, msg) {
    if (!ws.username) return;
    const fileId = asString(msg.fileId, 128);
    if (!fileId) return;
    this.db.deletePersonalFile(fileId, ws.username);

    this._send(ws, {
      type: 'personal_files_updated',
      files: this.db.getPersonalFiles(ws.username)
    });
  }

  handleFriendRequestSend(ws, msg) {
    if (!ws.username) return;
    if (!this._checkWindow(ws, '_socialRl', SOCIAL_MAX_ACTIONS, SOCIAL_WINDOW_MS)) {
      this._alert(ws, 'error', 'Too many social actions. Slow down.');
      return;
    }

    const target = asString(msg.targetUser, 32);
    if (!target || !USERNAME_RE.test(target.trim().toLowerCase())) {
      this._alert(ws, 'error', 'Invalid username.');
      return;
    }
    const cleanTarget = target.trim().toLowerCase();
    if (cleanTarget === ws.username) return;

    const targetUser = this.db.getUser(cleanTarget);
    if (!targetUser) {
      this._alert(ws, 'error', `User @${cleanTarget} does not exist on this LAN.`);
      return;
    }

    if (this.db.isFriend(ws.username, cleanTarget)) {
      this._alert(ws, 'info', `@${cleanTarget} is already your friend.`);
      return;
    }

    this.db.createFriendRequest(ws.username, cleanTarget);
    const sender = this.db.getUser(ws.username);

    this.sessions.sendToUser(cleanTarget, {
      type: 'friend_request_received',
      fromUser: ws.username,
      displayName: sender.display_name,
      avatarColor: sender.avatar_color,
      avatarUrl: sender.avatar_url
    });

    this._alert(ws, 'success', `Friend request sent to @${cleanTarget}.`);
  }

  handleFriendRequestAccept(ws, msg) {
    if (!ws.username) return;
    const fromUser = asString(msg.fromUser, 32);
    if (!fromUser) return;
    const cleanFrom = fromUser.trim().toLowerCase();

    // Require an actual pending request. Without this check any user could
    // force themselves onto another user's friend list.
    if (!this.db.hasFriendRequest(cleanFrom, ws.username)) {
      this._alert(ws, 'error', 'No pending friend request from that user.');
      return;
    }

    const requester = this.db.getUser(cleanFrom);
    const current = this.db.getUser(ws.username);
    if (!requester || !current) return;

    this.db.acceptFriendRequest(cleanFrom, ws.username);
    this.audit?.('friend_accept', { user: ws.username, from: cleanFrom });

    this._send(ws, {
      type: 'friend_requests_updated',
      friendRequests: this.db.getFriendRequests(ws.username)
    });

    this._send(ws, {
      type: 'friend_added',
      friend: {
        username: cleanFrom,
        displayName: requester.display_name,
        avatarColor: requester.avatar_color,
        avatarUrl: requester.avatar_url,
        bio: requester.bio,
        isOnline: this.sessions.isOnline(cleanFrom)
      }
    });

    this.sessions.sendToUser(cleanFrom, {
      type: 'friend_added',
      friend: {
        username: ws.username,
        displayName: current.display_name,
        avatarColor: current.avatar_color,
        avatarUrl: current.avatar_url,
        bio: current.bio,
        isOnline: true
      }
    });
  }

  handleFriendRequestDecline(ws, msg) {
    if (!ws.username) return;
    const fromUser = asString(msg.fromUser, 32);
    if (!fromUser) return;
    this.db.declineFriendRequest(fromUser.trim().toLowerCase(), ws.username);

    this._send(ws, {
      type: 'friend_requests_updated',
      friendRequests: this.db.getFriendRequests(ws.username)
    });
  }

  handleCreateChannel(ws, msg) {
    if (!ws.username) return;
    if (!this._checkWindow(ws, '_socialRl', SOCIAL_MAX_ACTIONS, SOCIAL_WINDOW_MS)) {
      this._alert(ws, 'error', 'Too many social actions. Slow down.');
      return;
    }

    const isPrivate = msg.isPrivate === true;
    const channelName = sanitizeDisplayName(msg.channelName) || null;

    let channelId;
    let finalMembers = [];
    let title;

    if (isPrivate) {
      const target = asString(msg.targetUser, 32);
      if (!target || !USERNAME_RE.test(target.trim().toLowerCase())) {
        this._alert(ws, 'error', 'Invalid DM recipient.');
        return;
      }
      const cleanTarget = target.trim().toLowerCase();
      if (cleanTarget === ws.username) return;
      if (!this.db.getUser(cleanTarget)) {
        this._alert(ws, 'error', 'That user does not exist on this LAN.');
        return;
      }

      const sorted = [ws.username, cleanTarget].sort();
      channelId = `dm_${sorted.join('_')}`;
      finalMembers = sorted;
      title = channelName || `@${cleanTarget}`;
    } else {
      channelId = `ch_${Date.now()}`;
      finalMembers = [ws.username];
      title = channelName ? channelName.slice(0, MAX_CHANNEL_NAME_LEN) : 'New Channel';
    }

    let channel = this.db.getChannel(channelId);
    if (!channel) {
      this.db.createChannel(channelId, title, ws.username, isPrivate, finalMembers);
      channel = this.db.getChannel(channelId);
    }

    const payload = { type: 'channel_created', channel };
    if (isPrivate) {
      finalMembers.forEach(m => this.sessions.sendToUser(m, payload));
    } else if (this.wss) {
      this.wss.broadcast(payload);
    }
  }

  handleChatMessage(ws, msg) {
    if (!ws.username) return;

    const channelId = asString(msg.channelId, 128);
    if (!channelId || !CHANNEL_ID_RE.test(channelId)) return;

    const text = typeof msg.text === 'string' ? msg.text.slice(0, MAX_TEXT_LEN) : '';
    const mediaUrl = msg.mediaUrl ? sanitizeMediaUrl(msg.mediaUrl, this.lanIp) : null;
    if (msg.mediaUrl && !mediaUrl) {
      this._alert(ws, 'error', 'Invalid media URL.');
      return;
    }
    if (!text.trim() && !mediaUrl) return;

    let channel = this.db.getChannel(channelId);

    // Access control: private channels require membership.
    if (channel) {
      if (channel.isPrivate && !channel.members.includes(ws.username)) {
        this.audit?.('chat_denied', { username: ws.username, channelId, reason: 'not_member' });
        this._alert(ws, 'error', 'You are not a member of that channel.');
        return;
      }
    } else {
      // Only allow implicit creation of a DM the sender actually participates
      // in. Never auto-create arbitrary channels from a message.
      if (!channelId.startsWith('dm_')) {
        this._alert(ws, 'error', 'Unknown channel.');
        return;
      }
      const parts = channelId.slice(3).split('_');
      if (parts.length !== 2) {
        this._alert(ws, 'error', 'Invalid DM channel.');
        return;
      }
      const participants = parts.map(p => p.toLowerCase());
      if (!participants.includes(ws.username)) {
        this._alert(ws, 'error', 'Invalid DM channel.');
        return;
      }
      const otherUser = participants.find(u => u !== ws.username);
      if (!otherUser || !this.db.getUser(otherUser)) {
        this._alert(ws, 'error', 'Unknown DM recipient.');
        return;
      }
      const sorted = [...participants].sort();
      const otherProfile = this.db.getUser(otherUser);
      const dmTitle = otherProfile ? `@${otherProfile.display_name}` : `@${otherUser}`;
      this.db.createChannel(channelId, dmTitle, 'system', true, sorted);
      channel = this.db.getChannel(channelId);
    }

    const senderProfile = this.db.getUser(ws.username) || {};
    const mediaType = MEDIA_TYPES.has(msg.mediaType) ? msg.mediaType : (mediaUrl ? 'file' : null);
    const rawFileName = asString(msg.fileName, MAX_FILE_NAME_LEN);
    const fileName = rawFileName ? rawFileName.replace(/[^\w.\- ()]/g, '_') : null;
    const fileSize = Number.isFinite(msg.fileSize) && msg.fileSize >= 0
      ? Math.floor(msg.fileSize)
      : null;

    const messageObj = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      channelId,
      sender: ws.username,
      senderName: senderProfile.display_name || ws.username,
      avatarColor: senderProfile.avatar_color || '#38bdf8',
      avatarUrl: senderProfile.avatar_url || null,
      text: text.trim(),
      mediaUrl: mediaUrl || null,
      mediaType,
      fileName,
      fileSize,
      timestamp: Date.now()
    };

    try {
      this.db.addMessage(messageObj);
    } catch (err) {
      console.error('[-] Error inserting message to DB:', err.message);
      this._alert(ws, 'error', 'Message could not be stored.');
      return;
    }

    if (channel && channel.isPrivate) {
      channel.members.forEach(m => this.sessions.sendToUser(m, { type: 'new_message', message: messageObj }));
    } else if (this.wss) {
      this.wss.broadcast({ type: 'new_message', message: messageObj });
    }
  }

  handleTyping(ws, msg) {
    if (!ws.username || !this.wss) return;
    const channelId = asString(msg.channelId, 128);
    if (!channelId || !CHANNEL_ID_RE.test(channelId)) return;
    const isTyping = msg.isTyping === true;
    this.wss.broadcast(
      { type: 'user_typing', channelId, username: ws.username, isTyping },
      (client) => client.username !== ws.username
    );
  }

  handleWebRtcSignaling(ws, msg) {
    if (!ws.username) return;
    const target = asString(msg.targetUser, 32);
    if (!target || !USERNAME_RE.test(target.trim().toLowerCase())) return;
    const cleanTarget = target.trim().toLowerCase();
    if (cleanTarget === ws.username) return;
    if (!this.db.getUser(cleanTarget)) return;
    this.sessions.sendToUser(cleanTarget, { ...msg, targetUser: cleanTarget, fromUser: ws.username });
  }

  handleDisconnect(ws) {
    if (ws.token) {
      this.sessions.revokeToken(ws.token);
      ws.token = null;
    }
    if (ws.username) {
      const isCompletelyOffline = this.sessions.removeConnection(ws.username, ws);
      if (isCompletelyOffline) {
        this.broadcastPresence();
      }
    }
  }
}

module.exports = { WebSocketDispatcher };
