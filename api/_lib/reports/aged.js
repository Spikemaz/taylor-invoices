/**
 * Stage 8 — Aged Debtors / Aged Creditors.
 *
 * Both reports are built directly from `journal_lines` — there is no
 * separate "open invoices" table. We aggregate signed activity on the
 * Trade Debtors (default 1100) or Trade Creditors (default 2100)
 * control account by sourceId — the invoice/bill identifier carried
 * through every leg of an invoice/payment journal pair.
 *
 *   * Aged Debtors: any sourceId on 1100 whose net (debit − credit) is
 *     positive at asOfDate. The earliest journal date for that sourceId
 *     becomes the invoice date; "age" = asOfDate − invoiceDate, in days.
 *
 *   * Aged Creditors: same, mirrored on 2100 (credit − debit positive).
 *
 * Buckets follow the standard bookkeeping convention:
 *     0–30, 31–60, 61–90, 90+ days.
 */

const { getDb, getSchema } = require('../db');
const { sql } = require('drizzle-orm');
const { getAccountByCode } = require('../ledger/accounts');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((db - da) / 86_400_000);
}

function bucketFor(days) {
  if (days <= 30) return '0_30';
  if (days <= 60) return '31_60';
  if (days <= 90) return '61_90';
  return 'over_90';
}

async function agedReport({ entityId, asOfDate, accountCode, side }) {
  if (!entityId) throw new Error('agedReport: entityId required');
  const asOf = asOfDate || todayStr();
  const acc = await getAccountByCode(entityId, accountCode);
  if (!acc) {
    return {
      asOfDate: asOf,
      accountCode,
      open: [],
      buckets: emptyBuckets(),
      totalPence: 0,
    };
  }
  const db = getDb();
  const { journalLines, journals } = getSchema();
  // Group by source_id when present (an invoice/bill identifier) and
  // fall back to journal id otherwise (so ad-hoc manual creditor entries
  // still surface as individual open items).
  const rows = await db.execute(sql`
    SELECT
      COALESCE(j.source_id, j.id) AS group_key,
      MAX(j.source_id)            AS source_id,
      MIN(j.date)                 AS invoice_date,
      MIN(jl.memo)                AS memo,
      COALESCE(SUM(jl.debit_pence), 0)::bigint  AS debit_pence,
      COALESCE(SUM(jl.credit_pence), 0)::bigint AS credit_pence
    FROM ${journalLines} jl
    INNER JOIN ${journals} j ON j.id = jl.journal_id
    WHERE jl.entity_id = ${entityId}
      AND jl.account_id = ${acc.id}
      AND jl.date <= ${asOf}
    GROUP BY COALESCE(j.source_id, j.id)
  `);
  const raw = Array.isArray(rows) ? rows : rows.rows || [];

  const open = [];
  const buckets = emptyBuckets();
  let total = 0;
  for (const r of raw) {
    const debit = Number(r.debit_pence) || 0;
    const credit = Number(r.credit_pence) || 0;
    const net = side === 'debtor' ? debit - credit : credit - debit;
    if (net <= 0) continue;
    const invoiceDate = String(r.invoice_date).slice(0, 10);
    const ageDays = Math.max(0, daysBetween(invoiceDate, asOf));
    const bucket = bucketFor(ageDays);
    open.push({
      sourceId: r.source_id || r.group_key,
      counterparty: r.memo,
      invoiceDate,
      ageDays,
      bucket,
      outstandingPence: net,
    });
    buckets[bucket] += net;
    total += net;
  }
  open.sort((a, b) => b.ageDays - a.ageDays);
  return { asOfDate: asOf, accountCode, open, buckets, totalPence: total };
}

function emptyBuckets() {
  return { '0_30': 0, '31_60': 0, '61_90': 0, over_90: 0 };
}

async function agedDebtors({ entityId, asOfDate, accountCode = '1100' } = {}) {
  return agedReport({ entityId, asOfDate, accountCode, side: 'debtor' });
}

async function agedCreditors({ entityId, asOfDate, accountCode = '2100' } = {}) {
  return agedReport({ entityId, asOfDate, accountCode, side: 'creditor' });
}

module.exports = { agedDebtors, agedCreditors };
