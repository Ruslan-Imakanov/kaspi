'use strict';

const { median } = require('./suggest');

const daysInMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** Регулярные платежи текущего месяца, которые ещё не внесены. */
function pendingFor(recurring, entries, today) {
  const month = today.slice(0, 7);
  const done = new Set(entries.map((e) => e.recurring_key).filter(Boolean));
  const out = [];
  for (const r of recurring) {
    if (!r.active) continue;
    const key = `${r.id}:${month}`;
    if (done.has(key)) continue;
    const day = Math.min(r.day, daysInMonth(month));
    const dueDate = `${month}-${String(day).padStart(2, '0')}`;
    const diff = Math.round((Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
    out.push({
      id: r.id, key, kind: r.kind, category: r.category, amount: r.amount, note: r.note,
      dueDate, daysLeft: diff, status: diff < 0 ? 'overdue' : diff <= 5 ? 'soon' : 'later',
    });
  }
  return out.sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
}

/** Предлагает регулярные платежи по истории: одна категория и сумма минимум в двух разных месяцах. */
function suggestRecurring(entries, existing) {
  const groups = new Map();
  for (const e of entries) {
    if (e.kind !== 'expense' || !e.category || e.source === 'recurring' && e.recurring_key) continue;
    const k = `${e.category}|${e.amount}`;
    if (!groups.has(k)) groups.set(k, { category: e.category, amount: e.amount, months: new Set(), days: [] });
    const g = groups.get(k);
    g.months.add(e.date.slice(0, 7));
    g.days.push(Number(e.date.slice(8, 10)));
  }
  const have = new Set(existing.map((r) => `${r.category}|${r.amount}`));
  return [...groups.values()]
    .filter((g) => g.months.size >= 2 && !have.has(`${g.category}|${g.amount}`))
    .map((g) => ({ kind: 'expense', category: g.category, amount: g.amount, day: Math.round(median(g.days)), months: g.months.size }))
    .sort((a, b) => b.months - a.months);
}

module.exports = { pendingFor, suggestRecurring };
