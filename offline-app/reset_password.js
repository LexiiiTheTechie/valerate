// Resets the password of an existing Valerate account directly in the SQLite
// database. Run this only while the server is stopped.
//
//   node reset_password.js <username> <new-password>
//
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { AuthService } = require('./src/services/AuthService');
const config = require('./src/config/env');

(async () => {
  const username = String(process.argv[2] || '').trim().toLowerCase();
  const password = String(process.argv[3] || '');

  if (!username || !password) {
    console.log('Usage: node reset_password.js <username> <new-password>');
    process.exit(1);
  }

  const validation = AuthService.validateCredentials(username, password, { isRegister: true });
  if (!validation.valid) {
    console.error('[-] ' + validation.error);
    process.exit(1);
  }

  if (!require('node:fs').existsSync(config.DB_PATH)) {
    console.error('[-] Database not found at ' + config.DB_PATH);
    process.exit(1);
  }

  let db;
  try {
    db = new DatabaseSync(config.DB_PATH);
    const user = db.prepare('SELECT username FROM users WHERE username = ?').get(validation.cleanUser);
    if (!user) {
      console.error(`[-] No account named "${validation.cleanUser}" in this database.`);
      console.error('    Existing accounts: ' +
        db.prepare('SELECT username FROM users ORDER BY username').all().map((r) => r.username).join(', '));
      process.exit(1);
    }

    const { salt, hash } = await AuthService.hashPassword(password);
    db.prepare('UPDATE users SET salt = ?, hash = ? WHERE username = ?')
      .run(salt, hash, validation.cleanUser);
    console.log(`[+] Password updated for "${validation.cleanUser}". You can sign in now.`);
  } catch (err) {
    console.error('[-] Could not reset password:', err.message);
    process.exit(1);
  } finally {
    try { db?.close(); } catch (_) { /* ignore */ }
  }
})();
