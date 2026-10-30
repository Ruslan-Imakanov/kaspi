'use strict';

const { saleNet, round2 } = require('./entries');

const DAY = 86400000;
const toMs = (s) => Date.parse(`${s}T00:00:00Z`);
const toStr = (ms) => new Date(ms).toISOString().slice(0, 10);

function emptyChannel() {
  return { revenue: 0, count: 0, commission: 0, delivery: 0 };
}

function summarize(entries) {
  const s = {
    revenue: 0, salesCount: 0, commission: 0, delivery: 0, packaging: 0, label: 0,
    deductions: 0, netSales: 0, expenses: 0, withdrawals: 0, topups: 0, profit: 0,
    avgCheck: 0, margin: 0, commissionRate: 0,
    byChannel: { shop: emptyChannel(), pay: emptyChannel() },
    expenseByCategory: [],
  };
  const cats = new Map();

  for (const e of entries) {
    if (e.kind === 'sale') {
      s.revenue += e.amount;
      s.salesCount += 1;
      s.commission += e.commission;
      s.delivery += e.delivery;
      s.packaging += e.packaging;
      s.label += e.label;
      s.netSales += saleNet(e);
      const ch = s.byChannel[e.channel] ?? (s.byChannel[e.channel] = emptyChannel());
      ch.revenue += e.amount;
      ch.count += 1;
      ch.commission += e.commission;
      ch.delivery += e.delivery;
    } else if (e.kind === 'expense') {
      s.expenses += e.amount;
      const name = e.category || 'Без категории';
      cats.set(name, (cats.get(name) ?? 0) + e.amount);
    } else if (e.kind === 'withdrawal') {
      s.withdrawals += e.amount;
    } else if (e.kind === 'topup') {
      s.topups += e.amount;
    }
  }

  s.deductions = s.commission + s.delivery + s.packaging + s.label;
  s.profit = s.netSales - s.expenses;
  s.avgCheck = s.salesCount ? s.revenue / s.salesCount : 0;
  s.margin = s.revenue ? s.profit / s.revenue : 0;
  s.commissionRate = s.revenue ? s.commission / s.revenue : 0;
  s.expenseByCategory = [...cats.entries()].map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);

  for (const k of Object.keys(s)) if (typeof s[k] === 'number') s[k] = round2(s[k]);
  for (const ch of Object.values(s.byChannel)) for (const k of Object.keys(ch)) ch[k] = round2(ch[k]);
  s.expenseByCategory.forEach((c) => { c.total = round2(c.total); });
  s.margin = Math.round(s.margin * 10000) / 10000;
  s.commissionRate = Math.round(s.commissionRate * 10000) / 10000;
  return s;
}

function bucketKey(date, granularity) {
  return granularity === 'month' ? date.slice(0, 7) : date;
}

/** Ряды для графика и таблицы по месяцам. */
function series(entries, from, to, granularity) {
  const map = new Map();
  const get = (key) => {
    if (!map.has(key)) map.set(key, { key, revenue: 0, expenses: 0, netSales: 0, withdrawals: 0, topups: 0 });
    return map.get(key);
  };
  if (granularity === 'day' && from && to) {
    for (let t = toMs(from); t <= toMs(to); t += DAY) get(toStr(t));
  }
  for (const e of entries) {
    const b = get(bucketKey(e.date, granularity));
    if (e.kind === 'sale') { b.revenue += e.amount; b.netSales += saleNet(e); }
    else if (e.kind === 'expense') b.expenses += e.amount;
    else if (e.kind === 'withdrawal') b.withdrawals += e.amount;
    else if (e.kind === 'topup') b.topups += e.amount;
  }
  return [...map.values()]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((b) => ({
      key: b.key,
      revenue: round2(b.revenue),
      expenses: round2(b.expenses),
      netSales: round2(b.netSales),
      profit: round2(b.netSales - b.expenses),
      withdrawals: round2(b.withdrawals),
      topups: round2(b.topups),
    }));
}

function computeStats(all, fromIn, toIn) {
  let from = fromIn || null;
  let to = toIn || null;
  if (all.length) {
    const dates = all.map((e) => e.date);
    from = from || dates.reduce((a, b) => (a < b ? a : b));
    to = to || dates.reduce((a, b) => (a > b ? a : b));
  }
  const inRange = (e) => (!from || e.date >= from) && (!to || e.date <= to);
  const current = all.filter(inRange);

  let prev = null;
  let prevRange = null;
  if (from && to && fromIn && toIn) {
    const n = Math.round((toMs(to) - toMs(from)) / DAY) + 1;
    const prevTo = toStr(toMs(from) - DAY);
    const prevFrom = toStr(toMs(from) - n * DAY);
    prevRange = { from: prevFrom, to: prevTo };
    prev = summarize(all.filter((e) => e.date >= prevFrom && e.date <= prevTo));
  }

  const days = from && to ? Math.round((toMs(to) - toMs(from)) / DAY) + 1 : 0;
  const granularity = days > 92 ? 'month' : 'day';

  // Остаток по счёту считается за всё время, а не за выбранный период
  let balance = 0;
  for (const e of all) {
    if (e.kind === 'sale') balance += saleNet(e);
    else if (e.kind === 'topup') balance += e.amount;
    else balance -= e.amount;
  }

  return {
    range: { from, to },
    prevRange,
    granularity,
    summary: summarize(current),
    prev,
    series: series(current, from, to, granularity),
    months: series(current, from, to, 'month'),
    balance: round2(balance),
  };
}

module.exports = { computeStats, summarize };
