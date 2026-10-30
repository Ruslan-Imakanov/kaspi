'use strict';

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
CREATE TABLE IF NOT EXISTS rates (
  category TEXT PRIMARY KEY,
  percent  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS recurring (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  kind     TEXT NOT NULL,
  category TEXT NOT NULL,
  amount   REAL NOT NULL,
  day      INTEGER NOT NULL,
  note     TEXT NOT NULL DEFAULT '',
  active   INTEGER NOT NULL DEFAULT 1
);
`;

// Столбцы, добавленные после первого релиза: старые базы дополняются при запуске.
const ADDED_COLUMNS = [
  ['source', "TEXT NOT NULL DEFAULT 'manual'"],
  ['external_id', 'TEXT'],
  ['estimated', 'INTEGER NOT NULL DEFAULT 0'],
  ['recurring_key', 'TEXT'],
];

const EDIT_COLS = ['date', 'kind', 'channel', 'category', 'note', 'amount', 'commission', 'delivery', 'packaging', 'label', 'estimated'];
const ALL_COLS = [...EDIT_COLS, 'source', 'external_id', 'recurring_key'];

const pick = (obj, cols) => Object.fromEntries(cols.map((c) => [c, obj[c] ?? null]));

/** driver: { exec(sql), prepare(sql) -> {run,get,all}, tx(fn) } — Node-драйвер или Cloudflare Durable Object. */
function openStore(driver) {
  const db = driver;
  db.exec(SCHEMA);
  for (const [name, def] of ADDED_COLUMNS) {
    try { db.exec(`ALTER TABLE entries ADD COLUMN ${name} ${def}`); } catch (err) {
      if (!/duplicate column/i.test(String(err && err.message))) throw err; // столбец уже есть — это нормально
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_entries_external ON entries(external_id) WHERE external_id IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_entries_recurring ON entries(recurring_key) WHERE recurring_key IS NOT NULL');

  const now = () => new Date().toISOString();
  const tx = (fn) => db.tx(fn);

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
    return db.prepare(`INSERT INTO entries (${ALL_COLS.join(',')}, created_by, updated_by, created_at, updated_at)
      VALUES (${ALL_COLS.map((c) => '@' + c).join(',')}, @user, @user, @t, @t) RETURNING id`)
      .get({ ...pick(e, ALL_COLS), user, t }).id;
  };

  const describe = (e) => `${e.date} · ${e.kind} · ${e.amount}${e.category ? ' · ' + e.category : ''}`;

  return {
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

    /** Вставка с защитой от повторов по external_id / recurring_key. Возвращает запись или null. */
    insertUnique(e, user, { silent = false } = {}) {
      return tx(() => {
        const dup = e.external_id
          ? db.prepare('SELECT id FROM entries WHERE external_id = ?').get(e.external_id)
          : e.recurring_key ? db.prepare('SELECT id FROM entries WHERE recurring_key = ?').get(e.recurring_key) : null;
        if (dup) return null;
        const id = insertRow(e, user);
        if (!silent) log(user, 'create', id, describe(e));
        bumpRev();
        return get(id);
      });
    },

    /** Массовая вставка (импорт, синхронизация); одна запись в журнале на весь пакет. */
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
        db.prepare(`UPDATE entries SET ${EDIT_COLS.map((c) => `${c} = @${c}`).join(', ')},
          updated_by = @user, updated_at = @t WHERE id = @id`)
          .run({ ...pick(e, EDIT_COLS), user, t: now(), id });
        log(user, 'update', id, describe(e));
        bumpRev();
        return get(id);
      });
    },

    /** Точечное обновление нескольких записей (сверка, пересчёт ставок). */
    patchMany(patches, user, summary) {
      return tx(() => {
        const stmt = db.prepare(`UPDATE entries SET commission = @commission, delivery = @delivery,
          estimated = @estimated, updated_by = @user, updated_at = @t WHERE id = @id`);
        const t = now();
        for (const p of patches) stmt.run({ commission: p.commission, delivery: p.delivery, estimated: p.estimated ? 1 : 0, user, t, id: p.id });
        if (patches.length) { log(user, 'update', null, `${summary}: ${patches.length}`); bumpRev(); }
        return patches.length;
      });
    },

    setNote(id, note, estimated, user) {
      return tx(() => {
        db.prepare('UPDATE entries SET note = ?, estimated = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(note, estimated ? 1 : 0, user, now(), id);
        bumpRev();
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
    logActivity: (user, action, summary) => { log(user, action, null, summary); bumpRev(); },

    // --- ставки комиссии по категориям Kaspi ---
    rates: () => db.prepare('SELECT category, percent FROM rates ORDER BY category').all(),
    setRate(category, percent, user) {
      tx(() => {
        db.prepare('INSERT INTO rates(category, percent) VALUES(?, ?) ON CONFLICT(category) DO UPDATE SET percent = excluded.percent').run(category, percent);
        log(user, 'update', null, `Ставка «${category}»: ${percent}%`);
        bumpRev();
      });
    },
    removeRate(category, user) {
      tx(() => {
        db.prepare('DELETE FROM rates WHERE category = ?').run(category);
        log(user, 'delete', null, `Ставка «${category}» удалена`);
        bumpRev();
      });
    },

    // --- регулярные платежи ---
    recurring: () => db.prepare('SELECT * FROM recurring ORDER BY day, id').all(),
    addRecurring(r, user) {
      return tx(() => {
        const id = db.prepare('INSERT INTO recurring(kind, category, amount, day, note) VALUES(?,?,?,?,?) RETURNING id')
          .get(r.kind, r.category, r.amount, r.day, r.note).id;
        log(user, 'create', null, `Регулярный платёж: ${r.category} ${r.amount} (${r.day}-го)`);
        bumpRev();
        return id;
      });
    },
    setRecurringActive(id, active, user) {
      tx(() => {
        db.prepare('UPDATE recurring SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
        log(user, 'update', null, `Регулярный платёж #${id}: ${active ? 'включён' : 'выключен'}`);
        bumpRev();
      });
    },
    removeRecurring(id, user) {
      tx(() => {
        db.prepare('DELETE FROM recurring WHERE id = ?').run(id);
        log(user, 'delete', null, `Регулярный платёж #${id} удалён`);
        bumpRev();
      });
    },
  };
}

module.exports = { openStore };
