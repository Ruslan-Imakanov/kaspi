'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { createApp } = require('../server/app');
const { computeStats } = require('../server/stats');

async function boot(t) {
  const { app } = createApp({ dbFile: ':memory:', users: [{ name: 'Руслан', password: 'p1' }, { name: 'Айгуль', password: 'p2' }] });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (name, password) => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password }) });
    return { res, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  const call = (cookie) => async (method, url, body, extra = {}) => {
    const res = await fetch(base + url, {
      method, headers: { cookie, ...(body ? { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' } : {}) },
      body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined, ...extra,
    });
    return res;
  };
  return { server, base, login, call };
}

test('вход обязателен, неверный пароль отклоняется', async (t) => {
  const { server, base, login } = await boot(t);
  assert.equal((await fetch(`${base}/api/entries`)).status, 401);
  assert.equal((await login('Руслан', 'bad')).res.status, 401);
  const ok = await login('руслан', 'p1'); // имя без учёта регистра
  assert.equal(ok.res.status, 200);
});

test('два пользователя видят одни и те же данные; автор записывается', async (t) => {
  const { server, login, call } = await boot(t);
  const a = call((await login('Руслан', 'p1')).cookie);
  const b = call((await login('Айгуль', 'p2')).cookie);

  const r1 = await a('POST', '/api/entries', { date: '2026-10-01', kind: 'sale', channel: 'shop', amount: 2400, commission: 386.11, delivery: 173 });
  assert.equal(r1.status, 201);
  const r2 = await b('POST', '/api/entries', { date: '2026-10-02', kind: 'expense', category: 'Налог', amount: 3289 });
  assert.equal(r2.status, 201);

  const list = (await (await a('GET', '/api/entries')).json()).entries;
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((e) => e.created_by).sort(), ['Айгуль', 'Руслан']);

  const id = (await r1.json()).entry.id;
  const upd = await b('PUT', `/api/entries/${id}`, { date: '2026-10-01', kind: 'sale', channel: 'shop', amount: 2500, commission: 386.11, delivery: 173 });
  assert.equal((await upd.json()).entry.updated_by, 'Айгуль');
  assert.equal((await b('DELETE', `/api/entries/${id}`)).status, 200);
  assert.equal((await b('DELETE', `/api/entries/${id}`)).status, 404);

  const log = (await (await a('GET', '/api/activity')).json()).activity;
  assert.deepEqual(log.map((x) => x.action), ['delete', 'update', 'create', 'create']);
});

test('валидация отклоняет плохие данные', async (t) => {
  const { server, login, call } = await boot(t);
  const a = call((await login('Руслан', 'p1')).cookie);
  for (const bad of [
    { date: '2026-13-40', kind: 'sale', amount: 10 },
    { date: '2026-10-01', kind: 'sale', amount: 0 },
    { date: '2026-10-01', kind: 'sale', amount: -5 },
    { date: '2026-10-01', kind: 'nope', amount: 5 },
    { date: '2026-10-01', kind: 'sale', channel: 'x', amount: 5 },
    { date: '2026-10-01', kind: 'sale', amount: 100, commission: 9999 },
  ]) assert.equal((await a('POST', '/api/entries', bad)).status, 400, JSON.stringify(bad));
  // десятичная запятая принимается
  assert.equal((await a('POST', '/api/entries', { date: '2026-10-01', kind: 'sale', amount: '1 380,50', commission: '214,01' })).status, 201);
});

test('аналитика: чистыми, прибыль, остаток, сравнение с прошлым периодом', () => {
  const mk = (o) => ({ id: 1, channel: null, category: '', note: '', commission: 0, delivery: 0, packaging: 0, label: 0, ...o });
  const all = [
    mk({ date: '2026-09-05', kind: 'sale', channel: 'shop', amount: 1380, commission: 214.01, delivery: 173 }),
    mk({ date: '2026-10-01', kind: 'sale', channel: 'shop', amount: 2400, commission: 386.11, delivery: 173 }),
    mk({ date: '2026-10-02', kind: 'sale', channel: 'pay', amount: 1000, commission: 9.5 }),
    mk({ date: '2026-10-03', kind: 'expense', category: 'Налог', amount: 3289 }),
    mk({ date: '2026-10-04', kind: 'withdrawal', category: 'Займ себе', amount: 5000 }),
    mk({ date: '2026-10-05', kind: 'topup', category: 'Возврат займа', amount: 4000 }),
  ];
  const s = computeStats(all, '2026-10-01', '2026-10-31');
  assert.equal(s.summary.revenue, 3400);
  assert.equal(s.summary.netSales, 2831.39);
  assert.equal(s.summary.expenses, 3289);
  assert.equal(s.summary.profit, -457.61); // снятия не уменьшают прибыль
  assert.equal(s.summary.withdrawals, 5000);
  assert.equal(s.summary.byChannel.pay.revenue, 1000);
  assert.equal(s.series.length, 31); // дни без операций заполнены нулями
  assert.equal(s.prev.revenue, 1380); // предыдущий период: 31 авг – 30 сен
  assert.equal(s.balance, -464.62);
});

test('экспорт в Excel: листы, формулы и итоги', async (t) => {
  const { server, login, call } = await boot(t);
  const a = call((await login('Руслан', 'p1')).cookie);
  await a('POST', '/api/entries', { date: '2026-10-01', kind: 'sale', channel: 'shop', amount: 2400, commission: 386.11, delivery: 173 });
  await a('POST', '/api/entries', { date: '2026-10-02', kind: 'expense', category: 'Налог', amount: 3289 });
  const res = await a('GET', '/api/export.xlsx?from=2026-10-01&to=2026-10-31');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /\.xlsx/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Операции', 'По месяцам', 'Расходы по категориям']);
  const ops = wb.getWorksheet('Операции');
  assert.equal(ops.getCell('B2').value, 'Продажа');
  assert.equal(ops.getCell('K2').value.formula, 'F2-G2-H2-I2-J2');
  assert.equal(ops.getCell('K2').value.result, 1840.89);
  assert.equal(ops.getCell('K3').value.result, -3289);
  assert.equal(wb.getWorksheet('По месяцам').getCell('B2').value, 2400);
});

async function sheetBuffer(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Лист1');
  ws.addRow(['Дата', 'Заказ/Продажа/Переводы/Начисления/Прочее', 'Сумма', 'Снятия', 'Пополнения', 'за продажи', 'доставка', 'пакет', 'этикетка']);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('импорт таблицы в формате пользователя + защита от дублей', async (t) => {
  const { server, login, call } = await boot(t);
  const a = call((await login('Руслан', 'p1')).cookie);
  const d = (s) => new Date(`${s}T00:00:00Z`);
  const buf = await sheetBuffer([
    [d('2025-07-03'), 'наши "покупки"', 1000, null, null, 9.5],
    [d('2025-07-07'), null, 0, null, null, 0],                      // пустой день
    [d('2025-07-15'), 'Перевод с каспи пэй', null, 12000],
    [d('2026-09-05'), 'Продажа', 1380, null, null, 214.01, 173],
    [d('2026-09-06'), 'Абонентская плата за август', null, 1950],
    [d('2026-09-18'), 'Пополнение на платежи', null, null, 50000],
    [d('2026-09-18'), 'Налог', null, 3289],
    [d('2026-09-29'), 'Одолжила себе на продукты', null, 4000],
    [d('2026-10-10'), 'Вернула', null, null, 27280],
    [d('2026-10-20'), 'Снятие на пупырку', null, 7500],
    [d('2026-08-28'), 'Снятие Руслану', 0, 5600, null, 0],
    [null, null, 22520, 20000, null, 213.96],                       // итоговая строка
    ['10/5/2026', 'Продажа', 6500, null, null, 1008.02, 927],        // дата строкой M/D/YYYY
  ]);

  const dry = await (await a('POST', '/api/import?dryRun=1', buf)).json();
  assert.equal(dry.added, 11);
  assert.equal(dry.dryRun, true);
  assert.equal((await (await a('GET', '/api/entries')).json()).entries.length, 0, 'dryRun ничего не пишет');

  const done = await (await a('POST', '/api/import', buf)).json();
  assert.equal(done.added, 11);
  const again = await (await a('POST', '/api/import', buf)).json();
  assert.equal(again.added, 0);
  assert.equal(again.duplicates, 11);

  const entries = (await (await a('GET', '/api/entries')).json()).entries;
  const by = (f) => entries.find(f);
  assert.equal(by((e) => e.date === '2025-07-03').channel, 'pay');
  assert.equal(by((e) => e.date === '2026-09-05').channel, 'shop');
  assert.equal(by((e) => e.date === '2026-09-05').delivery, 173);
  assert.equal(by((e) => e.date === '2025-07-15').kind, 'withdrawal');
  assert.equal(by((e) => e.category === 'Налог').kind, 'expense');
  assert.equal(by((e) => e.category === 'Упаковка').amount, 7500);
  assert.equal(by((e) => e.category === 'Займ себе').kind, 'withdrawal');
  assert.equal(by((e) => e.category === 'Возврат займа').kind, 'topup');
  assert.equal(by((e) => e.date === '2026-10-05').amount, 6500);
  assert.equal(by((e) => e.note === 'Снятие Руслану').category, 'Снятие владельцу');
});

test('импорт: понятная ошибка для файла без заголовков', async (t) => {
  const { server, login, call } = await boot(t);
  const a = call((await login('Руслан', 'p1')).cookie);
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('x').addRow(['a', 'b']);
  const res = await a('POST', '/api/import', Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /заголовков/);
});

test('«приблизительно» не ставится без удержаний', async (t) => {
  const { login, call } = await boot(t);
  const a = call((await login('Руслан', 'p1')).cookie);
  const e = (await (await a('POST', '/api/entries', { date: '2026-10-01', kind: 'sale', amount: 1000, estimated: true })).json()).entry;
  assert.equal(e.estimated, 0);
  const e2 = (await (await a('POST', '/api/entries', { date: '2026-10-01', kind: 'sale', amount: 1000, commission: 100, estimated: true })).json()).entry;
  assert.equal(e2.estimated, 1);
});
