/**
 * IAccountant — map legacy Sheets invoices into the shape the ledger
 * backfill expects, plus entity-type normalisation.
 *
 * CRITICAL revenue semantics (see public/index.html invoice generation):
 *   - `gross`  = the PRACTICE's total patient billing ("Gross Total").
 *   - `amount` = the hygienist's actual income = "Balance Due"
 *                = isAdhoc ? gross : gross * (commRate / 100).
 *
 * The hygienist's REVENUE (P&L Sales) is `amount`, NOT `gross`. Posting
 * `gross` would overstate income by ~1/commRate (≈3x at a 35% share).
 */

const SOLE_ALIASES = new Set([
  'self', 'self-employed', 'self employed', 'selfemployed',
  'sole', 'sole_trader', 'sole trader', 'soletrader', 'st',
]);
const LIMITED_ALIASES = new Set([
  'ltd', 'limited', 'limited company', 'ltd company',
  'limited_company', 'company',
]);

/**
 * Normalise a legacy entity string to a Postgres entity type, or null if
 * unrecognised (caller should skip + surface in diagnostics, never guess).
 */
function normalizeEntityType(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (SOLE_ALIASES.has(s)) return 'sole_trader';
  if (LIMITED_ALIASES.has(s)) return 'limited';
  return null;
}

/**
 * The hygienist's income for an invoice, in pounds. Prefers the stored
 * `amount`; if missing/zero on a legacy row, reconstructs it from gross +
 * commRate + isAdhoc exactly as the app does at invoice-generation time.
 */
function invoiceIncomePounds(row) {
  const amount = parseFloat(row.amount);
  if (Number.isFinite(amount) && amount > 0) return amount;
  const gross = parseFloat(row.gross) || 0;
  if (gross <= 0) return 0;
  if (row.isAdhoc === true || row.isAdhoc === 'true') return gross;
  const commRate = parseFloat(row.commRate) || 0;
  return gross * (commRate / 100);
}

/**
 * Map a raw Sheets invoice row to the backfillInvoices() input shape.
 * `total` is the hygienist's income in pounds; backfill converts to pence.
 */
function mapInvoiceForBackfill(row) {
  return {
    id: row.num,
    date: row.date,
    total: invoiceIncomePounds(row),
    paidStatus: row.paidStatus,
    paidDate: row.paidDate,
    customerName: row.practiceName || row.practice || null,
  };
}

module.exports = { normalizeEntityType, invoiceIncomePounds, mapInvoiceForBackfill };
