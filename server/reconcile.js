'use strict';

const { saleNet, round2 } = require('./entries');

/**
 * Сверка с реальной выплатой Kaspi: подгоняет комиссию и доставку у «приблизительных»
 * продаж периода так, чтобы «чистыми» за период совпало с фактом. Сверенные вручную
 * продажи не трогает. Удержания масштабируются пропорционально, итог по копейкам точный.
 */
function planReconcile(all, { from, to, actualNet, channel }) {
  const inRange = all.filter((e) => e.kind === 'sale' && e.date >= from && e.date <= to && (!channel || e.channel === channel));
  const fixed = inRange.filter((e) => !e.estimated);
  const est = inRange.filter((e) => e.estimated);
  if (!est.length) return { error: 'В этом периоде нет приблизительных продаж для сверки' };

  const fixedNet = fixed.reduce((a, e) => a + saleNet(e), 0);
  const estRevenue = est.reduce((a, e) => a + e.amount, 0);
  const estOther = est.reduce((a, e) => a + e.packaging + e.label, 0);
  const curDed = est.reduce((a, e) => a + e.commission + e.delivery, 0);
  const targetDed = round2(estRevenue - estOther - (actualNet - fixedNet)); // комиссия+доставка, которые нужно «набрать»
  if (targetDed < 0) return { error: 'Выплата больше выручки периода — проверьте сумму и даты' };
  if (targetDed > estRevenue) return { error: 'Удержания получаются больше выручки — проверьте сумму и даты' };

  // Целевые удержания делим между приблизительными продажами пропорционально их текущим удержаниям
  // (если их нет — пропорционально сумме), внутри продажи сохраняем соотношение комиссия/доставка.
  const patches = est.map((e) => {
    const cur = e.commission + e.delivery;
    const weight = curDed > 0 ? cur / curDed : e.amount / estRevenue;
    const ded = round2(targetDed * weight);
    const commission = round2(ded * (cur > 0 ? e.commission / cur : 1));
    return { id: e.id, commission, delivery: round2(ded - commission), estimated: 0 };
  });
  // остаток от округления — на последнюю запись, чтобы итог совпал до копейки
  const sum = patches.reduce((a, p) => a + p.commission + p.delivery, 0);
  const last = patches[patches.length - 1];
  last.commission = round2(last.commission + round2(targetDed - sum));

  const netBefore = round2(fixedNet + est.reduce((a, e) => a + saleNet(e), 0));
  return { patches, count: est.length, netBefore, netAfter: round2(actualNet), difference: round2(actualNet - netBefore) };
}

module.exports = { planReconcile };
