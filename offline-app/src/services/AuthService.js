const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// Usernames are used to build DM channel IDs (`dm_<a>_<b>`), so `_` is
// deliberately excluded to keep those IDs unambiguous.
const USERNAME_RE = /^[a-z0-9.-]{2,32}$/;

// 12 characters is the practical minimum for a password without MFA. Existing
// accounts with shorter legacy passwords can still log in; the policy only
// applies to new registrations.
const MIN_REGISTRATION_PASSWORD_LENGTH = 12;

// Bound the input so a huge password cannot be used to burn CPU/memory.
const MAX_PASSWORD_LENGTH = 256;

const SALT_BYTES = 16;
const SALT_HEX_RE = /^[a-f0-9]{32}$/i;
const LEGACY_PBKDF2_ITERATIONS = 100000;
const LEGACY_HASH_RE = /^[a-f0-9]{128}$/i;
const SCRYPT_HASH_RE = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([a-f0-9]{128})$/i;

// scrypt is memory-hard and built into Node, so no native dependency is needed.
// N=32768, r=8, p=1 uses ~32 MiB per derivation.
const SCRYPT_PARAMS = Object.freeze({
  N: 32768,
  r: 8,
  p: 1,
  keylen: 64,
  maxmem: 64 * 1024 * 1024
});

function isHexSalt(value) {
  return typeof value === 'string' && SALT_HEX_RE.test(value);
}

function isScryptHash(value) {
  return typeof value === 'string' && SCRYPT_HASH_RE.test(value);
}

function isLegacyHash(value) {
  return typeof value === 'string' && LEGACY_HASH_RE.test(value);
}

class AuthService {
  static get MIN_PASSWORD_LENGTH() {
    return MIN_REGISTRATION_PASSWORD_LENGTH;
  }

  static get MAX_PASSWORD_LENGTH() {
    return MAX_PASSWORD_LENGTH;
  }

  /**
   * Derives a scrypt hash. The returned hash string embeds the algorithm and
   * parameters, so future cost increases can be migrated without a schema
   * change: `scrypt$N$r$p$<hex>`.
   */
  static async hashPassword(password, salt = null) {
    const effectiveSalt = isHexSalt(salt)
      ? salt
      : crypto.randomBytes(SALT_BYTES).toString('hex');

    const derived = await scrypt(password, effectiveSalt, SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      maxmem: SCRYPT_PARAMS.maxmem
    });

    return {
      salt: effectiveSalt,
      hash: `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${Buffer.from(derived).toString('hex')}`
    };
  }

  /**
   * True when the stored hash is not the current scrypt format/cost and should
   * be upgraded after the next successful login.
   */
  static needsRehash(expectedHash) {
    if (!isScryptHash(expectedHash)) return true;
    const match = expectedHash.match(SCRYPT_HASH_RE);
    const N = parseInt(match[1], 10);
    const r = parseInt(match[2], 10);
    const p = parseInt(match[3], 10);
    return N < SCRYPT_PARAMS.N || r < SCRYPT_PARAMS.r || p < SCRYPT_PARAMS.p;
  }

  static isLegacyHash(expectedHash) {
    return isLegacyHash(expectedHash);
  }

  /**
   * Verifies a password against either the current scrypt format or the legacy
   * PBKDF2-SHA512 format. Returns a boolean and never throws.
   */
  static async verifyPassword(password, salt, expectedHash) {
    if (
      typeof password !== 'string' ||
      !password ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      return false;
    }
    if (!isHexSalt(salt) || typeof expectedHash !== 'string') return false;

    try {
      const match = expectedHash.match(SCRYPT_HASH_RE);
      if (match) {
        const N = parseInt(match[1], 10);
        const r = parseInt(match[2], 10);
        const p = parseInt(match[3], 10);

        // Guard against a corrupted/tampered DB row requesting absurd work.
        if (!Number.isInteger(N) || N < 16384 || N > 131072) return false;
        if ((N & (N - 1)) !== 0) return false; // must be a power of two
        if (!Number.isInteger(r) || r < 1 || r > 16) return false;
        if (!Number.isInteger(p) || p < 1 || p > 4) return false;
        if (N * r > 1048576) return false; // cap memory around 128 MiB

        const derived = await scrypt(password, salt, SCRYPT_PARAMS.keylen, {
          N,
          r,
          p,
          maxmem: Math.max(SCRYPT_PARAMS.maxmem, 256 * N * r)
        });
        const actual = Buffer.from(derived);
        const expected = Buffer.from(match[4], 'hex');
        if (actual.length !== expected.length) return false;
        return crypto.timingSafeEqual(actual, expected);
      }

      if (isLegacyHash(expectedHash)) {
        const derived = crypto.pbkdf2Sync(
          password,
          salt,
          LEGACY_PBKDF2_ITERATIONS,
          64,
          'sha512'
        );
        const expected = Buffer.from(expectedHash, 'hex');
        if (derived.length !== expected.length) return false;
        return crypto.timingSafeEqual(derived, expected);
      }

      return false;
    } catch (_) {
      return false;
    }
  }

  /**
   * 256-bit session token. Tokens are generated server-side and kept only in
   * memory, never written to the database or logs.
   */
  static generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Validates credentials. Registration enforces the full policy; login only
   * requires non-empty strings so existing accounts keep working.
   */
  static validateCredentials(username, password, options = {}) {
    const { isRegister = false } = options;
    if (typeof username !== 'string' || typeof password !== 'string') {
      return { valid: false, error: 'Invalid credentials.' };
    }
    if (username.length > 64) {
      return { valid: false, error: 'Invalid username.' };
    }

    const cleanUser = username.trim().toLowerCase();
    if (!USERNAME_RE.test(cleanUser)) {
      return {
        valid: false,
        error: 'Username must be 2-32 characters using letters, numbers, dots, or hyphens.'
      };
    }

    if (!password) {
      return { valid: false, error: 'Password is required.' };
    }

    if (password.length > MAX_PASSWORD_LENGTH) {
      return {
        valid: false,
        error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`
      };
    }

    if (isRegister && password.length < MIN_REGISTRATION_PASSWORD_LENGTH) {
      return {
        valid: false,
        error: `Password must be at least ${MIN_REGISTRATION_PASSWORD_LENGTH} characters.`
      };
    }

    return { valid: true, cleanUser };
  }
}

module.exports = {
  AuthService,
  USERNAME_RE,
  MIN_REGISTRATION_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH
};
