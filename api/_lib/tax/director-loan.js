/**
 * Stage 6 — Director's Loan Account (DLA) tracker.
 *
 * No new state — the DLA is just the running balance on account
 * 2500 (Director's Loan Account, a current-liability account).
 *
 *   credit balance ⇒ company owes the director
 *   debit  balance ⇒ director owes the company
 *
 * The s.455 Corporation Tax charge applies if the director owes the
 * company (debit balance) more than £10,000 at the accounting period
 * end and the loan is still outstanding 9 months + 1 day after that
 * period end. Rate: 33.75% of the outstanding balance.
 *
 * Slice 1 surfaces the balance + warning flags. Recovering the s.455
 * once the loan is repaid is an HMRC reclaim process — out of scope.
 */

const { sql } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { getAccountByCode } = require('../ledger/accounts');
const { getRules } = require('./rules');

async function getBalance(entityId, asOfDate, opts = {}) {
  if (!entityId) throw new Error('entityId required');
  const reader = opts.tx || getDb();
  const dla = await getAccountByCode(entityId, '2500');
  if (!dla) throw new Error("getBalance: 2500 Director's Loan Account not found (Ltd CoA only)");
  const { journalLines } = getSchema();
  const dateFilter = asOfDate ? sql`AND jl.date <= ${asOfDate}` : sql``;
  const rows = await reader.execute(sql`
    SELECT
      COALESCE(SUM(jl.debit_pence), 0)::bigint  AS debit_pence,
      COALESCE(SUM(jl.credit_pence), 0)::bigint AS credit_pence
    FROM ${journalLines} jl
    WHERE jl.account_id = ${dla.id}
      ${dateFilter}
  `);
  const raw = Array.isArray(rows) ? rows[0] : rows.rows?.[0];
  const debit = Number(raw?.debit_pence) || 0;
  const credit = Number(raw?.credit_pence) || 0;
  // For a liability account, natural balance is credit-positive.
  // We expose the raw signed balance (credit − debit): positive = owed
  // TO the director, negative = owed BY the director (overdrawn).
  const balancePence = credit - debit;
  return {
    accountId: dla.id,
    debitTotalPence: debit,
    creditTotalPence: credit,
    balancePence,
    overdrawnPence: balancePence < 0 ? -balancePence : 0,
  };
}

/**
 * Combined snapshot + s.455 warnings for the dashboard.
 *
 *   periodEndDate    — accounting period end
 *   asOfDate         — defaults to today; the balance check date
 *   taxYear / region — for rule lookup (£10k threshold + s.455 rate)
 */
async function getStatus(entityId, opts = {}) {
  const asOf = opts.asOfDate || new Date().toISOString().slice(0, 10);
  const balance = await getBalance(entityId, asOf);
  const taxYear = opts.taxYear || new Date().getUTCFullYear();
  const rules = await getRules(taxYear, opts.region || 'rUK');
  const overdrawn = balance.overdrawnPence;
  const flags = {
    over10kBenefit: overdrawn > rules.directorLoanThresholdPence,
    s455LikelyDue: false,   // requires periodEnd + 9mo elapsed comparison
    s455ChargePence: 0,
  };
  if (opts.periodEndDate) {
    const peEpoch = new Date(`${opts.periodEndDate}T00:00:00Z`).getTime();
    const dueEpoch = peEpoch + 9 * 30 * 24 * 3600 * 1000; // ~9 months
    const asOfEpoch = new Date(`${asOf}T00:00:00Z`).getTime();
    if (asOfEpoch > dueEpoch && overdrawn > 0) {
      flags.s455LikelyDue = true;
      flags.s455ChargePence = Math.round((overdrawn * rules.s455Rate) / 100);
    }
  }
  return { ...balance, asOf, flags };
}

module.exports = { getBalance, getStatus };
