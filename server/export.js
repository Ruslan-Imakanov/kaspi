'use strict';

const ExcelJS = require('exceljs');
const { KIND_LABELS, CHANNEL_LABELS, saleNet, signedAmount } = require('./entries');
const { computeStats } = require('./stats');

const MONEY = '#,##0.00;[Red]-#,##0.00';
const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F3D3E' } };

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEAD_FILL;
  row.alignment = { vertical: 'middle', wrapText: true };
  row.height = 28;
}

function monthLabel(key) {
  const [y, m] = key.split('-');
  const names = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  return `${names[Number(m) - 1]} ${y}`;
}

async function buildWorkbook(all, from, to) {
  const rows = all
    .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
    .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
  const stats = computeStats(all, from, to);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kaspi Учёт';
  wb.created = new Date();

  // --- Операции ---
  const ws = wb.addWorksheet('Операции', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Дата', key: 'date', width: 12, style: { numFmt: 'dd.mm.yyyy' } },
    { header: 'Тип', key: 'kind', width: 13 },
    { header: 'Канал', key: 'channel', width: 15 },
    { header: 'Категория', key: 'category', width: 22 },
    { header: 'Комментарий', key: 'note', width: 32 },
    { header: 'Сумма', key: 'amount', width: 13, style: { numFmt: MONEY } },
    { header: 'Комиссия', key: 'commission', width: 12, style: { numFmt: MONEY } },
    { header: 'Доставка', key: 'delivery', width: 12, style: { numFmt: MONEY } },
    { header: 'Пакет', key: 'packaging', width: 11, style: { numFmt: MONEY } },
    { header: 'Этикетка', key: 'label', width: 11, style: { numFmt: MONEY } },
    { header: 'Движение по счёту', key: 'flow', width: 17, style: { numFmt: MONEY } },
    { header: 'Внёс', key: 'by', width: 14 },
  ];
  styleHeader(ws.getRow(1));

  rows.forEach((e, i) => {
    const r = i + 2;
    const flow = signedAmount(e);
    const formula = e.kind === 'sale' ? `F${r}-G${r}-H${r}-I${r}-J${r}` : e.kind === 'topup' ? `F${r}` : `-F${r}`;
    ws.addRow({
      date: new Date(`${e.date}T00:00:00Z`),
      kind: KIND_LABELS[e.kind],
      channel: e.channel ? CHANNEL_LABELS[e.channel] : '',
      category: e.category,
      note: e.note,
      amount: e.amount,
      commission: e.kind === 'sale' ? e.commission : null,
      delivery: e.kind === 'sale' ? e.delivery : null,
      packaging: e.kind === 'sale' ? e.packaging : null,
      label: e.kind === 'sale' ? e.label : null,
      flow: { formula, result: flow },
      by: e.created_by,
    });
  });

  const last = rows.length + 1;
  const total = ws.addRow({ date: null, kind: 'Итого (по фильтру)' });
  for (const col of ['G', 'H', 'I', 'J', 'K']) {
    // SUBTOTAL(109) учитывает только видимые строки при фильтрации
    total.getCell(col).value = { formula: `SUBTOTAL(109,${col}2:${col}${Math.max(last, 2)})` };
  }
  total.font = { bold: true };
  total.border = { top: { style: 'thin' } };
  if (rows.length) ws.autoFilter = { from: 'A1', to: `L${last}` };

  // --- По месяцам ---
  const wm = wb.addWorksheet('По месяцам', { views: [{ state: 'frozen', ySplit: 1 }] });
  wm.columns = [
    { header: 'Месяц', key: 'm', width: 18 },
    { header: 'Выручка', key: 'revenue', width: 14, style: { numFmt: MONEY } },
    { header: 'Комиссия + доставка + упаковка', key: 'ded', width: 20, style: { numFmt: MONEY } },
    { header: 'Чистыми с продаж', key: 'net', width: 16, style: { numFmt: MONEY } },
    { header: 'Расходы', key: 'exp', width: 14, style: { numFmt: MONEY } },
    { header: 'Прибыль', key: 'profit', width: 14, style: { numFmt: MONEY } },
    { header: 'Маржа', key: 'margin', width: 10, style: { numFmt: '0.0%' } },
    { header: 'Снятия', key: 'wd', width: 14, style: { numFmt: MONEY } },
    { header: 'Пополнения', key: 'tp', width: 14, style: { numFmt: MONEY } },
  ];
  styleHeader(wm.getRow(1));
  stats.months.forEach((m, i) => {
    const r = i + 2;
    wm.addRow({
      m: monthLabel(m.key),
      revenue: m.revenue,
      ded: { formula: `B${r}-D${r}`, result: m.revenue - m.netSales },
      net: m.netSales,
      exp: m.expenses,
      profit: { formula: `D${r}-E${r}`, result: m.profit },
      margin: { formula: `IF(B${r}=0,0,F${r}/B${r})`, result: m.revenue ? m.profit / m.revenue : 0 },
      wd: m.withdrawals,
      tp: m.topups,
    });
  });
  if (stats.months.length) {
    const n = stats.months.length + 1;
    const t = wm.addRow({ m: 'Итого' });
    for (const c of ['B', 'C', 'D', 'E', 'F', 'H', 'I']) t.getCell(c).value = { formula: `SUM(${c}2:${c}${n})` };
    t.getCell('G').value = { formula: `IF(B${n + 1}=0,0,F${n + 1}/B${n + 1})` };
    t.getCell('G').numFmt = '0.0%';
    t.font = { bold: true };
    t.border = { top: { style: 'thin' } };
  }

  // --- Расходы по категориям ---
  const wc = wb.addWorksheet('Расходы по категориям');
  wc.columns = [
    { header: 'Категория', key: 'c', width: 28 },
    { header: 'Сумма', key: 's', width: 16, style: { numFmt: MONEY } },
    { header: 'Доля', key: 'p', width: 10, style: { numFmt: '0.0%' } },
  ];
  styleHeader(wc.getRow(1));
  const cats = stats.summary.expenseByCategory;
  cats.forEach((c, i) => {
    const r = i + 2;
    wc.addRow({ c: c.category, s: c.total, p: { formula: `B${r}/B${cats.length + 2}`, result: c.total / (stats.summary.expenses || 1) } });
  });
  if (cats.length) {
    const t = wc.addRow({ c: 'Итого' });
    t.getCell('B').value = { formula: `SUM(B2:B${cats.length + 1})` };
    t.font = { bold: true };
    t.border = { top: { style: 'thin' } };
  }

  return wb;
}

module.exports = { buildWorkbook };
