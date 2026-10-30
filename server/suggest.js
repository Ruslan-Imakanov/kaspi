'use strict';

const { round2 } = require('./entries');

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Подбирает комиссию и доставку для новой продажи по вашей же истории:
 * берёт ближайшие по сумме уже сверенные продажи того же канала.
 * Ничего не придумывает: при малой истории (<3 продаж) возвращает null.
 */
function suggestDeductions(entries, { amount, channel = 'shop', category = '' }, rates = []) {
  const a = Number(amount);
  if (!(a > 0)) return null;

  const rate = category ? rates.find((r) => r.category === category) : null;
  const history = entries
    .filter((e) => e.kind === 'sale' && e.channel === channel && !e.estimated && e.amount > 0)
    .slice(0, 300); // all() отдаёт от новых к старым
  const near = history
    .map((e) => ({ e, d: Math.abs(Math.log(e.amount / a)) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, 7)
    .map((x) => x.e);

  if (!rate && near.length < 3) return null;

  const commission = rate
    ? round2((a * rate.percent) / 100)
    : round2(a * median(near.map((e) => e.commission / e.amount)));

  // Доставка Kaspi зависит от суммы/габаритов, поэтому берём значение у самых близких по сумме продаж
  const close = near.filter((e) => e.amount / a > 0.7 && e.amount / a < 1.43);
  let delivery = 0;
  if (near.length >= 3) {
    delivery = close.length >= 2
      ? round2(median(close.map((e) => e.delivery)))
      : round2(a * median(near.map((e) => e.delivery / e.amount)));
  }

  return {
    commission,
    delivery,
    basis: rate ? 'rate' : 'history',
    samples: near.length,
    commissionRate: a ? commission / a : 0,
  };
}

module.exports = { suggestDeductions, median };
