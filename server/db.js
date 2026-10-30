'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  channel     TEXT,
  category    TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  amount      REAL NOT NULL,
  commission  REAL NOT NULL DEFAULT 0,
  delivery    REAL NOT NULL DEFAULT 0,
  packaging   REAL NOT NULL DEFAULT 0,
  label       REAL NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  updated_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
CREATE TABLE IF NOT EXISTS activity (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  user     TEXT NOT NULL,
  action   TEXT NOT NULL,
  entry_id INTEGER,
  summary  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const COLS = ['date', 'kind', 'channel', 'category', 'note', 'amount', 'commission', 'delivery', 'packaging', 'label'];

function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const now = () => new Date().toISOString();
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  const setSetting = (key, value) =>
    db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  const bumpRev = () => setSetting('rev', Number(getSetting('rev') ?? 0) + 1);

  const log = (user, action, entryId, summary) =>
    db.prepare('INSERT INTO activity(at, user, action, entry_id, summary) VALUES(?,?,?,?,?)')
      .run(now(), user, action, entryId ?? null, summary);

  const get = (id) => db.prepare('SELECT * FROM entries WHERE id = ?').get(id) ?? null;

  const insertRow = (e, user) => {
    const t = now();
    const r = db.prepare(`INSERT INTO entries (${COLS.join(',')}, created_by, updated_by, created_at, updated_at)
      VALUES (${COLS.map((c) => '@' + c).join(',')}, @user, @user, @t, @t)`)
      .run({ ...e, user, t });
    return Number(r.lastInsertRowid);
  };

  const describe = (e) => `${e.date} · ${e.kind} · ${e.amount}${e.category ? ' · ' + e.category : ''}`;

  return {
    db,
    getSetting,
    setSetting,
    rev: () => Number(getSetting('rev') ?? 0),
    get,

    all() {
      return db.prepare('SELECT * FROM entries ORDER BY date DESC, id DESC').all();
    },

    insert(e, user) {
      return tx(() => {
        const id = insertRow(e, user);
        log(user, 'create', id, describe(e));
        bumpRev();
        return get(id);
      });
    },

    /** Массовая вставка (импорт); одна запись в журнале на весь пакет. */
    insertMany(list, user, label) {
      return tx(() => {
        for (const e of list) insertRow(e, user);
        log(user, 'import', null, `${label}: добавлено ${list.length}`);
        bumpRev();
        return list.length;
      });
    },

    update(id, e, user) {
      return tx(() => {
        if (!get(id)) return null;
        db.prepare(`UPDATE entries SET ${COLS.map((c) => `${c} = @${c}`).join(', ')},
          updated_by = @user, updated_at = @t WHERE id = @id`)
          .run({ ...e, user, t: now(), id });
        log(user, 'update', id, describe(e));
        bumpRev();
        return get(id);
      });
    },

    remove(id, user) {
      return tx(() => {
        const old = get(id);
        if (!old) return false;
        db.prepare('DELETE FROM entries WHERE id = ?').run(id);
        log(user, 'delete', id, describe(old));
        bumpRev();
        return true;
      });
    },

    activity(limit = 100) {
      return db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit);
    },
  };
}

module.exports = { openStore };
