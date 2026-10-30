'use strict';

const KINDS = ['sale', 'expense', 'withdrawal', 'topup'];
const CHANNELS = ['shop', 'pay'];

const KIND_LABELS = {
  sale: 'Продажа',
  expense: 'Расход',
  withdrawal: 'Снятие',
  topup: 'Пополнение',
};
const CHANNEL_LABELS = { shop: 'Kaspi Магазин', pay: 'Kaspi Pay' };

// Подсказки категорий (поле свободное, это лишь быстрый выбор)
const CATEGORIES = {
  sale: [],
  expense: ['Налог', 'Соц. отчисления', 'Абонентская плата', 'Упаковка', 'Реклама', 'Закупка товара', 'Аренда', 'Прочее'],
  withdrawal: ['Перевод на карту', 'Снятие владельцу', 'Займ себе', 'Прочее'],
  topup: ['Пополнение', 'Возврат займа', 'Прочее'],
};

const MONEY_FIELDS = ['commission', 'delivery', 'packaging', 'label'];
const MAX_AMOUNT = 1e9;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function toMoney(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Приводит ввод к виду, пригодному для записи. Возвращает { value } или { error }.
 * trusted=true (синхронизация, регулярные платежи) разрешает задавать source/external_id/recurring_key;
 * ввод пользователя может влиять только на признак «приблизительно».
 */
function normalize(input, { trusted = false } = {}) {
  const e = input || {};
  const kind = e.kind;
  if (!KINDS.includes(kind)) return { error: 'Неизвестный тип операции' };
  if (!isValidDate(e.date)) return { error: 'Некорректная дата' };

  const amount = toMoney(e.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    return { error: 'Сумма должна быть больше нуля' };
  }

  const out = {
    date: e.date,
    kind,
    channel: null,
    category: String(e.category ?? '').trim().slice(0, 60),
    note: String(e.note ?? '').trim().slice(0, 300),
    amount: round2(amount),
    commission: 0,
    delivery: 0,
    packaging: 0,
    label: 0,
    source: 'manual',
    external_id: null,
    estimated: 0,
    recurring_key: null,
  };
  if (trusted) {
    out.source = ['manual', 'kaspi', 'import', 'recurring'].includes(e.source) ? e.source : 'manual';
    out.external_id = e.external_id ? String(e.external_id).slice(0, 80) : null;
    out.recurring_key = e.recurring_key ? String(e.recurring_key).slice(0, 40) : null;
  }

  if (kind === 'sale') {
    out.estimated = e.estimated ? 1 : 0; // значения подобраны автоматически и ещё не сверены
    out.channel = e.channel ?? 'shop';
    if (!CHANNELS.includes(out.channel)) return { error: 'Неизвестный канал' };
    for (const f of MONEY_FIELDS) {
      const n = toMoney(e[f]);
      if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return { error: 'Некорректное значение удержаний' };
      out[f] = round2(n);
    }
    if (out.commission + out.delivery + out.packaging + out.label > out.amount * 5) {
      return { error: 'Удержания выглядят слишком большими — проверьте цифры' };
    }
    // у ручного ввода «приблизительно» без подобранных значений бессмысленно; заказы Kaspi без ставки остаются непроверенными
    if (!trusted && out.commission + out.delivery === 0) out.estimated = 0;
  }
  return { value: out };
}

/** Чистыми с продажи (после комиссии, доставки, упаковки и этикетки). */
function saleNet(e) {
  return round2(e.amount - e.commission - e.delivery - e.packaging - e.label);
}

/** Влияние операции на остаток по счёту. */
function signedAmount(e) {
  if (e.kind === 'sale') return saleNet(e);
  if (e.kind === 'topup') return e.amount;
  return -e.amount;
}

module.exports = {
  KINDS, CHANNELS, KIND_LABELS, CHANNEL_LABELS, CATEGORIES,
  normalize, saleNet, signedAmount, round2, isValidDate,
};
