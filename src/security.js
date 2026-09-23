'use strict';

const crypto = require('crypto');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, KEY_LEN, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(expected, actual);
}

// A short fingerprint of a password hash. Embedded in session tokens so that
// changing a password invalidates every session issued before the change.
function hashVersion(stored) {
  return crypto.createHash('sha256').update(stored).digest('base64url').slice(0, 16);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Stateless signed session token: base64url(json).base64url(hmac)
function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// Very small in-memory brute-force limiter keyed by client IP (+ scope).
class RateLimiter {
  constructor({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  _entry(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset < now) {
      e = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, e);
    }
    if (this.hits.size > 10000) {
      for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
    }
    return e;
  }

  blocked(key) {
    return this._entry(key).count >= this.max;
  }

  fail(key) {
    this._entry(key).count++;
  }

  reset(key) {
    this.hits.delete(key);
  }
}

module.exports = { hashPassword, verifyPassword, hashVersion, safeEqual, signToken, verifyToken, RateLimiter };
