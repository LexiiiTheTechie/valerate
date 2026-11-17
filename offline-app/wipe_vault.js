/**
 * Standalone Node script to wipe Personal Vault database records and related
 * stored files. Preserves user accounts, chat channels, direct messages, and
 * avatars.
 *
 * Usage:
 *   node wipe_vault.js            # delete vault records and files
 *   node wipe_vault.js --dry-run  # show what would be deleted
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const dbPath = path.join(__dirname, 'data', 'offline_messenger.sqlite3');
const vaultDirs = [
  path.join(__dirname, 'uploads'),
  path.join(__dirname, 'data', 'vault')
];
const dryRun = process.argv.includes('--dry-run');
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;

if (!fs.existsSync(dbPath)) {
  console.log('[-] Database file not found at:', dbPath);
  process.exit(0);
}

/** Extracts a safe basename from a stored file URL. */
function extractFileName(fileUrl) {
  if (typeof fileUrl !== 'string' || !fileUrl) return null;
  const clean = fileUrl.split('?')[0].split('#')[0];
  let name;
  try {
    name = path.basename(decodeURIComponent(clean));
  } catch (_) {
    name = path.basename(clean);
  }
  return SAFE_NAME_RE.test(name) ? name : null;
}

/** Resolves `name` inside `dir`, returning null if it would escape. */
function resolveInside(dir, name) {
  const root = path.resolve(dir);
  const resolved = path.resolve(root, name);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

try {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare('SELECT file_url FROM personal_files').all();
  let deletedFiles = 0;

  for (const row of rows) {
    const name = extractFileName(row.file_url);
    if (!name) continue;

    for (const dir of vaultDirs) {
      const fullPath = resolveInside(dir, name);
      if (!fullPath || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) continue;

      if (dryRun) {
        console.log('[dry-run] would delete:', fullPath);
        deletedFiles++;
        continue;
      }

      try {
        fs.unlinkSync(fullPath);
        deletedFiles++;
      } catch (err) {
        console.error('[-] Could not delete file:', fullPath, err.message);
      }
    }
  }

  if (dryRun) {
    console.log(`[dry-run] ${rows.length} record(s) would be cleared; ${deletedFiles} file(s) would be deleted.`);
  } else {
    const res = db.prepare('DELETE FROM personal_files').run();
    console.log(`[+] Cleared ${res.changes} record(s) from 'personal_files' table.`);
    console.log(`[+] Deleted ${deletedFiles} associated file(s).`);
    console.log('[+] Personal Vault has been successfully wiped.');
  }
} catch (e) {
  console.error('[-] Error executing vault wipe:', e.message);
  process.exitCode = 1;
}
