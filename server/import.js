'use strict';

const ExcelJS = require('exceljs');
const { normalize } = require('./entries');

const HEADERS = {
  date: /^дата$/i,
  type: /^заказ|продажа|перевод|начислен|прочее/i,
  amount: /^сумма$/i,
  withdraw: /^снятия$/i,
  topup: /^пополнения$/i,
  commission: /^за продаж/i,
  delivery: /^доставка$/i,
  packaging: /^пакет$/i,
  label: /^этикетка$/i,
};

function cellValue(c) {
  let v = c?.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) v = v.result; // формула
    else if ('richText' in v) v = v.richText.map((t) => t.text).join('');
    else if ('text' in v) v = v.text;
  }
  return v ?? null;
}

function num(v) {
  if (v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function parseDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; // M/D/YYYY как в Google Sheets
  return null;
}

/** Определяет категорию расхода по тексту из вашей таблицы. */
function classifyOutflow(text) {
  const t = text.toLowerCase();
  if (/налог/.test(t)) return { kind: 'expense', category: 'Налог' };
  if (/соц/.test(t)) return { kind: 'expense', category: 'Соц. отчисления' };
  if (/абонент/.test(t)) return { kind: 'expense', category: 'Абонентская плата' };
  if (/пакет|скотч|пупырк|упаков/.test(t)) return { kind: 'expense', category: 'Упаковка' };
  if (/одолжил|займ/.test(t)) return { kind: 'withdrawal', category: 'Займ себе' };
  if (/перевод|остаток/.test(t)) return { kind: 'withdrawal', category: 'Перевод на карту' };
  if (/снятие/.test(t)) return { kind: 'withdrawal', category: 'Снятие владельцу' };
  return { kind: 'expense', category: 'Прочее' };
}

async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('В файле нет листов');

  let headerRow = 0;
  const col = {};
  ws.eachRow((row, n) => {
    if (headerRow) return;
    const found = {};
    row.eachCell((cell, c) => {
      const t = String(cellValue(cell) ?? '').trim();
      for (const [key, re] of Object.entries(HEADERS)) if (!(key in found) && re.test(t)) found[key] = c;
    });
    if (found.date && found.amount) { headerRow = n; Object.assign(col, found); }
  });
  if (!headerRow) throw new Error('Не нашёл строку заголовков: нужны столбцы «Дата» и «Сумма»');

  const entries = [];
  let ignored = 0;
  const get = (row, key) => (col[key] ? cellValue(row.getCell(col[key])) : null);

  for (let n = headerRow + 1; n <= ws.rowCount; n++) {
    const row = ws.getRow(n);
    const date = parseDate(get(row, 'date'));
    if (!date) { ignored += 1; continue; } // итоговые и пустые строки

    const text = String(get(row, 'type') ?? '').trim();
    const sale = num(get(row, 'amount'));
    const out = num(get(row, 'withdraw'));
    const inn = num(get(row, 'topup'));
    let used = false;

    if (sale > 0) {
      const generic = /^(продажа|наши\s*[«"“]?покупки[»"”]?)$/i.test(text.replace(/""/g, '"'));
      entries.push({
        date, kind: 'sale',
        channel: /покупк/i.test(text) ? 'pay' : 'shop',
        category: '', note: generic ? '' : text,
        amount: sale,
        commission: num(get(row, 'commission')),
        delivery: num(get(row, 'delivery')),
        packaging: num(get(row, 'packaging')),
        label: num(get(row, 'label')),
      });
      used = true;
    }
    if (out > 0) {
      const { kind, category } = classifyOutflow(text);
      entries.push({ date, kind, category, note: text, amount: out });
      used = true;
    }
    if (inn > 0) {
      entries.push({ date, kind: 'topup', category: /верну/i.test(text) ? 'Возврат займа' : 'Пополнение', note: text, amount: inn });
      used = true;
    }
    if (!used) ignored += 1;
  }

  const valid = [];
  const errors = [];
  entries.forEach((e, i) => {
    const r = normalize(e);
    if (r.value) valid.push(r.value); else errors.push(`${e.date}: ${r.error}`);
    void i;
  });
  return { entries: valid, ignored, errors };
}

const keyOf = (e) => [e.date, e.kind, e.channel ?? '', e.category, e.note, e.amount, e.commission, e.delivery].join('|');

/** Отсекает записи, уже существующие в базе (повторный импорт не плодит дубли). */
function dedupe(incoming, existing) {
  const seen = new Map();
  for (const e of existing) seen.set(keyOf(e), (seen.get(keyOf(e)) ?? 0) + 1);
  const fresh = [];
  let duplicates = 0;
  for (const e of incoming) {
    const k = keyOf(e);
    if (seen.get(k) > 0) { seen.set(k, seen.get(k) - 1); duplicates += 1; } else fresh.push(e);
  }
  return { fresh, duplicates };
}

module.exports = { parseWorkbook, dedupe };
