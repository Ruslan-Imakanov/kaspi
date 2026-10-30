'use strict';

const DAY = 86400000;
const WINDOW = 13 * DAY; // API Kaspi ограничивает диапазон дат в одном запросе (около 14 дней)

const dateInTz = (ms, tz) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

async function kaspiGet(url, token, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: {
      'X-Auth-Token': token,
      'Content-Type': 'application/vnd.api+json',
      Accept: 'application/vnd.api+json, application/json',
      'User-Agent': 'kaspi-ledger/1.0',
    },
  });
  if (res.status === 401 || res.status === 403) throw new Error(`Kaspi не принял токен (HTTP ${res.status}). Проверьте KASPI_TOKEN.`);
  if (!res.ok) throw new Error(`Kaspi API ответил HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

/** Завершённые заказы за период (state=ARCHIVE) вместе с позициями. */
async function fetchOrders({ base, token, fromMs, toMs, fetchImpl = fetch }) {
  const byId = new Map(); // заказ на границе двух окон не должен считаться дважды
  const included = new Map();
  for (let start = fromMs; start < toMs; start += WINDOW) {
    const end = Math.min(start + WINDOW, toMs);
    for (let page = 0; page < 100; page++) {
      const url = `${base}/orders?page[number]=${page}&page[size]=100`
        + `&filter[orders][state]=ARCHIVE&filter[orders][creationDate][$ge]=${start}&filter[orders][creationDate][$le]=${end}`
        + '&include[orders]=entries';
      const body = await kaspiGet(url, token, fetchImpl);
      for (const o of body.data ?? []) byId.set(o.id, o);
      for (const inc of body.included ?? []) included.set(`${inc.type}:${inc.id}`, inc);
      const pages = body.meta?.pageCount;
      if (!(body.data?.length >= 100) || (pages !== undefined && page + 1 >= pages)) break;
    }
  }
  return { orders: [...byId.values()], included };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Превращает заказы в записи продаж. Комиссия — по ставкам категорий (если ставка задана
 * для всех позиций заказа), иначе подбирается по истории. Всё это «приблизительно», пока
 * не сверено с выплатой Kaspi.
 */
function mapOrders({ orders, included }, { rates, suggest, tz }) {
  const rateOf = new Map(rates.map((r) => [r.category, r.percent]));
  const entries = [];
  const returned = [];
  const unknown = new Map();

  for (const o of orders) {
    const a = o.attributes ?? {};
    const code = String(a.code ?? o.id);
    if (a.status && a.status !== 'COMPLETED') {
      if (/RETURN|CANCEL/.test(a.status)) returned.push(code);
      continue;
    }
    const amount = num(a.totalPrice);
    if (amount <= 0 || !a.creationDate) continue;

    const items = (o.relationships?.entries?.data ?? [])
      .map((r) => included.get(`${r.type}:${r.id}`))
      .filter(Boolean)
      .map((en) => {
        const cat = en.attributes?.category;
        return {
          category: (cat && (cat.title || cat.name || cat.code)) || '',
          total: num(en.attributes?.totalPrice) || num(en.attributes?.basePrice) * (num(en.attributes?.quantity) || 1),
        };
      });

    let commission = null;
    if (items.length && items.every((i) => i.category && rateOf.has(i.category))) {
      commission = Math.round(items.reduce((s, i) => s + (i.total * rateOf.get(i.category)) / 100, 0) * 100) / 100;
    }
    for (const i of items) if (i.category && !rateOf.has(i.category)) unknown.set(i.category, (unknown.get(i.category) ?? 0) + 1);

    const byCat = new Map();
    for (const i of items) byCat.set(i.category, (byCat.get(i.category) ?? 0) + i.total);
    const mainCat = [...byCat.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '';

    const sug = suggest(amount, mainCat);
    entries.push({
      date: dateInTz(num(a.creationDate), tz),
      kind: 'sale', channel: 'shop', category: mainCat, note: `Kaspi №${code}`,
      amount, commission: commission ?? sug?.commission ?? 0, delivery: sug?.delivery ?? 0, packaging: 0, label: 0,
      source: 'kaspi', external_id: code, estimated: 1,
    });
  }
  return { entries, returned, unknown: [...unknown.entries()].map(([category, count]) => ({ category, count })) };
}

module.exports = { fetchOrders, mapOrders, dateInTz };
