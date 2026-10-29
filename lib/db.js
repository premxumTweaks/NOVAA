'use strict';

/*
  SQLite access layer.

  The database lives on the persistent mount (DATA_DIR, /data on Deplexo).
  The image filesystem is read-only at runtime, so nothing here is ever
  written next to the source tree in production.
*/

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;
const APP_UID = 1000;
const APP_GID = 1000;

/* ---------------- filesystem preparation ---------------- */

function chownTree(target, uid, gid) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (err) {
    return;
  }

  try {
    fs.chownSync(target, uid, gid);
  } catch (err) {
    return;
  }

  if (!stats.isDirectory()) return;

  let entries;
  try {
    entries = fs.readdirSync(target);
  } catch (err) {
    return;
  }
  for (const entry of entries) {
    chownTree(path.join(target, entry), uid, gid);
  }
}

/**
 * Create DATA_DIR and make it writable by the unprivileged runtime user.
 * Runs as root only inside the container; on Windows and on a normal
 * developer machine it is a no-op.
 */
function prepareDataDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });

  const canDrop = typeof process.getuid === 'function' && process.getuid() === 0;
  if (!canDrop) return;

  chownTree(dataDir, APP_UID, APP_GID);

  try {
    process.setgid(APP_GID);
    process.setuid(APP_UID);
  } catch (err) {
    console.warn('[db] could not drop privileges:', err.message);
  }
}

/* ---------------- migrations ---------------- */

const MIGRATIONS = [
  function migrationV1(db) {
    db.exec(`
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        display_name  TEXT,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at    TEXT
      );

      CREATE TABLE sessions (
        id_hash    TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ip         TEXT,
        user_agent TEXT
      );

      CREATE INDEX idx_sessions_user    ON sessions(user_id);
      CREATE INDEX idx_sessions_expires ON sessions(expires_at);

      CREATE TABLE contact_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        email      TEXT NOT NULL,
        company    TEXT,
        budget     TEXT,
        scope      TEXT,
        message    TEXT NOT NULL,
        ip         TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      CREATE INDEX idx_contact_created ON contact_messages(created_at);
    `);
  }
];

function currentVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row && row.user_version) || 0;
}

function migrate(db) {
  const from = currentVersion(db);
  if (from > MIGRATIONS.length) {
    throw new Error(
      'database schema version ' + from + ' is newer than this build (' + MIGRATIONS.length + ')'
    );
  }
  if (from === MIGRATIONS.length) return from;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (let version = from; version < MIGRATIONS.length; version++) {
      MIGRATIONS[version](db);
    }
    db.exec('PRAGMA user_version = ' + MIGRATIONS.length);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (rollbackErr) { /* already closed */ }
    throw err;
  }

  return MIGRATIONS.length;
}

/* ---------------- legacy contact log import ---------------- */

function importLegacyContactLog(db, legacyFile) {
  if (!legacyFile || !fs.existsSync(legacyFile)) return 0;

  let raw;
  try {
    raw = fs.readFileSync(legacyFile, 'utf8').replace(/^\uFEFF/, '');
  } catch (err) {
    console.warn('[db] could not read legacy contact log:', err.message);
    return 0;
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '').slice(0, 5000);
  if (lines.length === 0) return 0;

  const insert = db.prepare(`
    INSERT INTO contact_messages (name, email, company, budget, scope, message, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const line of lines) {
      let item;
      try {
        item = JSON.parse(line);
      } catch (err) {
        continue;
      }
      if (!item || typeof item.email !== 'string' || typeof item.message !== 'string') continue;

      insert.run(
        String(item.name || 'unknown').slice(0, 80),
        String(item.email).slice(0, 160),
        String(item.company || '').slice(0, 120),
        String(item.budget || '').slice(0, 40),
        JSON.stringify(Array.isArray(item.scope) ? item.scope.slice(0, 8) : []),
        String(item.message).slice(0, 4000),
        String(item.ip || '').slice(0, 64),
        String(item.at || new Date().toISOString())
      );
      imported++;
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (rollbackErr) { /* noop */ }
    throw err;
  }

  try {
    fs.renameSync(legacyFile, legacyFile + '.imported');
  } catch (err) {
    console.warn('[db] legacy log imported but not renamed:', err.message);
  }

  return imported;
}

/* ---------------- public API ---------------- */

function createStore(options) {
  const dataDir = path.resolve(options.dataDir);
  prepareDataDir(dataDir);

  const dbFile = path.join(dataDir, 'novaa.db');
  const db = new DatabaseSync(dbFile);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const version = migrate(db);
  const imported = importLegacyContactLog(db, options.legacyContactLog || null);

  const statements = {
    insertUser: db.prepare(
      'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)'
    ),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    updatePassword: db.prepare(
      "UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ),
    insertSession: db.prepare(
      'INSERT INTO sessions (id_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    sessionByHash: db.prepare(`
      SELECT s.id_hash, s.user_id, s.expires_at, u.id, u.email, u.display_name, u.created_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ?
    `),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id_hash = ?'),
    deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    insertContact: db.prepare(`
      INSERT INTO contact_messages (name, email, company, budget, scope, message, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    listContact: db.prepare(
      'SELECT id, name, email, company, budget, scope, message, ip, created_at FROM contact_messages ORDER BY id DESC LIMIT ?'
    ),
    countContact: db.prepare('SELECT COUNT(*) AS n FROM contact_messages'),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users')
  };

  function createUser(email, passwordHash, displayName) {
    try {
      const result = statements.insertUser.run(email, passwordHash, displayName || null);
      return Number(result.lastInsertRowid);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return null;
      throw err;
    }
  }

  function findUserByEmail(email) {
    return statements.userByEmail.get(email) || null;
  }

  function findUserById(id) {
    return statements.userById.get(id) || null;
  }

  function createSession(idHash, userId, expiresAt, ip, userAgent) {
    statements.insertSession.run(
      idHash,
      userId,
      Date.now(),
      expiresAt,
      String(ip || '').slice(0, 64),
      String(userAgent || '').slice(0, 300)
    );
  }

  function findSession(idHash) {
    return statements.sessionByHash.get(idHash) || null;
  }

  function deleteSession(idHash) {
    statements.deleteSession.run(idHash);
  }

  function purgeExpiredSessions() {
    statements.deleteExpired.run(Date.now());
  }

  function deleteSessionsForUser(userId) {
    statements.deleteUserSessions.run(userId);
  }

  function addContact(entry, ip) {
    statements.insertContact.run(
      entry.name,
      entry.email,
      entry.company,
      entry.budget,
      JSON.stringify(entry.scope || []),
      entry.message,
      String(ip || '').slice(0, 64)
    );
  }

  function listContact(limit) {
    return statements.listContact.all(Math.min(Math.max(Number(limit) || 50, 1), 200))
      .map((row) => {
        let scope = [];
        try {
          const parsed = JSON.parse(row.scope || '[]');
          if (Array.isArray(parsed)) scope = parsed;
        } catch (err) {
          scope = [];
        }
        return { ...row, scope };
      });
  }

  function stats() {
    return {
      users: Number(statements.countUsers.get().n),
      messages: Number(statements.countContact.get().n)
    };
  }

  const backupDir = path.join(dataDir, 'backups');
  const BACKUP_RE = /^novaa-[0-9A-Za-z._-]+\.db$/;

  function backup(destinationDir) {
    const dir = destinationDir || backupDir;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, 'novaa-' + stamp + '.db');
    db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");

    const keep = 14;
    const files = fs.readdirSync(dir)
      .filter((name) => name.startsWith('novaa-') && name.endsWith('.db'))
      .map((name) => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    for (const file of files.slice(keep)) {
      try { fs.unlinkSync(path.join(dir, file.name)); } catch (err) { /* noop */ }
    }

    return { file: target, size: fs.statSync(target).size };
  }

  function listBackups() {
    let names;
    try {
      names = fs.readdirSync(backupDir);
    } catch (err) {
      return [];
    }

    return names
      .filter((name) => BACKUP_RE.test(name))
      .map((name) => {
        const stats = fs.statSync(path.join(backupDir, name));
        return { file: name, size: stats.size, createdAt: new Date(stats.mtimeMs).toISOString() };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * Resolve a backup name to an absolute path, or null when the name is not a
   * plain backup filename. Guards the download route against path traversal.
   */
  function backupPath(name) {
    const base = path.basename(String(name || ''));
    if (!BACKUP_RE.test(base) || base !== name) return null;

    const full = path.join(backupDir, base);
    return fs.existsSync(full) ? full : null;
  }

  function close() {
    try { db.close(); } catch (err) { /* noop */ }
  }

  return {
    db,
    dataDir,
    dbFile,
    schemaVersion: version,
    importedLegacy: imported,
    createUser,
    findUserByEmail,
    findUserById,
    createSession,
    findSession,
    deleteSession,
    deleteSessionsForUser,
    purgeExpiredSessions,
    addContact,
    listContact,
    stats,
    backup,
    listBackups,
    backupPath,
    close
  };
}

module.exports = { createStore, SCHEMA_VERSION };
