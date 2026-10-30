'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

/** Драйвер SQLite для Node (локальный запуск, Docker). Интерфейс общий с Cloudflare-драйвером. */
function openNodeDriver(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  return {
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const st = db.prepare(sql);
      return {
        run: (...args) => { st.run(...args); },
        get: (...args) => st.get(...args) ?? null,
        all: (...args) => st.all(...args),
      };
    },
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

module.exports = { openNodeDriver };
