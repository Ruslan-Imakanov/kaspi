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
const { suggestDeductions } = require('./suggest');
const { pendingFor, suggestRecurring } = require('./recurring');
const { planReconcile } = require('./reconcile');
const { fetchOrders, mapOrders } = require('./kaspi');

const PUBLIC = path.join(__dirname, '..', 'public');
const CHART_JS = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');

const KASPI_BASE = 'https://kaspi.kz/shop/api/v2';
const KASPI_USER = 'Kaspi API';

function createApp({ dbFile, users, kaspi = {}, tz = 'Asia/Almaty' }) {
  const store = openStore(dbFile);
  const kaspiCfg = {
    token: kaspi.token || '',
    base: kaspi.base || KASPI_BASE,
    fetchImpl: kaspi.fetchImpl || fetch,
  };
  let syncing = false;

  /** Подтягивает завершённые заказы Kaspi Магазина. dryRun — ничего не записывает. */
  async function kaspiSync({ days = 30, dryRun = false, now = Date.now() } = {}) {
    if (!kaspiCfg.token) throw new Error('Не задан KASPI_TOKEN');
    if (syncing) throw new Error('Синхронизация уже идёт');
    syncing = true;
    try {
      const raw = await fetchOrders({ ...kaspiCfg, fromMs: now - days * 86400000, toMs: now });
      const all = store.all();
      const mapped = mapOrders(raw, { rates: store.rates(), tz, suggest: (amount, category) => suggestDeductions(all, { amount, channel: 'shop', category }, store.rates()) });
      const known = new Set(all.map((e) => e.external_id).filter(Boolean));
      const fresh = mapped.entries.filter((e) => !known.has(e.external_id));
      const flagged = all.filter((e) => e.external_id && mapped.returned.includes(e.external_id) && !/возврат|отмен/i.test(e.note));
      const result = {
        fetched: raw.orders.length, completed: mapped.entries.length, added: fresh.length,
        returned: flagged.length, unknownCategories: mapped.unknown, sample: fresh.slice(0, 5),
      };
      if (dryRun) return { ...result, dryRun: true };

      for (const e of fresh) {
        const r = normalize(e, { trusted: true });
        if (r.value) store.insertUnique(r.value, KASPI_USER, { silent: true });
      }
      for (const e of flagged) store.setNote(e.id, `${e.note} · ВОЗВРАТ/ОТМЕНА в Kaspi — проверьте`, true, KASPI_USER);
      if (fresh.length) store.logActivity(KASPI_USER, 'import', `Kaspi Магазин: добавлено продаж ${fresh.length}`);
      store.setSetting('kaspi_unknown', JSON.stringify(mapped.unknown));
      store.setSetting('kaspi_last', JSON.stringify({ at: new Date().toISOString(), ok: true, added: fresh.length, fetched: raw.orders.length }));
      return result;
    } catch (err) {
      store.setSetting('kaspi_last', JSON.stringify({ at: new Date().toISOString(), ok: false, message: err.message }));
      throw err;
    } finally { syncing = false; }
  }

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
      if (fresh.length) store.insertMany(fresh.map((e) => ({ ...e, source: 'import' })), req.user, 'Импорт из Excel');
      res.json({ ...result, rev: store.rev() });
    } catch (err) {
      res.status(400).json({ error: `Не удалось прочитать файл: ${err.message}` });
    }
  });


  // --- подсказка комиссии и доставки по истории ---
  api.get('/suggest', (req, res) => {
    const s = suggestDeductions(store.all(), { amount: req.query.amount, channel: req.query.channel || 'shop', category: String(req.query.category || '') }, store.rates());
    res.json({ suggestion: s });
  });

  // --- регулярные платежи ---
  const todayOf = (req) => (isValidDate(String(req.query.today)) ? String(req.query.today) : new Date().toISOString().slice(0, 10));

  api.get('/pending', (req, res) => {
    const all = store.all();
    res.json({
      pending: pendingFor(store.recurring(), all, todayOf(req)),
      review: all.filter((e) => e.estimated).length,
    });
  });

  api.get('/recurring', (req, res) => {
    const list = store.recurring();
    res.json({ recurring: list, suggestions: suggestRecurring(store.all(), list) });
  });

  api.post('/recurring', (req, res) => {
    const b = req.body || {};
    const r = normalize({ date: '2000-01-01', kind: b.kind, category: b.category, amount: b.amount, note: b.note });
    const day = Number(b.day);
    if (r.error) return res.status(400).json({ error: r.error });
    if (!['expense', 'withdrawal', 'topup'].includes(r.value.kind)) return res.status(400).json({ error: 'Для регулярных платежей: расход, снятие или пополнение' });
    if (!r.value.category) return res.status(400).json({ error: 'Укажите категорию' });
    if (!Number.isInteger(day) || day < 1 || day > 31) return res.status(400).json({ error: 'День месяца: от 1 до 31' });
    const id = store.addRecurring({ kind: r.value.kind, category: r.value.category, amount: r.value.amount, day, note: r.value.note }, req.user);
    res.status(201).json({ id, rev: store.rev() });
  });

  api.put('/recurring/:id', (req, res) => {
    store.setRecurringActive(Number(req.params.id), !!req.body?.active, req.user);
    res.json({ ok: true, rev: store.rev() });
  });

  api.delete('/recurring/:id', (req, res) => {
    store.removeRecurring(Number(req.params.id), req.user);
    res.json({ ok: true, rev: store.rev() });
  });

  // Внести платёж за месяц одним нажатием (повторно тот же месяц не внесётся)
  api.post('/pending/confirm', (req, res) => {
    const { id, month, amount, date } = req.body || {};
    const rec = store.recurring().find((r) => r.id === Number(id));
    if (!rec) return res.status(404).json({ error: 'Платёж не найден' });
    if (!/^\d{4}-\d{2}$/.test(String(month))) return res.status(400).json({ error: 'Некорректный месяц' });
    const day = Math.min(rec.day, new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate());
    const r = normalize({ date: date || `${month}-${String(day).padStart(2, '0')}`, kind: rec.kind, category: rec.category, amount: amount ?? rec.amount, note: rec.note,
      source: 'recurring', recurring_key: `${rec.id}:${month}` }, { trusted: true });
    if (r.error) return res.status(400).json({ error: r.error });
    const entry = store.insertUnique(r.value, req.user);
    if (!entry) return res.status(409).json({ error: 'За этот месяц уже внесено' });
    res.status(201).json({ entry, rev: store.rev() });
  });

  // --- ставки комиссии по категориям ---
  api.get('/rates', (req, res) => {
    let unknown = [];
    try { unknown = JSON.parse(store.getSetting('kaspi_unknown') || '[]'); } catch { /* пусто */ }
    const have = new Set(store.rates().map((r) => r.category));
    res.json({ rates: store.rates(), unknown: unknown.filter((u) => !have.has(u.category)) });
  });

  api.put('/rates', (req, res) => {
    const category = String(req.body?.category ?? '').trim().slice(0, 80);
    const percent = Number(String(req.body?.percent).replace(',', '.'));
    if (!category) return res.status(400).json({ error: 'Укажите категорию' });
    if (!Number.isFinite(percent) || percent < 0 || percent > 60) return res.status(400).json({ error: 'Ставка должна быть от 0 до 60%' });
    store.setRate(category, Math.round(percent * 100) / 100, req.user);
    res.json({ ok: true, rev: store.rev() });
  });

  api.delete('/rates', (req, res) => {
    store.removeRate(String(req.query.category || ''), req.user);
    res.json({ ok: true, rev: store.rev() });
  });

  // Пересчёт комиссии у приблизительных продаж Kaspi по текущим ставкам
  api.post('/rates/recalc', (req, res) => {
    const rates = new Map(store.rates().map((r) => [r.category, r.percent]));
    const patches = store.all()
      .filter((e) => e.kind === 'sale' && e.estimated && e.source === 'kaspi' && rates.has(e.category))
      .map((e) => ({ id: e.id, commission: Math.round((e.amount * rates.get(e.category)) ) / 100, delivery: e.delivery, estimated: 1 }));
    store.patchMany(patches, req.user, 'Пересчёт комиссии по ставкам категорий');
    res.json({ updated: patches.length, rev: store.rev() });
  });

  // --- сверка с реальной выплатой Kaspi ---
  api.post('/reconcile', (req, res) => {
    const { from, to, actualNet, channel } = req.body || {};
    const net = Number(String(actualNet).replace(/\s/g, '').replace(',', '.'));
    if (!isValidDate(from) || !isValidDate(to) || from > to) return res.status(400).json({ error: 'Некорректный период' });
    if (!Number.isFinite(net) || net < 0) return res.status(400).json({ error: 'Укажите сумму выплаты' });
    const plan = planReconcile(store.all(), { from, to, actualNet: net, channel: channel || null });
    if (plan.error) return res.status(400).json({ error: plan.error });
    if (req.query.dryRun === '1') return res.json({ dryRun: true, count: plan.count, netBefore: plan.netBefore, netAfter: plan.netAfter, difference: plan.difference });
    store.patchMany(plan.patches, req.user, `Сверка с выплатой Kaspi ${from}…${to}`);
    res.json({ count: plan.count, netBefore: plan.netBefore, netAfter: plan.netAfter, difference: plan.difference, rev: store.rev() });
  });

  // --- синхронизация с Kaspi Магазином ---
  api.get('/kaspi/status', (req, res) => {
    let last = null;
    try { last = JSON.parse(store.getSetting('kaspi_last') || 'null'); } catch { /* пусто */ }
    res.json({ configured: !!kaspiCfg.token, last });
  });

  api.post('/kaspi/sync', async (req, res) => {
    try {
      const result = await kaspiSync({ days: Math.min(Number(req.query.days) || 30, 90), dryRun: req.query.dryRun === '1' });
      res.json({ ...result, rev: store.rev() });
    } catch (err) { res.status(502).json({ error: err.message }); }
  });

  api.use((req, res) => res.status(404).json({ error: 'Не найдено' }));
  app.use('/api', api);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.status < 500 ? err.message : 'Ошибка сервера' });
  });

  return { app, store, kaspiSync };
}

module.exports = { createApp };
