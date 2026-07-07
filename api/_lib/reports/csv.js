/**
 * Stage 8 — CSV export of any report payload.
 *
 * Each report has a known shape; we render a deterministic CSV with a
 * header row and one row per line item plus a totals row. The exporter
 * is pure-string for portability — no third-party CSV lib.
 *
 *   formatPence(123456) === "1234.56"
 *
 * The caller can consume this as a string or stream it to disk. PDF and
 * XLSX rendering live in the UI follow-up — this slice ships CSV only.
 */

function pad2(n) { return n < 10 ? `0${n}` : `${n}`; }

function formatPence(pence) {
  const sign = pence < 0 ? '-' : '';
  const abs = Math.abs(pence);
  const pounds = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}${pounds}.${pad2(remainder)}`;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

function profitAndLossToCsv(pl) {
  const lines = [csvRow(['Section', 'Code', 'Account', 'Amount'])];
  for (const r of pl.income.rows) lines.push(csvRow(['Income', r.code, r.name, formatPence(r.balancePence)]));
  lines.push(csvRow(['Income', '', 'Total income', formatPence(pl.income.totalPence)]));
  for (const r of pl.expenses.rows) lines.push(csvRow(['Expense', r.code, r.name, formatPence(r.balancePence)]));
  lines.push(csvRow(['Expense', '', 'Total expenses', formatPence(pl.expenses.totalPence)]));
  lines.push(csvRow(['', '', 'Net profit', formatPence(pl.netProfitPence)]));
  return lines.join('\n') + '\n';
}

function balanceSheetToCsv(bs) {
  const lines = [csvRow(['Section', 'Code', 'Account', 'Amount'])];
  for (const r of bs.assets.rows) lines.push(csvRow(['Asset', r.code, r.name, formatPence(r.balancePence)]));
  lines.push(csvRow(['Asset', '', 'Total assets', formatPence(bs.assets.totalPence)]));
  for (const r of bs.liabilities.rows) lines.push(csvRow(['Liability', r.code, r.name, formatPence(r.balancePence)]));
  lines.push(csvRow(['Liability', '', 'Total liabilities', formatPence(bs.liabilities.totalPence)]));
  for (const r of bs.equity.rows) lines.push(csvRow(['Equity', r.code, r.name, formatPence(r.balancePence)]));
  lines.push(csvRow(['Equity', '', 'Total equity', formatPence(bs.equity.totalPence)]));
  return lines.join('\n') + '\n';
}

function trialBalanceToCsv(tb) {
  const lines = [csvRow(['Code', 'Account', 'Type', 'Debit', 'Credit'])];
  for (const r of tb.rows) {
    lines.push(csvRow([r.code, r.name, r.type, formatPence(r.debitPence), formatPence(r.creditPence)]));
  }
  lines.push(csvRow(['', 'Total', '', formatPence(tb.totals.debitPence), formatPence(tb.totals.creditPence)]));
  return lines.join('\n') + '\n';
}

function agedToCsv(aged) {
  const lines = [csvRow(['SourceId', 'Counterparty', 'Invoice date', 'Age days', 'Bucket', 'Outstanding'])];
  for (const r of aged.open) {
    lines.push(csvRow([r.sourceId, r.counterparty || '', r.invoiceDate, r.ageDays, r.bucket, formatPence(r.outstandingPence)]));
  }
  lines.push(csvRow(['', '', '', '', 'Total', formatPence(aged.totalPence)]));
  return lines.join('\n') + '\n';
}

function cashFlowToCsv(cf) {
  const lines = [csvRow(['Section', 'Item', 'Amount'])];
  lines.push(csvRow(['Operating', 'Net profit', formatPence(cf.operating.netProfitPence)]));
  lines.push(csvRow(['Operating', 'Depreciation', formatPence(cf.operating.depreciationPence)]));
  lines.push(csvRow(['Operating', 'Δ Trade Debtors', formatPence(-cf.operating.arDeltaPence)]));
  lines.push(csvRow(['Operating', 'Δ Trade Creditors', formatPence(cf.operating.apDeltaPence)]));
  lines.push(csvRow(['Operating', 'Total', formatPence(cf.operating.totalPence)]));
  lines.push(csvRow(['Cash', 'Opening', formatPence(cf.cash.openingPence)]));
  lines.push(csvRow(['Cash', 'Closing', formatPence(cf.cash.closingPence)]));
  return lines.join('\n') + '\n';
}

function toCsv(kind, payload) {
  switch (kind) {
    case 'profit_and_loss': return profitAndLossToCsv(payload);
    case 'balance_sheet':   return balanceSheetToCsv(payload);
    case 'trial_balance':   return trialBalanceToCsv(payload);
    case 'aged_debtors':
    case 'aged_creditors':  return agedToCsv(payload);
    case 'cash_flow':       return cashFlowToCsv(payload);
    default:
      throw new Error(`toCsv: unsupported kind ${kind}`);
  }
}

module.exports = { toCsv, formatPence };
