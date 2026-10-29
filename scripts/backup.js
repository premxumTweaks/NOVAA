#!/usr/bin/env node
'use strict';

/*
  Consistent SQLite backup via VACUUM INTO.

  Usage:
    node scripts/backup.js
    DATA_DIR=/data node scripts/backup.js

  Writes into <DATA_DIR>/backups and keeps the 14 most recent files.
  Copy the result off the platform afterwards; a backup on the same
  worker does not protect against losing the worker.
*/

const path = require('node:path');
const { createStore } = require('../lib/db');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

let store;
try {
  store = createStore({ dataDir });
  const result = store.backup();
  console.log('backup written:', result.file);
  console.log('size:', result.size, 'bytes');
} catch (err) {
  console.error('backup failed:', err.message);
  process.exitCode = 1;
} finally {
  if (store) store.close();
}
