'use strict';
// Дымовой тест развёрнутого воркера: BASE=http://localhost:8787 USERS="Руслан:password1,Айгуль:password2" node scripts/worker-smoke.js
const ExcelJS = require('exceljs');
const base = process.env.BASE || 'http://localhost:8787';
const [u1, p1] = (process.env.USER1 || 'Руслан:password1').split(':');
const [u2, p2] = (process.env.USER2 || 'Айгуль:password2').split(':');
let failed = 0;
const ok = (c, m) => { console.log(c ? 'OK  ' : 'FAIL', m); if (!c) failed++; };

async function login(name, password) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password }) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0], setCookie: r.headers.get('set-cookie') || '' };
}
const call = (cookie) => async (method, url, body, extraHeaders = {}) => {
  const isBuf = body instanceof Uint8Array;
  const res = await fetch(base + url, { method, headers: { cookie, ...(body ? { 'content-type': isBuf ? 'application/octet-stream' : 'application/json' } : {}), ...extraHeaders }, body: body ? (isBuf ? body : JSON.stringify(body)) : undefined });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
};

(async () => {
  const idx = await fetch(base + '/');
  ok(idx.status === 200 && (await idx.text()).includes('Kaspi Учёт'), 'главная страница отдаётся');
  ok((idx.headers.get('content-security-policy') || '').includes("default-src 'self'"), 'заголовки безопасности (CSP) на статике');
  const chart = await fetch(base + '/vendor/chart.js');
  ok(chart.status === 200 && (await chart.text()).length > 100000, 'Chart.js отдаётся локально');
  ok((await fetch(base + '/sw.js')).status === 200 && (await fetch(base + '/manifest.webmanifest')).status === 200 && (await fetch(base + '/icon-192.png')).status === 200, 'sw.js, manifest, иконки');
  ok((await (await fetch(base + '/healthz')).json()).ok === true, 'healthz');

  ok((await fetch(base + '/api/entries')).status === 401, 'API закрыт без входа');
  ok((await login(u1, 'неверный')).status === 401, 'неверный пароль отклонён');
  const a = await login(u1, p1);
  ok(a.status === 200 && /HttpOnly/.test(a.setCookie) && /Secure|SameSite=Lax/.test(a.setCookie), 'вход Руслана, cookie HttpOnly/SameSite');
  const b = await login(u2, p2);
  ok(b.status === 200, 'вход Айгуль');
  const A = call(a.cookie); const B = call(b.cookie);

  const meta = (await A('GET', '/api/meta')).body;
  ok(JSON.stringify(meta.users) === JSON.stringify([u1, u2]), 'meta: два пользователя');

  const r1 = await A('POST', '/api/entries', { date: '2026-10-01', kind: 'sale', channel: 'shop', amount: 2400, commission: 386.11, delivery: 173 });
  const r2 = await B('POST', '/api/entries', { date: '2026-10-02', kind: 'expense', category: 'Налог', amount: 3289 });
  ok(r1.status === 201 && r2.status === 201, 'запись от двух пользователей');
  const list = (await A('GET', '/api/entries')).body.entries;
  ok(list.length === 2 && new Set(list.map((e) => e.created_by)).size === 2, 'оба видят общие данные, автор записан');
  ok(list.every((e) => typeof e.amount === 'number' && typeof e.estimated === 'number'), 'типы чисел из SQLite корректны');
  ok((await A('POST', '/api/entries', { date: '2026-13-40', kind: 'sale', amount: 1 })).status === 400, 'валидация');
  ok((await A('POST', '/api/entries', { date: '2026-10-02', kind: 'expense', amount: 5 }, { origin: 'https://evil.example' })).status === 403, 'CSRF: чужой Origin отклонён');

  const upd = await B('PUT', `/api/entries/${r1.body.entry.id}`, { date: '2026-10-01', kind: 'sale', channel: 'shop', amount: 2500, commission: 386.11, delivery: 173 });
  ok(upd.body.entry.updated_by === u2, 'правка записывает автора');

  const st = (await A('GET', '/api/stats?from=2026-10-01&to=2026-10-31')).body;
  ok(st.summary.revenue === 2500 && st.summary.expenses === 3289 && st.series.length === 31, 'аналитика');

  const sug = await A('GET', '/api/suggest?amount=1000&channel=shop');
  ok(sug.status === 200 && 'suggestion' in sug.body, 'подсказка (мало истории → null)');

  ok((await A('POST', '/api/recurring', { kind: 'expense', category: 'Налог', amount: 3289, day: 18 })).status === 201, 'регулярный платёж создан');
  const pend = (await A('GET', '/api/pending?today=2026-10-17')).body.pending;
  ok(pend.length === 1, 'ожидаемый платёж виден');
  const conf = await A('POST', '/api/pending/confirm', { id: pend[0].id, month: '2026-10' });
  ok(conf.status === 201, 'внесение платежа одним нажатием');
  ok((await A('POST', '/api/pending/confirm', { id: pend[0].id, month: '2026-10' })).status === 409, 'повторное внесение за месяц отклонено (уникальный индекс)');

  // Excel: выгрузка и разбор настоящим парсером
  const ex = await A('GET', '/api/export.xlsx?from=2026-10-01&to=2026-10-31');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(ex.body));
  ok(ex.status === 200 && wb.worksheets.length === 3 && wb.getWorksheet('Операции').getCell('B2').value === 'Продажа', 'выгрузка Excel: 3 листа, русские значения');

  // импорт файла в формате таблицы
  const w2 = new ExcelJS.Workbook(); const ws = w2.addWorksheet('Лист1');
  ws.addRow(['Дата', 'Заказ/Продажа/Переводы/Начисления/Прочее', 'Сумма', 'Снятия', 'Пополнения', 'за продажи', 'доставка', 'пакет', 'этикетка']);
  ws.addRow([new Date('2026-09-05T00:00:00Z'), 'Продажа', 1380, null, null, 214.01, 173]);
  ws.addRow([new Date('2026-09-06T00:00:00Z'), 'Абонентская плата за август', null, 1950]);
  const buf = new Uint8Array(await w2.xlsx.writeBuffer());
  const dry = (await A('POST', '/api/import?dryRun=1', buf)).body;
  ok(dry.added === 2 && dry.dryRun, 'импорт: предпросмотр');
  ok((await A('POST', '/api/import', buf)).body.added === 2, 'импорт: запись');
  ok((await A('POST', '/api/import', buf)).body.duplicates === 2, 'импорт: без дублей');

  // Kaspi (если задан токен и поддельный сервер)
  const ks = (await A('GET', '/api/kaspi/status')).body;
  if (ks.configured) {
    await A('PUT', '/api/rates', { category: 'Чехлы для телефонов', percent: '15,5' });
    const d = await A('POST', '/api/kaspi/sync?dryRun=1');
    ok(d.status === 200 && d.body.completed === 3, 'Kaspi: предпросмотр (3 завершённых, отменённый пропущен)');
    const s = await A('POST', '/api/kaspi/sync');
    ok(s.body.added === 3, 'Kaspi: заказы внесены');
    ok((await A('POST', '/api/kaspi/sync')).body.added === 0, 'Kaspi: повтор без дублей');
    const k = (await A('GET', '/api/entries')).body.entries.find((e) => e.external_id === '5001');
    ok(k && k.commission === 372 && k.estimated === 1 && k.created_by === 'Kaspi API', 'Kaspi: комиссия по ставке категории, помечено «≈»');
  } else console.log('--  Kaspi не настроен, пропуск');

  const log = (await A('GET', '/api/activity')).body.activity;
  ok(log.length >= 4, 'журнал изменений ведётся');
  console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВсе проверки воркера пройдены');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('SMOKE ERROR', e); process.exit(1); });
