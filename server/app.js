'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { openStore } = require('./db');
const { createAuth } = require('./auth');
const { normalize, KIND_LABELS, CHANNEL_LABELS, CATEGORIES, isValidDate } = require('./entries');
const { computeStats } = require('./stats');
const { buildWorkbook } = require('./export');
const { parseWorkbook, dedupe } = require('./import');

const PUBLIC = path.join(__dirname, '..', 'public');
const CHART_JS = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');

function createApp({ dbFile, users }) {
  const store = openStore(dbFile);
  let secret = store.getSetting('session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    store.setSetting('session_secret', secret);
  }
  const auth = createAuth({ users, secret });

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    });
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/vendor/chart.js', (req, res) => res.sendFile(CHART_JS));
  app.use(express.static(PUBLIC, { maxAge: 0, etag: true }));

  // Защита от CSRF: изменяющие запросы принимаем только как JSON или бинарный файл с того же origin
  const api = express.Router();
  api.use((req, res, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Запрещено' });
    }
    next();
  });
  api.post('/login', express.json({ limit: '10kb' }), auth.login);
  api.post('/logout', auth.logout);

  api.use(auth.middleware);
  api.use(express.json({ limit: '100kb' }));

  api.get('/me', (req, res) => res.json({ user: req.user }));

  api.get('/meta', (req, res) => {
    res.json({
      user: req.user,
      users: users.map((u) => u.name),
      kinds: KIND_LABELS,
      channels: CHANNEL_LABELS,
      categories: CATEGORIES,
      rev: store.rev(),
    });
  });

  api.get('/rev', (req, res) => res.json({ rev: store.rev() }));

  const rangeOf = (req) => {
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    if ((from && !isValidDate(from)) || (to && !isValidDate(to))) return { error: 'Некорректный период' };
    return { from, to };
  };

  api.get('/entries', (req, res) => {
    const r = rangeOf(req);
    if (r.error) return res.status(400).json({ error: r.error });
    const { kind, channel, q } = req.query;
    const needle = q ? String(q).toLowerCase() : '';
    const list = store.all().filter((e) =>
      (!r.from || e.date >= r.from) && (!r.to || e.date <= r.to) &&
      (!kind || e.kind === kind) && (!channel || e.channel === channel) &&
      (!needle || `${e.category} ${e.note} ${e.amount} ${e.created_by}`.toLowerCase().includes(needle)));
    res.json({ entries: list, rev: store.rev() });
  });

  api.post('/entries', (req, res) => {
    const r = normalize(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    res.status(201).json({ entry: store.insert(r.value, req.user), rev: store.rev() });
  });

  api.put('/entries/:id', (req, res) => {
    const r = normalize(req.body);
    if (r.error) return res.status(400).json({ error: r.error });
    const entry = store.update(Number(req.params.id), r.value, req.user);
    if (!entry) return res.status(404).json({ error: 'Запись не найдена' });
    res.json({ entry, rev: store.rev() });
  });

  api.delete('/entries/:id', (req, res) => {
    if (!store.remove(Number(req.params.id), req.user)) return res.status(404).json({ error: 'Запись не найдена' });
    res.json({ ok: true, rev: store.rev() });
  });

  api.get('/stats', (req, res) => {
    const r = rangeOf(req);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ ...computeStats(store.all(), r.from, r.to), rev: store.rev() });
  });

  api.get('/activity', (req, res) => res.json({ activity: store.activity(100) }));

  api.get('/export.xlsx', async (req, res, next) => {
    try {
      const r = rangeOf(req);
      if (r.error) return res.status(400).json({ error: r.error });
      const wb = await buildWorkbook(store.all(), r.from, r.to);
      const stamp = new Date().toISOString().slice(0, 10);
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="kaspi-uchet-${stamp}.xlsx"`,
        'Cache-Control': 'no-store',
      });
      await wb.xlsx.write(res);
      res.end();
    } catch (err) { next(err); }
  });

  // Импорт .xlsx в формате вашей таблицы. ?dryRun=1 — только предпросмотр.
  api.post('/import', express.raw({ type: () => true, limit: '10mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Файл не получен' });
    try {
      const parsed = await parseWorkbook(req.body);
      const { fresh, duplicates } = dedupe(parsed.entries, store.all());
      const result = {
        found: parsed.entries.length, added: fresh.length, duplicates,
        ignored: parsed.ignored, errors: parsed.errors.slice(0, 10),
      };
      if (req.query.dryRun === '1') return res.json({ ...result, dryRun: true });
      if (fresh.length) store.insertMany(fresh, req.user, 'Импорт из Excel');
      res.json({ ...result, rev: store.rev() });
    } catch (err) {
      res.status(400).json({ error: `Не удалось прочитать файл: ${err.message}` });
    }
  });

  api.use((req, res) => res.status(404).json({ error: 'Не найдено' }));
  app.use('/api', api);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.status < 500 ? err.message : 'Ошибка сервера' });
  });

  return { app, store };
}

module.exports = { createApp };
