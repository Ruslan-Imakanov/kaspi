'use strict';

/**
 * Ядро API без привязки к рантайму: одно и то же работает под Express (Node) и внутри
 * Cloudflare Durable Object. Адаптер собирает запрос, ядро возвращает { status, headers, json | body }.
 *
 * req: { method, path, query: URLSearchParams, headers: { cookie, origin, host }, ip, secure, raw?: Uint8Array }
 */

const crypto = require('node:crypto');
const { createAuth, sessionCookie, clearCookie } = require('./auth');
const { normalize, KIND_LABELS, CHANNEL_LABELS, CATEGORIES, isValidDate } = require('./entries');
const { computeStats } = require('./stats');
const { buildWorkbook } = require('./export');
const { parseWorkbook, dedupe } = require('./import');
const { suggestDeductions } = require('./suggest');
const { pendingFor, suggestRecurring } = require('./recurring');
const { planReconcile } = require('./reconcile');
const { fetchOrders, mapOrders } = require('./kaspi');

const KASPI_BASE = 'https://kaspi.kz/shop/api/v2';
const KASPI_USER = 'Kaspi API';
const JSON_LIMIT = 100 * 1024;
const IMPORT_LIMIT = 10 * 1024 * 1024;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const json = (data, status = 200, headers = {}) => ({ status, json: data, headers });
const fail = (status, error) => json({ error }, status);

function createCore({ store, users, kaspi = {}, tz = 'Asia/Almaty' }) {
  const kaspiCfg = {
    token: kaspi.token || '',
    base: kaspi.base || KASPI_BASE,
    fetchImpl: kaspi.fetchImpl || ((...a) => fetch(...a)),
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

  // ---------- маршруты ----------
  const routes = [];
  const route = (method, pattern, handler, { open = false } = {}) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler, open });
  };

  const rangeOf = (q) => {
    const from = q.get('from') || null;
    const to = q.get('to') || null;
    if ((from && !isValidDate(from)) || (to && !isValidDate(to))) return { error: 'Некорректный период' };
    return { from, to };
  };
  const todayOf = (q) => (isValidDate(String(q.get('today'))) ? q.get('today') : new Date().toISOString().slice(0, 10));

  route('GET', '/healthz', () => json({ ok: true }), { open: true });

  route('POST', '/api/login', (c) => {
    const { name, password } = c.body;
    const r = auth.login({ ip: c.req.ip, name, password });
    if (r.error) return fail(r.status, r.error);
    return json({ user: r.user }, 200, { 'Set-Cookie': sessionCookie(r.token, c.req.secure) });
  }, { open: true });

  route('POST', '/api/logout', (c) => json({ ok: true }, 200, { 'Set-Cookie': clearCookie(c.req.secure) }), { open: true });

  route('GET', '/api/me', (c) => json({ user: c.user }));

  route('GET', '/api/meta', (c) => json({
    user: c.user, users: users.map((u) => u.name),
    kinds: KIND_LABELS, channels: CHANNEL_LABELS, categories: CATEGORIES, rev: store.rev(),
  }));

  route('GET', '/api/rev', () => json({ rev: store.rev() }));

  route('GET', '/api/entries', (c) => {
    const r = rangeOf(c.query);
    if (r.error) return fail(400, r.error);
    const kind = c.query.get('kind'); const channel = c.query.get('channel');
    const needle = (c.query.get('q') || '').toLowerCase();
    const list = store.all().filter((e) =>
      (!r.from || e.date >= r.from) && (!r.to || e.date <= r.to) &&
      (!kind || e.kind === kind) && (!channel || e.channel === channel) &&
      (!needle || `${e.category} ${e.note} ${e.amount} ${e.created_by}`.toLowerCase().includes(needle)));
    return json({ entries: list, rev: store.rev() });
  });

  route('POST', '/api/entries', (c) => {
    const r = normalize(c.body);
    if (r.error) return fail(400, r.error);
    return json({ entry: store.insert(r.value, c.user), rev: store.rev() }, 201);
  });

  route('PUT', '/api/entries/:id', (c) => {
    const r = normalize(c.body);
    if (r.error) return fail(400, r.error);
    const entry = store.update(Number(c.params.id), r.value, c.user);
    return entry ? json({ entry, rev: store.rev() }) : fail(404, 'Запись не найдена');
  });

  route('DELETE', '/api/entries/:id', (c) => (
    store.remove(Number(c.params.id), c.user) ? json({ ok: true, rev: store.rev() }) : fail(404, 'Запись не найдена')));

  route('GET', '/api/stats', (c) => {
    const r = rangeOf(c.query);
    if (r.error) return fail(400, r.error);
    return json({ ...computeStats(store.all(), r.from, r.to), rev: store.rev() });
  });

  route('GET', '/api/activity', () => json({ activity: store.activity(100) }));

  route('GET', '/api/export.xlsx', async (c) => {
    const r = rangeOf(c.query);
    if (r.error) return fail(400, r.error);
    const wb = await buildWorkbook(store.all(), r.from, r.to);
    const body = await wb.xlsx.writeBuffer();
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      status: 200, body,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="kaspi-uchet-${stamp}.xlsx"`,
        'Cache-Control': 'no-store',
      },
    };
  });

  // Импорт .xlsx в формате вашей таблицы. ?dryRun=1 — только предпросмотр.
  route('POST', '/api/import', async (c) => {
    if (!c.req.raw?.length) return fail(400, 'Файл не получен');
    try {
      const parsed = await parseWorkbook(Buffer.from(c.req.raw));
      const { fresh, duplicates } = dedupe(parsed.entries, store.all());
      const result = {
        found: parsed.entries.length, added: fresh.length, duplicates,
        ignored: parsed.ignored, errors: parsed.errors.slice(0, 10),
      };
      if (c.query.get('dryRun') === '1') return json({ ...result, dryRun: true });
      if (fresh.length) store.insertMany(fresh.map((e) => ({ ...e, source: 'import' })), c.user, 'Импорт из Excel');
      return json({ ...result, rev: store.rev() });
    } catch (err) {
      return fail(400, `Не удалось прочитать файл: ${err.message}`);
    }
  });

  // --- подсказка комиссии и доставки по истории ---
  route('GET', '/api/suggest', (c) => json({
    suggestion: suggestDeductions(store.all(), {
      amount: c.query.get('amount'), channel: c.query.get('channel') || 'shop', category: c.query.get('category') || '',
    }, store.rates()),
  }));

  // --- регулярные платежи ---
  route('GET', '/api/pending', (c) => {
    const all = store.all();
    return json({ pending: pendingFor(store.recurring(), all, todayOf(c.query)), review: all.filter((e) => e.estimated).length });
  });

  route('GET', '/api/recurring', () => {
    const list = store.recurring();
    return json({ recurring: list, suggestions: suggestRecurring(store.all(), list) });
  });

  route('POST', '/api/recurring', (c) => {
    const b = c.body;
    const r = normalize({ date: '2000-01-01', kind: b.kind, category: b.category, amount: b.amount, note: b.note });
    const day = Number(b.day);
    if (r.error) return fail(400, r.error);
    if (!['expense', 'withdrawal', 'topup'].includes(r.value.kind)) return fail(400, 'Для регулярных платежей: расход, снятие или пополнение');
    if (!r.value.category) return fail(400, 'Укажите категорию');
    if (!Number.isInteger(day) || day < 1 || day > 31) return fail(400, 'День месяца: от 1 до 31');
    const id = store.addRecurring({ kind: r.value.kind, category: r.value.category, amount: r.value.amount, day, note: r.value.note }, c.user);
    return json({ id, rev: store.rev() }, 201);
  });

  route('PUT', '/api/recurring/:id', (c) => {
    store.setRecurringActive(Number(c.params.id), !!c.body.active, c.user);
    return json({ ok: true, rev: store.rev() });
  });

  route('DELETE', '/api/recurring/:id', (c) => {
    store.removeRecurring(Number(c.params.id), c.user);
    return json({ ok: true, rev: store.rev() });
  });

  // Внести платёж за месяц одним нажатием (повторно тот же месяц не внесётся)
  route('POST', '/api/pending/confirm', (c) => {
    const { id, month, amount, date } = c.body;
    const rec = store.recurring().find((r) => r.id === Number(id));
    if (!rec) return fail(404, 'Платёж не найден');
    if (!/^\d{4}-\d{2}$/.test(String(month))) return fail(400, 'Некорректный месяц');
    const day = Math.min(rec.day, new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate());
    const r = normalize({
      date: date || `${month}-${String(day).padStart(2, '0')}`, kind: rec.kind, category: rec.category,
      amount: amount ?? rec.amount, note: rec.note, source: 'recurring', recurring_key: `${rec.id}:${month}`,
    }, { trusted: true });
    if (r.error) return fail(400, r.error);
    const entry = store.insertUnique(r.value, c.user);
    return entry ? json({ entry, rev: store.rev() }, 201) : fail(409, 'За этот месяц уже внесено');
  });

  // --- ставки комиссии по категориям ---
  route('GET', '/api/rates', () => {
    let unknown = [];
    try { unknown = JSON.parse(store.getSetting('kaspi_unknown') || '[]'); } catch { /* пусто */ }
    const have = new Set(store.rates().map((r) => r.category));
    return json({ rates: store.rates(), unknown: unknown.filter((u) => !have.has(u.category)) });
  });

  route('PUT', '/api/rates', (c) => {
    const category = String(c.body.category ?? '').trim().slice(0, 80);
    const percent = Number(String(c.body.percent).replace(',', '.'));
    if (!category) return fail(400, 'Укажите категорию');
    if (!Number.isFinite(percent) || percent < 0 || percent > 60) return fail(400, 'Ставка должна быть от 0 до 60%');
    store.setRate(category, Math.round(percent * 100) / 100, c.user);
    return json({ ok: true, rev: store.rev() });
  });

  route('DELETE', '/api/rates', (c) => {
    store.removeRate(String(c.query.get('category') || ''), c.user);
    return json({ ok: true, rev: store.rev() });
  });

  // Пересчёт комиссии у приблизительных продаж Kaspi по текущим ставкам
  route('POST', '/api/rates/recalc', (c) => {
    const rates = new Map(store.rates().map((r) => [r.category, r.percent]));
    const patches = store.all()
      .filter((e) => e.kind === 'sale' && e.estimated && e.source === 'kaspi' && rates.has(e.category))
      .map((e) => ({ id: e.id, commission: Math.round(e.amount * rates.get(e.category)) / 100, delivery: e.delivery, estimated: 1 }));
    store.patchMany(patches, c.user, 'Пересчёт комиссии по ставкам категорий');
    return json({ updated: patches.length, rev: store.rev() });
  });

  // --- сверка с реальной выплатой Kaspi ---
  route('POST', '/api/reconcile', (c) => {
    const { from, to, actualNet, channel } = c.body;
    const net = Number(String(actualNet).replace(/\s/g, '').replace(',', '.'));
    if (!isValidDate(from) || !isValidDate(to) || from > to) return fail(400, 'Некорректный период');
    if (!Number.isFinite(net) || net < 0) return fail(400, 'Укажите сумму выплаты');
    const plan = planReconcile(store.all(), { from, to, actualNet: net, channel: channel || null });
    if (plan.error) return fail(400, plan.error);
    const summary = { count: plan.count, netBefore: plan.netBefore, netAfter: plan.netAfter, difference: plan.difference };
    if (c.query.get('dryRun') === '1') return json({ dryRun: true, ...summary });
    store.patchMany(plan.patches, c.user, `Сверка с выплатой Kaspi ${from}…${to}`);
    return json({ ...summary, rev: store.rev() });
  });

  // --- синхронизация с Kaspi Магазином ---
  route('GET', '/api/kaspi/status', () => {
    let last = null;
    try { last = JSON.parse(store.getSetting('kaspi_last') || 'null'); } catch { /* пусто */ }
    return json({ configured: !!kaspiCfg.token, last });
  });

  route('POST', '/api/kaspi/sync', async (c) => {
    try {
      const result = await kaspiSync({ days: Math.min(Number(c.query.get('days')) || 30, 90), dryRun: c.query.get('dryRun') === '1' });
      return json({ ...result, rev: store.rev() });
    } catch (err) { return fail(502, err.message); }
  });

  // ---------- обработка запроса ----------
  async function handle(req) {
    try {
      const method = req.method.toUpperCase();
      // Защита от CSRF: изменяющие запросы принимаем только с того же origin
      if (['POST', 'PUT', 'DELETE'].includes(method) && req.headers.origin) {
        let host = '';
        try { host = new URL(req.headers.origin).host; } catch { /* некорректный Origin */ }
        if (host !== req.headers.host) return fail(403, 'Запрещено');
      }

      const found = routes.find((r) => r.method === method && r.re.test(req.path));
      if (!found) return req.path.startsWith('/api/') ? fail(404, 'Не найдено') : null;

      let user = null;
      if (!found.open) {
        user = auth.userFrom(req.headers.cookie);
        if (!user) return fail(401, 'Требуется вход');
      }

      const m = found.re.exec(req.path);
      const params = Object.fromEntries(found.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const isUpload = req.path === '/api/import';
      const size = req.raw?.length ?? 0;
      if (size > (isUpload ? IMPORT_LIMIT : JSON_LIMIT)) return fail(413, 'Слишком большой запрос');

      const ctx = {
        req, user, params, query: req.query,
        get body() {
          if (!size || isUpload) return {};
          try { return JSON.parse(new TextDecoder().decode(req.raw)) || {}; } catch { throw new HttpError(400, 'Некорректный JSON'); }
        },
      };
      return await found.handler(ctx);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.message);
      console.error(err);
      return fail(500, 'Ошибка сервера');
    }
  }

  return { handle, kaspiSync };
}

module.exports = { createCore, SECURITY_HEADERS };
