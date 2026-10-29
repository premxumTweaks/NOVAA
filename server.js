'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { createStore } = require('./lib/db');
const auth = require('./lib/auth');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const publicDir = path.join(__dirname, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const LEGACY_CONTACT_LOG = path.join(__dirname, 'data', 'contact.log');
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';
const SESSION_DAYS = 30;
const REMEMBER_DAYS = 30;
const SHORT_SESSION_HOURS = 24;

app.disable('x-powered-by');
app.set('trust proxy', 1);

/* ---------------- store ---------------- */

let store;
try {
  store = createStore({ dataDir: DATA_DIR, legacyContactLog: LEGACY_CONTACT_LOG });
} catch (err) {
  console.error('[boot] database could not be opened in ' + DATA_DIR);
  console.error('[boot] ' + err.message);
  console.error('[boot] on Deplexo, mount the persistent volume at /data and set DATA_DIR=/data');
  process.exit(1);
}

/* ---------------- boot bookkeeping ---------------- */

const bootFile = path.join(DATA_DIR, '.boot-history.json');

function recordBoot() {
  const now = new Date().toISOString();
  let previous = null;
  let history = { firstAt: now, lastAt: now, boots: 1 };

  try {
    if (fs.existsSync(bootFile)) {
      const parsed = JSON.parse(fs.readFileSync(bootFile, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        previous = parsed.lastAt || null;
        history = {
          firstAt: parsed.firstAt || now,
          lastAt: now,
          boots: Number(parsed.boots || 0) + 1
        };
      }
    }
  } catch (err) {
    console.warn('[boot] could not read boot history:', err.message);
  }

  try {
    fs.writeFileSync(bootFile, JSON.stringify(history, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.warn('[boot] could not write boot history:', err.message);
  }

  return { ...history, previousAt: previous };
}

const bootInfo = recordBoot();

function diskInfo() {
  try {
    const stats = fs.statfsSync(DATA_DIR);
    const blockSize = Number(stats.bsize);
    return {
      mounted: true,
      totalBytes: blockSize * Number(stats.blocks),
      freeBytes: blockSize * Number(stats.bavail)
    };
  } catch (err) {
    return { mounted: false, totalBytes: 0, freeBytes: 0, error: err.message };
  }
}

const dbBytes = () => {
  try {
    return fs.statSync(store.dbFile).size;
  } catch (err) {
    return 0;
  }
};

/* ---------------- middleware ---------------- */

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(express.json({ limit: '16kb' }));

app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (!auth.sameOrigin(req)) {
    return res.status(403).json({ ok: false, error: 'Cross-origin request refused.' });
  }
  next();
});

/* ---------------- rate limits ---------------- */

const contactLimiter = auth.createLimiter({ windowMs: 10 * 60 * 1000, max: 5 });
const registerLimiter = auth.createLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
const loginIpLimiter = auth.createLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
const loginUserLimiter = auth.createLimiter({ windowMs: 15 * 60 * 1000, max: 8 });

/* ---------------- session helpers ---------------- */

function startSession(req, res, user, days) {
  const { token, idHash } = auth.newSessionToken();
  const ttlMs = Math.round(days * 24 * 60 * 60 * 1000);
  const expiresAt = Date.now() + ttlMs;

  store.createSession(idHash, user.id, expiresAt, auth.clientIp(req), req.headers['user-agent']);
  res.setHeader('Set-Cookie', auth.sessionCookie(token, Math.round(ttlMs / 1000), COOKIE_SECURE));

  return expiresAt;
}

function currentSession(req) {
  const token = auth.readSessionToken(req);
  if (!token) return null;

  const idHash = auth.hashToken(token);
  const row = store.findSession(idHash);
  if (!row) return null;

  if (Number(row.expires_at) <= Date.now()) {
    store.deleteSession(idHash);
    return null;
  }

  return { idHash, row };
}

/* ---------------- auth API ---------------- */

app.post('/api/auth/register', (req, res) => {
  const ip = auth.clientIp(req);

  const limit = registerLimiter(ip);
  if (limit.limited) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ ok: false, error: 'Too many accounts created from this address. Try again later.' });
  }

  const body = req.body || {};
  const email = auth.normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const name = auth.cleanName(body.name);

  if (!auth.validEmail(email)) {
    return res.status(422).json({ ok: false, error: 'Enter a valid email address.' });
  }
  if (!auth.validPassword(password)) {
    return res.status(422).json({ ok: false, error: 'Password must be between 10 and 200 characters.' });
  }

  if (store.findUserByEmail(email)) {
    return res.status(409).json({ ok: false, error: 'An account already exists for this email.' });
  }

  const passwordHash = auth.hashPassword(password);
  const id = store.createUser(email, passwordHash, name);
  if (id === null) {
    return res.status(409).json({ ok: false, error: 'An account already exists for this email.' });
  }

  const user = store.findUserById(id);
  startSession(req, res, user, SESSION_DAYS);

  console.log('auth: registered ' + email);
  return res.status(201).json({ ok: true, user: auth.publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const ip = auth.clientIp(req);
  const body = req.body || {};
  const email = auth.normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';
  const remember = body.remember === true;

  const ipLimit = loginIpLimiter(ip);
  if (ipLimit.limited) {
    res.setHeader('Retry-After', String(ipLimit.retryAfter));
    return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in a few minutes.' });
  }

  const userLimit = loginUserLimiter(ip + '|' + email);
  if (userLimit.limited) {
    res.setHeader('Retry-After', String(userLimit.retryAfter));
    return res.status(429).json({ ok: false, error: 'Too many attempts for this account. Try again in a few minutes.' });
  }

  const row = email ? store.findUserByEmail(email) : null;
  const valid = row ? auth.verifyPassword(password, row.password_hash) : false;

  if (!valid) {
    return res.status(401).json({ ok: false, error: 'Email or password is incorrect.' });
  }

  const days = remember ? REMEMBER_DAYS : SHORT_SESSION_HOURS / 24;
  startSession(req, res, row, days);

  console.log('auth: login ' + row.email);
  return res.json({ ok: true, user: auth.publicUser(row) });
});

app.post('/api/auth/logout', (req, res) => {
  const session = currentSession(req);
  if (session) store.deleteSession(session.idHash);

  res.setHeader('Set-Cookie', auth.clearSessionCookie(COOKIE_SECURE));
  return res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const session = currentSession(req);
  if (!session) return res.json({ ok: true, user: null });

  return res.json({ ok: true, user: auth.publicUser(session.row) });
});

/* ---------------- contact API ---------------- */

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_RE, '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

app.post('/api/contact', (req, res) => {
  const ip = auth.clientIp(req);

  const limit = contactLimiter(ip);
  if (limit.limited) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ ok: false, error: 'Too many messages from this address. Try again later or email hello@nova.studio.' });
  }

  const body = req.body || {};

  // Honeypot: real users never see this field.
  if (clean(body.website, 200) !== '') {
    return res.status(400).json({ ok: false, error: 'The brief could not be validated.' });
  }

  const entry = {
    name: clean(body.name, 80),
    email: clean(body.email, 160),
    company: clean(body.company, 120),
    budget: clean(body.budget, 40),
    scope: Array.isArray(body.scope)
      ? body.scope.slice(0, 8).map((item) => clean(item, 40)).filter(Boolean)
      : [],
    message: clean(body.message, 4000)
  };

  if (entry.name.length < 2) {
    return res.status(422).json({ ok: false, error: 'A name is required.' });
  }
  if (!auth.validEmail(entry.email)) {
    return res.status(422).json({ ok: false, error: 'That email does not look valid.' });
  }
  if (entry.message.length < 20) {
    return res.status(422).json({ ok: false, error: 'Give us at least a couple of sentences about the project.' });
  }

  try {
    store.addContact(entry, ip);
  } catch (err) {
    console.error('contact write failed:', err);
    return res.status(500).json({ ok: false, error: 'Could not store the brief. Email hello@nova.studio instead.' });
  }

  console.log('contact: new brief from ' + entry.email + ' (' + entry.name + ')');
  return res.status(201).json({ ok: true });
});

/* ---------------- admin API ---------------- */

function adminAllowed(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;

  const header = req.headers['x-admin-token'];
  const bearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';
  const provided = typeof header === 'string' ? header : bearer;
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_TOKEN) {
    return res.status(503).json({ ok: false, error: 'Admin API disabled: ADMIN_TOKEN is not set.' });
  }
  if (!adminAllowed(req)) {
    return res.status(401).json({ ok: false, error: 'Invalid admin token.' });
  }
  next();
}

app.get('/api/admin/messages', requireAdmin, (req, res) => {
  try {
    return res.json({ ok: true, messages: store.listContact(req.query.limit) });
  } catch (err) {
    console.error('admin messages failed:', err);
    return res.status(500).json({ ok: false, error: 'Could not read messages.' });
  }
});

app.post('/api/admin/backup', requireAdmin, (_req, res) => {
  try {
    const result = store.backup();
    return res.json({ ok: true, file: path.basename(result.file), size: result.size });
  } catch (err) {
    console.error('backup failed:', err);
    return res.status(500).json({ ok: false, error: 'Backup failed.' });
  }
});

app.get('/api/admin/backups', requireAdmin, (_req, res) => {
  try {
    return res.json({ ok: true, backups: store.listBackups() });
  } catch (err) {
    console.error('backup listing failed:', err);
    return res.status(500).json({ ok: false, error: 'Could not list backups.' });
  }
});

// Download one backup so it can be copied off the platform. The token is
// required, so this is not a public file listing.
app.get('/api/admin/backups/:file', requireAdmin, (req, res) => {
  const full = store.backupPath(req.params.file);
  if (!full) return res.status(404).json({ ok: false, error: 'Backup not found.' });

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/vnd.sqlite3');
  return res.download(full, path.basename(full));
});

/* ---------------- health ---------------- */

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    storage: diskInfo().mounted,
    schema: store.schemaVersion,
    users: store.stats().users
  });
});

app.get('/health/storage', (_req, res) => {
  res.json({
    ok: diskInfo().mounted,
    dataDir: DATA_DIR,
    mount: diskInfo(),
    dbBytes: dbBytes(),
    boots: bootInfo.boots,
    firstSeenAt: bootInfo.firstAt,
    lastBootAt: bootInfo.lastAt,
    previousBootAt: bootInfo.previousAt,
    schema: store.schemaVersion
  });
});

/* ---------------- pages ---------------- */

app.use(express.static(publicDir, {
  index: 'index.html',
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

const pages = {
  '/': 'index.html',
  '/work': 'work.html',
  '/studio': 'studio.html',
  '/contact': 'contact.html',
  '/login': 'login.html',
  '/register': 'register.html',
  '/account': 'account.html'
};

for (const [route, file] of Object.entries(pages)) {
  app.get(route, (_req, res) => {
    res.sendFile(path.join(publicDir, file));
  });
}

/* ---------------- fallbacks ---------------- */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: 'Unknown endpoint.' });
  }
  res.status(404).sendFile(path.join(publicDir, '404.html'));
});

app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'Malformed JSON body.' });
  }

  console.error('unhandled error:', err);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ ok: false, error: 'Server error.' });
  }
  res.status(500).type('text/plain').send('Server error.');
});

/* ---------------- boot ---------------- */

store.purgeExpiredSessions();
setInterval(() => store.purgeExpiredSessions(), 60 * 60 * 1000).unref();

const disk = diskInfo();
console.log('NOVA is available on http://localhost:' + PORT);
console.log('Pages: /, /work, /studio, /contact, /login, /register, /account');
console.log('data: ' + DATA_DIR + ' (schema v' + store.schemaVersion + ', ' + (disk.mounted ? 'mounted' : 'not detected') + ')');
if (store.importedLegacy > 0) {
  console.log('contact log imported: ' + store.importedLegacy + ' message(s)');
}
if (bootInfo.previousAt) {
  console.log('previous boot: ' + bootInfo.previousAt + ' (data persisted)');
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('listening on 0.0.0.0:' + PORT);
});

function shutdown(signal) {
  console.log('\n' + signal + ' received, closing server.');
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
