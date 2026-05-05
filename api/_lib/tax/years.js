/**
 * Stage 5 — UK tax-year helpers.
 *
 * The UK tax year runs 6 April → 5 April. We label it by the calendar
 * year that contains the start: TY2025 = 6 Apr 2025 → 5 Apr 2026.
 *
 * Date helpers are pure (no DB), so they're safe to use anywhere.
 * Persistence helpers (open/lock) talk to the `tax_years` table.
 */

const crypto = require('crypto');
const { and, eq } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');

function newTaxYearId() {
  return `tyr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Map any ISO date (YYYY-MM-DD) to its UK tax year label.
 * Mirrors the helper in api/_lib/expenses/mileage.js so the two
 * modules don't develop drift; both delegate here once Stage 6 lands.
 */
function taxYearFor(dateString) {
  if (!dateString) throw new Error('taxYearFor: dateString required');
  const [yStr, mStr, dStr] = dateString.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (!y || !m || !d) throw new Error(`taxYearFor: invalid date ${dateString}`);
  if (m > 4 || (m === 4 && d >= 6)) return y;
  return y - 1;
}

/**
 * The ISO date range for a tax year. Inclusive both ends.
 */
function taxYearRange(taxYear) {
  if (!Number.isInteger(taxYear)) throw new Error('taxYearRange: taxYear must be an integer');
  return {
    startDate: `${taxYear}-04-06`,
    endDate: `${taxYear + 1}-04-05`,
  };
}

async function ensureTaxYear(entityId, taxYear, opts = {}) {
  if (!entityId) throw new Error('entityId required');
  const writer = opts.tx || getDb();
  const { taxYears } = getSchema();
  const existing = await writer
    .select()
    .from(taxYears)
    .where(and(eq(taxYears.entityId, entityId), eq(taxYears.taxYear, taxYear)))
    .limit(1);
  if (existing[0]) return existing[0];
  const id = newTaxYearId();
  await writer.insert(taxYears).values({
    id,
    entityId,
    taxYear,
    region: opts.region || 'rUK',
    status: 'open',
  });
  const fresh = await writer
    .select()
    .from(taxYears)
    .where(eq(taxYears.id, id))
    .limit(1);
  return fresh[0];
}

async function lockTaxYear(entityId, taxYear, opts = {}) {
  const writer = opts.tx || getDb();
  const { taxYears } = getSchema();
  await writer
    .update(taxYears)
    .set({
      status: 'locked',
      lockedAt: new Date(),
      lockedBy: opts.actor?.userId || null,
      updatedAt: new Date(),
    })
    .where(and(eq(taxYears.entityId, entityId), eq(taxYears.taxYear, taxYear)));
  return { ok: true };
}

module.exports = { taxYearFor, taxYearRange, ensureTaxYear, lockTaxYear };
