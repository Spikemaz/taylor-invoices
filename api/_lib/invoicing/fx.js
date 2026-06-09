/**
 * Stage 9 — Multi-currency helpers.
 *
 * The ledger is GBP-only (every account, every journal_line, every
 * report). Foreign-currency invoices are stored in their native
 * currency at the `invoices` row level and posted to the ledger in
 * GBP using the FX rate captured at issue.
 *
 * On settlement, if the FX rate has moved, the GBP value of the
 * remaining receivable differs from what we originally booked. The
 * difference is a realised FX gain or loss and lands in:
 *
 *   - 4100 Other Income       (gains)
 *   - 8100 Sundry Expenses    (losses)
 *
 * We deliberately reuse existing CoA codes rather than introducing
 * dedicated 4300 / 8200 accounts in this slice — keeps the seeded
 * chart unchanged and means existing reports/aging keep working.
 *
 * `fxRateToBase` semantics: amount_in_base = amount_in_currency *
 * fxRateToBase. So GBP→GBP is 1, USD→GBP at $1.27/£ is ~0.78740.
 *
 * All amounts are integer pence in the invoice currency unless the
 * function name says otherwise.
 */

function isPositiveFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function parseRate(rate) {
  // Drizzle returns numeric() as a string. Accept both.
  const n = typeof rate === 'number' ? rate : parseFloat(rate);
  if (!isPositiveFiniteNumber(n)) {
    throw new Error(`FX rate must be positive finite number; got ${rate}`);
  }
  return n;
}

/**
 * Convert a pence amount in the invoice's currency to GBP pence using
 * a captured FX rate. Banker's-style rounding to integer pence.
 */
function toBasePence(amountPence, fxRateToBase) {
  if (!Number.isInteger(amountPence)) {
    throw new Error(`toBasePence: amountPence must be integer pence, got ${amountPence}`);
  }
  const r = parseRate(fxRateToBase);
  return Math.round(amountPence * r);
}

/**
 * Compute the realised FX gain/loss in GBP pence when settling
 * `amountPence` of an invoice that was originally booked at
 * `issueRate` and settles at `settleRate`.
 *
 * Returns:
 *   { gainPence, lossPence }   exactly one will be > 0; the other 0.
 *
 * Sign convention: gain when the GBP we received exceeds the GBP we
 * originally booked; loss in the opposite case.
 */
function gainLossPence(amountPence, issueRate, settleRate) {
  if (!Number.isInteger(amountPence) || amountPence <= 0) {
    throw new Error('gainLossPence: amountPence must be positive integer');
  }
  const a = toBasePence(amountPence, issueRate);
  const b = toBasePence(amountPence, settleRate);
  const diff = b - a;
  if (diff === 0) return { gainPence: 0, lossPence: 0 };
  if (diff > 0) return { gainPence: diff, lossPence: 0 };
  return { gainPence: 0, lossPence: -diff };
}

module.exports = {
  toBasePence,
  gainLossPence,
  parseRate,
};
