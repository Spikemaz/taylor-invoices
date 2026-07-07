/**
 * Stage 8 — Director's Report (Ltd-only).
 *
 * Foundation slice: returns a structured scaffold pulling from the
 * existing Stage 6 ledger codes. Real narrative copy + statutory
 * sections are a UI follow-up.
 *
 * Sections:
 *   - directorsSalaryPence: total to 7110 over the period
 *   - dividendsDeclaredPence: total to retained earnings via dividends
 *     source (matches Stage 6 dividend journal)
 *   - directorsLoanBalancePence: 1300 / "Director's Loan Account"
 *
 * Returns `{ available: boolean }` — false for non-Ltd entities — so the
 * UI can show a "Ltd-only" placeholder instead of empty totals.
 */

const { getDb, getSchema } = require('../db');
const { sql } = require('drizzle-orm');
const { getAccountByCode } = require('../ledger/accounts');

async function balancePence(entityId, code, from, to) {
  const acc = await getAccountByCode(entityId, code).catch(() => null);
  if (!acc) return 0;
  const db = getDb();
  const { journalLines } = getSchema();
  const rows = await db.execute(sql`
    SELECT
      COALESCE(SUM(debit_pence), 0)::bigint  AS debit_pence,
      COALESCE(SUM(credit_pence), 0)::bigint AS credit_pence
    FROM ${journalLines}
    WHERE entity_id = ${entityId}
      AND account_id = ${acc.id}
      AND date BETWEEN ${from} AND ${to}
  `);
  const raw = Array.isArray(rows) ? rows : rows.rows || [];
  const debit = Number(raw[0]?.debit_pence) || 0;
  const credit = Number(raw[0]?.credit_pence) || 0;
  return { debit, credit };
}

async function directorsReport({ entityId, from, to }) {
  if (!entityId || !from || !to) throw new Error('directorsReport: entityId/from/to required');
  const db = getDb();
  const { entities } = getSchema();
  const ent = await db.select().from(entities).where(sql`id = ${entityId}`).limit(1);
  if (!ent[0]) throw new Error(`entity ${entityId} not found`);
  if (ent[0].type !== 'limited') {
    return { available: false, entityType: ent[0].type, from, to };
  }
  const sal = await balancePence(entityId, '7110', from, to);
  const loan = await balancePence(entityId, '1300', from, to);
  return {
    available: true,
    from,
    to,
    entityType: 'limited',
    directorsSalaryPence: (sal && sal.debit - sal.credit) || 0,
    directorsLoanMovementPence: (loan && loan.debit - loan.credit) || 0,
  };
}

module.exports = { directorsReport };
