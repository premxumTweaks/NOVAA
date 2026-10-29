'use strict';

const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const SESSION_COOKIE = 'novaa_sid';
const DAY_MS = 24 * 60 * 60 * 1000;

/* ---------------- passwords ---------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem
  });

  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    derived.toString('base64')
  ].join('$');
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < 1024 || N > 1048576 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch (err) {
    return false;
  }
  if (salt.length < 8 || expected.length < 16) return false;

  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: Math.max(SCRYPT.maxmem, 256 * N * r)
    });
  } catch (err) {
    return false;
  }

  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/* ---------------- sessions ---------------- */

function newSessionToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, idHash: hashToken(token) };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/* ---------------- cookies ---------------- */

function parseCookies(header) {
  const out = Object.create(null);
  if (!header || typeof header !== 'string') return out;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!name || name in out) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch (err) {
      out[name] = value;
    }
  }

  return out;
}

function sessionCookie(token, maxAgeSeconds, secure) {
  const attrs = [
    SESSION_COOKIE + '=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + Math.max(0, Math.floor(maxAgeSeconds))
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function clearSessionCookie(secure) {
  const attrs = [SESSION_COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function readSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  return token;
}

/* ---------------- rate limiting ---------------- */

function createLimiter(options) {
  const windowMs = options.windowMs;
  const max = options.max;
  const buckets = new Map();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
  }, Math.min(windowMs, 60 * 1000));
  if (typeof timer.unref === 'function') timer.unref();

  return function hit(key) {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { limited: false, retryAfter: 0 };
    }

    bucket.count += 1;
    if (bucket.count > max) {
      return { limited: true, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
    }
    return { limited: false, retryAfter: 0 };
  };
}

/* ---------------- request helpers ---------------- */

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0].trim();
    if (first) return first.slice(0, 64);
  }
  return String(req.ip || req.socket.remoteAddress || 'unknown').slice(0, 64);
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  let host;
  try {
    host = new URL(origin).host;
  } catch (err) {
    return false;
  }

  const expected = req.headers.host;
  if (!expected) return false;
  return host === expected;
}

/* ---------------- validation ---------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().slice(0, 160);
}

function validEmail(email) {
  return EMAIL_RE.test(email) && email.length <= 160;
}

function validPassword(password) {
  return typeof password === 'string' && password.length >= 10 && password.length <= 200;
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    email: row.email,
    name: row.display_name || '',
    createdAt: row.created_at
  };
}

module.exports = {
  SESSION_COOKIE,
  DAY_MS,
  hashPassword,
  verifyPassword,
  newSessionToken,
  hashToken,
  parseCookies,
  sessionCookie,
  clearSessionCookie,
  readSessionToken,
  createLimiter,
  clientIp,
  sameOrigin,
  normalizeEmail,
  validEmail,
  validPassword,
  cleanName,
  publicUser
};
