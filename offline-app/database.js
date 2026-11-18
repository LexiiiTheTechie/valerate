// ==============================================================================
// AIR-GAP OFFLINE DATABASE ENGINE (PERSISTENT SQLITE3)
// Features: Folder Paths, Multiple Batch Files, Personal Storage Vault
// ==============================================================================
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

class OfflineDatabase {
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(dbPath);

    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');

    this._initTables();
  }

  _initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        salt TEXT NOT NULL,
        hash TEXT NOT NULL,
        avatar_color TEXT NOT NULL,
        avatar_url TEXT DEFAULT NULL,
        bio TEXT DEFAULT 'Living on the offline LAN.',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS friends (
        user_a TEXT NOT NULL,
        user_b TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_a, user_b),
        FOREIGN KEY (user_a) REFERENCES users(username) ON DELETE CASCADE,
        FOREIGN KEY (user_b) REFERENCES users(username) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS friend_requests (
        from_user TEXT NOT NULL,
        to_user TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (from_user, to_user),
        FOREIGN KEY (from_user) REFERENCES users(username) ON DELETE CASCADE,
        FOREIGN KEY (to_user) REFERENCES users(username) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_by TEXT NOT NULL,
        is_private INTEGER NOT NULL DEFAULT 0,
        members_json TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        avatar_color TEXT NOT NULL,
        avatar_url TEXT DEFAULT NULL,
        text TEXT,
        media_url TEXT,
        media_type TEXT,
        file_name TEXT,
        file_size INTEGER,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS personal_files (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        file_name TEXT NOT NULL,
        folder_path TEXT DEFAULT '/',
        file_size INTEGER NOT NULL,
        file_url TEXT NOT NULL,
        file_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (owner) REFERENCES users(username) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_personal_files_owner ON personal_files(owner, folder_path, created_at);
    `);

    // Schema migrations for folder_path
    try {
      this.db.exec("ALTER TABLE personal_files ADD COLUMN folder_path TEXT DEFAULT '/';");
    } catch (_) {}

    const checkGeneral = this.db.prepare('SELECT id FROM channels WHERE id = ?').get('general');
    if (!checkGeneral) {
      this.db.prepare(`
        INSERT INTO channels (id, name, created_by, is_private, members_json, created_at)
        VALUES (?, ?, ?, 0, '[]', ?)
      `).run('general', 'General Lounge', 'system', Date.now());
    }
  }

  // --- Users ---
  getUser(username) {
    if (typeof username !== 'string' || !username) return null;
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase());
  }

  createUser(username, displayName, salt, hash, avatarColor) {
    this.db.prepare(`
      INSERT INTO users (username, display_name, salt, hash, avatar_color, avatar_url, bio, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, 'Hey there! I am using Valerate LAN Messenger.', ?)
    `).run(username.toLowerCase(), displayName, salt, hash, avatarColor, Date.now());
  }

  /**
   * Replaces a user's stored password hash. Used to upgrade legacy PBKDF2
   * records to the current scrypt format after a successful login.
   */
  updateUserPassword(username, salt, hash) {
    if (typeof username !== 'string' || typeof salt !== 'string' || typeof hash !== 'string') {
      return false;
    }
    const result = this.db.prepare(
      'UPDATE users SET salt = ?, hash = ? WHERE username = ?'
    ).run(salt, hash, username.toLowerCase());
    return result.changes > 0;
  }

  updateProfile(username, displayName, bio, avatarUrl) {
    this.db.prepare(`
      UPDATE users
      SET display_name = COALESCE(?, display_name),
          bio = COALESCE(?, bio),
          avatar_url = COALESCE(?, avatar_url)
      WHERE username = ?
    `).run(displayName, bio, avatarUrl, username.toLowerCase());
  }

  getUserCard(username) {
    const u = this.getUser(username);
    if (!u) return null;
    return {
      username: u.username,
      displayName: u.display_name,
      avatarColor: u.avatar_color,
      avatarUrl: u.avatar_url,
      bio: u.bio || 'No bio provided.',
      createdAt: u.created_at
    };
  }

  // --- Friends System ---
  getFriends(username) {
    const clean = username.toLowerCase();
    const rows = this.db.prepare(`
      SELECT u.username, u.display_name, u.avatar_color, u.avatar_url, u.bio
      FROM users u
      WHERE u.username IN (
        SELECT user_b FROM friends WHERE user_a = ?
        UNION
        SELECT user_a FROM friends WHERE user_b = ?
      )
    `).all(clean, clean);
    return rows;
  }

  getFriendRequests(username) {
    const rows = this.db.prepare(`
      SELECT fr.from_user, u.display_name, u.avatar_color, u.avatar_url
      FROM friend_requests fr
      LEFT JOIN users u ON u.username = fr.from_user
      WHERE fr.to_user = ?
    `).all(username.toLowerCase());
    return rows.map(r => ({
      username: r.from_user,
      displayName: r.display_name || r.from_user,
      avatarColor: r.avatar_color || '#38bdf8',
      avatarUrl: r.avatar_url
    }));
  }

  createFriendRequest(fromUser, toUser) {
    this.db.prepare(`
      INSERT OR IGNORE INTO friend_requests (from_user, to_user, created_at)
      VALUES (?, ?, ?)
    `).run(fromUser.toLowerCase(), toUser.toLowerCase(), Date.now());
  }

  acceptFriendRequest(fromUser, toUser) {
    const u1 = fromUser.toLowerCase();
    const u2 = toUser.toLowerCase();
    const [userA, userB] = [u1, u2].sort();

    this.db.prepare('DELETE FROM friend_requests WHERE from_user = ? AND to_user = ?').run(u1, u2);
    this.db.prepare('DELETE FROM friend_requests WHERE from_user = ? AND to_user = ?').run(u2, u1);

    this.db.prepare(`
      INSERT OR IGNORE INTO friends (user_a, user_b, created_at)
      VALUES (?, ?, ?)
    `).run(userA, userB, Date.now());
  }

  declineFriendRequest(fromUser, toUser) {
    const u1 = fromUser.toLowerCase();
    const u2 = toUser.toLowerCase();
    this.db.prepare('DELETE FROM friend_requests WHERE from_user = ? AND to_user = ?').run(u1, u2);
  }

  isFriend(userA, userB) {
    if (typeof userA !== 'string' || typeof userB !== 'string') return false;
    const [u1, u2] = [userA.toLowerCase(), userB.toLowerCase()].sort();
    const row = this.db.prepare('SELECT 1 FROM friends WHERE user_a = ? AND user_b = ?').get(u1, u2);
    return Boolean(row);
  }

  hasFriendRequest(fromUser, toUser) {
    if (typeof fromUser !== 'string' || typeof toUser !== 'string') return false;
    const row = this.db.prepare(
      'SELECT 1 FROM friend_requests WHERE from_user = ? AND to_user = ?'
    ).get(fromUser.toLowerCase(), toUser.toLowerCase());
    return Boolean(row);
  }

  // --- Channels ---
  getChannelsForUser(username) {
    const clean = username.toLowerCase();
    const allChannels = this.db.prepare('SELECT * FROM channels ORDER BY created_at ASC').all();
    return allChannels
      .map(ch => ({
        id: ch.id,
        name: ch.name,
        createdBy: ch.created_by,
        isPrivate: Boolean(ch.is_private),
        members: JSON.parse(ch.members_json || '[]')
      }))
      .filter(ch => !ch.isPrivate || ch.members.includes(clean));
  }

  getChannel(channelId) {
    const ch = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
    if (!ch) return null;
    return {
      id: ch.id,
      name: ch.name,
      createdBy: ch.created_by,
      isPrivate: Boolean(ch.is_private),
      members: JSON.parse(ch.members_json || '[]')
    };
  }

  createChannel(id, name, createdBy, isPrivate = false, members = []) {
    this.db.prepare(`
      INSERT OR IGNORE INTO channels (id, name, created_by, is_private, members_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, createdBy.toLowerCase(), isPrivate ? 1 : 0, JSON.stringify(members.map(m => m.toLowerCase())), Date.now());
  }

  // --- Messages ---
  addMessage(msg) {
    this.db.prepare(`
      INSERT INTO messages (id, channel_id, sender, sender_name, avatar_color, avatar_url, text, media_url, media_type, file_name, file_size, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      msg.id,
      msg.channelId,
      msg.sender.toLowerCase(),
      msg.senderName,
      msg.avatarColor,
      msg.avatarUrl || null,
      msg.text || '',
      msg.mediaUrl || null,
      msg.mediaType || null,
      msg.fileName || null,
      msg.fileSize || null,
      msg.timestamp
    );
  }

  getAllMessagesForUser(username) {
    const userChannels = this.getChannelsForUser(username).map(c => c.id);
    const messagesByChannel = {};

    for (const channelId of userChannels) {
      const rows = this.db.prepare(`
        SELECT id, channel_id as channelId, sender, sender_name as senderName,
               avatar_color as avatarColor, avatar_url as avatarUrl, text, media_url as mediaUrl,
               media_type as mediaType, file_name as fileName, file_size as fileSize, timestamp
        FROM messages
        WHERE channel_id = ?
        ORDER BY timestamp ASC
      `).all(channelId);
      messagesByChannel[channelId] = rows;
    }

    return messagesByChannel;
  }

  // --- Personal Cloud Files (Supports Folders & Batches) ---
  getPersonalFiles(username) {
    return this.db.prepare(`
      SELECT id, owner, file_name as fileName, folder_path as folderPath,
             file_size as fileSize, file_url as fileUrl, file_type as fileType, created_at as createdAt
      FROM personal_files
      WHERE owner = ?
      ORDER BY created_at DESC
    `).all(username.toLowerCase());
  }

  addPersonalFile(id, owner, fileName, folderPath, fileSize, fileUrl, fileType) {
    this.db.prepare(`
      INSERT INTO personal_files (id, owner, file_name, folder_path, file_size, file_url, file_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, owner.toLowerCase(), fileName, folderPath || '/', fileSize, fileUrl, fileType, Date.now());
  }

  /**
   * True when `filename` is referenced by a personal_files row owned by
   * `owner`. Used to authorise /api/vault/<filename> downloads.
   */
  isVaultFileOwnedBy(owner, filename) {
    if (typeof owner !== 'string' || typeof filename !== 'string') return false;
    if (!/^[A-Za-z0-9._-]+$/.test(filename)) return false;
    const rows = this.db.prepare(
      'SELECT file_url FROM personal_files WHERE owner = ?'
    ).all(owner.toLowerCase());
    return rows.some((row) => {
      if (typeof row.file_url !== 'string') return false;
      const clean = row.file_url.split('?')[0].split('#')[0];
      return clean.split('/').filter(Boolean).pop() === filename;
    });
  }

  deletePersonalFile(id, owner) {
    this.db.prepare('DELETE FROM personal_files WHERE id = ? AND owner = ?').run(id, owner.toLowerCase());
  }
}

module.exports = { OfflineDatabase };
