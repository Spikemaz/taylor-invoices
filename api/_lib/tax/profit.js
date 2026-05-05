/**
 * Stage 5 — Trading-profit computation for Self Assessment.
 *
 * Walks the entity's P&L for a given UK tax year and produces:
 *
 *   - turnoverPence            — sum of income accounts
 *   - allowableExpensesPence   — sum of expense accounts whose
 *                                tax_treatment is null (default for
 *                                expenses) or 'allowable'
 *   - disallowablePence        — sum of expense accounts flagged
 *                                'disallowable' or 'private_addback'
 *   - capitalInPnLPence        — sum of expense accounts flagged
 *                                'capital' (e.g. a depreciation
 *                                account where the bookkeeper has
 *                                expensed a fixed asset directly).
 *                                Added back; the capital-allowances
 *                                engine then claims AIA/WDA.
 *   - accountingProfitPence    — turnover − total expenses
 *   - taxAdjustmentsPence      — disallowable + capitalInPnL
 *   - taxableTradingProfitPence (PRE capital allowances + trading
 *                                allowance) = accountingProfit + adj
 *
 * All sums use signedBalance (natural-balance positive) so callers
 * can rely on plain non-negative integers.
 */

const { sql } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { signedBalance } = require('../ledger/accounts');
const { taxYearRange } = require('./years');

const DISALLOWABLE_TREATMENTS = new Set(['disallowable', 'private_addback']);

async function computeTradingProfit(entityId, taxYear, opts = {}) {
  if (!entityId) throw new Error('entityId required');
  if (!Number.isInteger(taxYear)) throw new Error('taxYear must be an integer');
  const reader = opts.tx || getDb();
  const { startDate, endDate } = taxYearRange(taxYear);
  const { accounts, journalLines } = getSchema();

  const rows = await reader.execute(sql`
    SELECT
      a.id              AS account_id,
      a.code            AS code,
      a.name            AS name,
      a.type            AS type,
      a.tax_treatment   AS tax_treatment,
      COALESCE(SUM(jl.debit_pence), 0)::bigint  AS debit_pence,
      COALESCE(SUM(jl.credit_pence), 0)::bigint AS credit_pence
    FROM ${accounts} a
    LEFT JOIN ${journalLines} jl
      ON jl.account_id = a.id
     AND jl.date BETWEEN ${startDate} AND ${endDate}
    WHERE a.entity_id = ${entityId}
      AND a.type IN ('income', 'expense')
    GROUP BY a.id, a.code, a.name, a.type, a.tax_treatment
    ORDER BY a.code
  `);
  const raw = Array.isArray(rows) ? rows : rows.rows || [];

  let turnoverPence = 0;
  let totalExpensesPence = 0;
  let allowableExpensesPence = 0;
  let disallowablePence = 0;
  let capitalInPnLPence = 0;
  const accountBreakdown = [];

  for (const r of raw) {
    const debit = Number(r.debit_pence) || 0;
    const credit = Number(r.credit_pence) || 0;
    if (debit === 0 && credit === 0) continue;
    const balance = signedBalance(r.type, debit, credit);
    accountBreakdown.push({
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      type: r.type,
      taxTreatment: r.tax_treatment,
      balancePence: balance,
    });
    if (r.type === 'income') {
      turnoverPence += balance;
      continue;
    }
    // expense
    totalExpensesPence += balance;
    if (DISALLOWABLE_TREATMENTS.has(r.tax_treatment)) {
      disallowablePence += balance;
    } else if (r.tax_treatment === 'capital') {
      capitalInPnLPence += balance;
    } else {
      // null or 'allowable'
      allowableExpensesPence += balance;
    }
  }

  const accountingProfitPence = turnoverPence - totalExpensesPence;
  const taxAdjustmentsPence = disallowablePence + capitalInPnLPence;
  const taxableTradingProfitPreAllowancesPence =
    accountingProfitPence + taxAdjustmentsPence;

  return {
    taxYear,
    range: { startDate, endDate },
    turnoverPence,
    totalExpensesPence,
    allowableExpensesPence,
    disallowablePence,
    capitalInPnLPence,
    accountingProfitPence,
    taxAdjustmentsPence,
    taxableTradingProfitPreAllowancesPence,
    accountBreakdown,
  };
}

module.exports = { computeTradingProfit };
