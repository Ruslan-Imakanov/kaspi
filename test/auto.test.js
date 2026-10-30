'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server/app');
const { suggestDeductions } = require('../server/suggest');
const { pendingFor, suggestRecurring } = require('../server/recurring');

const USERS = [{ name: 'Руслан', password: 'p1' }, { name: 'Айгуль', password: 'p2' }];

async function boot(t, kaspi) {
  const { app, store, kaspiSync } = createApp({ dbFile: ':memory:', users: USERS, kaspi });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Руслан', password: 'p1' }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { call, store, kaspiSync };
}

const sale = (o) => ({ kind: 'sale', channel: 'shop', commission: 0, delivery: 0, packaging: 0, label: 0, estimated: 0, ...o });

test('подсказка: комиссия и доставка по ближайшим продажам из истории', () => {
  const hist = [
    sale({ amount: 1380, commission: 214.01, delivery: 173 }),
    sale({ amount: 1290, commission: 200.06, delivery: 173 }),
    sale({ amount: 1380, commission: 214.01, delivery: 173 }),
    sale({ amount: 5480, commission: 849.84, delivery: 404 }),
    sale({ amount: 6500, commission: 1008.02, delivery: 404 }),
    sale({ amount: 14380, commission: 1837.97, delivery: 2144 }),
  ];
  const s = suggestDeductions(hist, { amount: 1380 });
  assert.equal(s.delivery, 173);
  assert.ok(Math.abs(s.commission - 214.01) < 1, `commission ${s.commission}`);
  assert.equal(suggestDeductions(hist.slice(0, 2), { amount: 1000 }), null, 'мало истории — не гадаем');
  assert.equal(suggestDeductions(hist, { amount: 0 }), null);
  // приблизительные продажи не учатся друг у друга
  assert.equal(suggestDeductions(hist.map((e) => ({ ...e, estimated: 1 })), { amount: 1380 }), null);
  // ставка категории важнее истории
  const r = suggestDeductions(hist, { amount: 1000, category: 'Чехлы' }, [{ category: 'Чехлы', percent: 12.5 }]);
  assert.equal(r.commission, 125);
  assert.equal(r.basis, 'rate');
});

test('регулярные платежи: ожидаемые, просроченные, предложения из истории', () => {
  const rec = [
    { id: 1, kind: 'expense', category: 'Соц. отчисления', amount: 21675, day: 15, note: '', active: 1 },
    { id: 2, kind: 'expense', category: 'Налог', amount: 3289, day: 31, note: '', active: 1 },
    { id: 3, kind: 'expense', category: 'Выключен', amount: 1, day: 1, note: '', active: 0 },
  ];
  const p = pendingFor(rec, [{ recurring_key: '1:2026-01' }], '2026-02-20'); // январский платёж не мешает февральскому
  assert.deepEqual(p.map((x) => [x.id, x.status, x.dueDate]), [[1, 'overdue', '2026-02-15'], [2, 'later', '2026-02-28']]);
  assert.equal(pendingFor(rec, [{ recurring_key: '1:2026-02' }, { recurring_key: '2:2026-02' }], '2026-02-20').length, 0);

  const hist = [
    { kind: 'expense', category: 'Соц. отчисления', amount: 21675, date: '2026-08-23' },
    { kind: 'expense', category: 'Соц. отчисления', amount: 21675, date: '2026-09-18' },
    { kind: 'expense', category: 'Соц. отчисления', amount: 21675, date: '2026-10-15' },
    { kind: 'expense', category: 'Упаковка', amount: 7500, date: '2026-10-20' },
  ];
  const sug = suggestRecurring(hist, []);
  assert.equal(sug.length, 1);
  assert.deepEqual([sug[0].category, sug[0].day, sug[0].months], ['Соц. отчисления', 18, 3]);
  assert.equal(suggestRecurring(hist, [{ category: 'Соц. отчисления', amount: 21675 }]).length, 0);
});

test('API: регулярный платёж вносится одним нажатием и только один раз за месяц', async (t) => {
  const { call } = await boot(t);
  assert.equal((await call('POST', '/api/recurring', { kind: 'expense', category: 'Налог', amount: 3289, day: 18 })).status, 201);
  assert.equal((await call('POST', '/api/recurring', { kind: 'sale', category: 'x', amount: 1, day: 1 })).status, 400);
  assert.equal((await call('POST', '/api/recurring', { kind: 'expense', category: 'x', amount: 1, day: 40 })).status, 400);

  const p = (await call('GET', '/api/pending?today=2026-10-17')).body.pending;
  assert.equal(p.length, 1);
  assert.equal(p[0].status, 'soon');

  const ok = await call('POST', '/api/pending/confirm', { id: p[0].id, month: '2026-10' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.entry.date, '2026-10-18');
  assert.equal(ok.body.entry.source, 'recurring');
  assert.equal((await call('POST', '/api/pending/confirm', { id: p[0].id, month: '2026-10' })).status, 409);
  assert.equal((await call('GET', '/api/pending?today=2026-10-17')).body.pending.length, 0);
  assert.equal((await call('GET', '/api/pending?today=2026-11-01')).body.pending.length, 1, 'в новом месяце снова ожидается');
});

test('API: подсказка помечает значения как приблизительные, ручной ввод — нет', async (t) => {
  const { call } = await boot(t);
  for (const [a, c, d] of [[1380, 214.01, 173], [1290, 200.06, 173], [1380, 214.01, 173]])
    await call('POST', '/api/entries', { date: '2026-10-01', kind: 'sale', amount: a, commission: c, delivery: d });
  const s = (await call('GET', '/api/suggest?amount=1380&channel=shop')).body.suggestion;
  assert.equal(s.delivery, 173);
  const e = (await call('POST', '/api/entries', { date: '2026-10-02', kind: 'sale', amount: 1380, commission: s.commission, delivery: s.delivery, estimated: true })).body.entry;
  assert.equal(e.estimated, 1);
  const manual = (await call('POST', '/api/entries', { date: '2026-10-02', kind: 'sale', amount: 1380, commission: 214.01, delivery: 173 })).body.entry;
  assert.equal(manual.estimated, 0);
  // клиент не может подделать источник
  const forged = (await call('POST', '/api/entries', { date: '2026-10-02', kind: 'expense', amount: 5, source: 'kaspi', external_id: 'X1' })).body.entry;
  assert.equal(forged.source, 'manual');
  assert.equal(forged.external_id, null);
});

test('сверка с выплатой: итог совпадает до копейки, сверенные продажи не трогаем', async (t) => {
  const { call } = await boot(t);
  const add = (b) => call('POST', '/api/entries', { kind: 'sale', date: '2026-10-05', ...b });
  await add({ amount: 1000, commission: 150, delivery: 50 });                                  // сверена вручную: чистыми 800
  await add({ amount: 2000, commission: 300, delivery: 100, estimated: true });                // 1600 (≈)
  await add({ amount: 3000, commission: 450, delivery: 100, estimated: true });                // 2450 (≈)
  const before = 800 + 1600 + 2450;
  const dry = (await call('POST', '/api/reconcile?dryRun=1', { from: '2026-10-01', to: '2026-10-07', actualNet: 4700 })).body;
  assert.equal(dry.netBefore, before);
  assert.equal(dry.difference, 4700 - before);
  assert.equal((await call('GET', '/api/entries')).body.entries.filter((e) => e.estimated).length, 2, 'dryRun не пишет');

  const done = await call('POST', '/api/reconcile', { from: '2026-10-01', to: '2026-10-07', actualNet: 4700 });
  assert.equal(done.status, 200);
  const list = (await call('GET', '/api/entries')).body.entries;
  assert.equal(list.filter((e) => e.estimated).length, 0);
  const net = list.reduce((a, e) => a + e.amount - e.commission - e.delivery, 0);
  assert.equal(Math.round(net * 100) / 100, 4700);
  const kept = list.find((e) => e.amount === 1000);
  assert.deepEqual([kept.commission, kept.delivery], [150, 50]);

  assert.equal((await call('POST', '/api/reconcile', { from: '2026-10-01', to: '2026-10-07', actualNet: 4700 })).status, 400, 'приблизительных больше нет');
  assert.equal((await call('POST', '/api/reconcile', { from: '2026-10-07', to: '2026-10-01', actualNet: 1 })).status, 400);
});

// ---- Kaspi API: поддельный сервер в формате JSON:API ----
function mockKaspi(orders, seen) {
  const server = http.createServer((req, res) => {
    seen.push({ url: decodeURIComponent(req.url), token: req.headers['x-auth-token'] });
    if (req.headers['x-auth-token'] !== 'good-token') { res.writeHead(401); return res.end('no'); }
    const included = [];
    const q = decodeURIComponent(req.url);
    const ge = Number(/\$ge\]=(\d+)/.exec(q)?.[1] ?? 0);
    const le = Number(/\$le\]=(\d+)/.exec(q)?.[1] ?? Infinity);
    const data = orders.filter((o) => o.at >= ge && o.at <= le).map((o) => {
      o.items.forEach((it, i) => included.push({ type: 'orderentries', id: `${o.code}-${i}`, attributes: { quantity: 1, totalPrice: it.total, basePrice: it.total, category: { code: it.cat, title: it.cat } } }));
      return { type: 'orders', id: `id-${o.code}`, attributes: { code: o.code, totalPrice: o.total, creationDate: o.at, state: 'ARCHIVE', status: o.status || 'COMPLETED' },
        relationships: { entries: { data: o.items.map((_, i) => ({ type: 'orderentries', id: `${o.code}-${i}` })) } } };
    });
    res.writeHead(200, { 'content-type': 'application/vnd.api+json' });
    res.end(JSON.stringify({ data, included, meta: { pageCount: 1, totalCount: data.length } }));
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

test('Kaspi: синхронизация завершённых заказов, ставки категорий, повторы, возвраты', async (t) => {
  const NOW = Date.parse('2026-10-30T09:00:00Z');
  const seen = [];
  const orders = [
    { code: '1001', total: 2400, at: Date.parse('2026-10-28T20:30:00Z'), items: [{ cat: 'Чехлы', total: 2400 }] },          // 29.10 по Алматы (UTC+5)
    { code: '1002', total: 5000, at: Date.parse('2026-10-25T10:00:00Z'), items: [{ cat: 'Чехлы', total: 3000 }, { cat: 'Кабели', total: 2000 }] },
    { code: '1003', total: 900, at: Date.parse('2026-10-26T10:00:00Z'), status: 'CANCELLED', items: [{ cat: 'Чехлы', total: 900 }] },
    { code: '1004', total: 1500, at: Date.parse('2026-10-27T10:00:00Z'), items: [{ cat: 'Новая', total: 1500 }] },
  ];
  const mock = await mockKaspi(orders, seen);
  t.after(() => mock.close());
  const { call, store, kaspiSync } = await boot(t, { token: 'good-token', base: `http://127.0.0.1:${mock.address().port}` });

  assert.equal((await call('GET', '/api/kaspi/status')).body.configured, true);
  await call('PUT', '/api/rates', { category: 'Чехлы', percent: '12,5' });
  await call('PUT', '/api/rates', { category: 'Кабели', percent: 10 });
  assert.equal((await call('PUT', '/api/rates', { category: 'x', percent: 99 })).status, 400);

  const dry = await call('POST', '/api/kaspi/sync?dryRun=1');
  assert.equal(dry.status, 200);
  assert.equal(dry.body.added, 3, 'отменённый заказ не считается продажей');
  assert.equal((await call('GET', '/api/entries')).body.entries.length, 0, 'dryRun ничего не пишет');
  assert.ok(seen[0].url.includes('filter[orders][state]=ARCHIVE') && seen[0].url.includes('include[orders]=entries'));
  assert.equal(seen[0].token, 'good-token');

  const r = await call('POST', '/api/kaspi/sync');
  assert.equal(r.body.added, 3);
  const list = (await call('GET', '/api/entries')).body.entries;
  const e1 = list.find((e) => e.external_id === '1001');
  assert.deepEqual([e1.date, e1.amount, e1.commission, e1.estimated, e1.source, e1.created_by], ['2026-10-29', 2400, 300, 1, 'kaspi', 'Kaspi API']);
  assert.equal(list.find((e) => e.external_id === '1002').commission, 375 + 200, 'комиссия по позициям: 12.5% от 3000 + 10% от 2000');
  assert.deepEqual((await call('GET', '/api/rates')).body.unknown, [{ category: 'Новая', count: 1 }]);

  const again = await call('POST', '/api/kaspi/sync');
  assert.equal(again.body.added, 0, 'повторная синхронизация не плодит дубли');
  assert.equal((await call('GET', '/api/entries')).body.entries.length, 3);

  // ставка для новой категории + пересчёт приблизительных
  await call('PUT', '/api/rates', { category: 'Новая', percent: 20 });
  assert.equal((await call('POST', '/api/rates/recalc')).body.updated, 3);
  assert.equal((await call('GET', '/api/entries')).body.entries.find((e) => e.external_id === '1004').commission, 300);

  // возврат уже внесённого заказа помечается, а не удаляется молча
  orders[0].status = 'RETURNED';
  const s3 = await call('POST', '/api/kaspi/sync');
  assert.equal(s3.body.returned, 1);
  const flagged = (await call('GET', '/api/entries')).body.entries.find((e) => e.external_id === '1001');
  assert.match(flagged.note, /ВОЗВРАТ/);
  assert.equal(flagged.estimated, 1);
  assert.equal(typeof kaspiSync, 'function');
});

test('Kaspi: неверный токен — понятная ошибка, без токена — не настроено', async (t) => {
  const mock = await mockKaspi([], []);
  t.after(() => mock.close());
  const bad = await boot(t, { token: 'wrong', base: `http://127.0.0.1:${mock.address().port}` });
  const r = await bad.call('POST', '/api/kaspi/sync');
  assert.equal(r.status, 502);
  assert.match(r.body.error, /не принял токен/);
  assert.equal((await bad.call('GET', '/api/kaspi/status')).body.last.ok, false);

  const none = await boot(t, {});
  assert.equal((await none.call('GET', '/api/kaspi/status')).body.configured, false);
  assert.equal((await none.call('POST', '/api/kaspi/sync')).status, 502);
});
