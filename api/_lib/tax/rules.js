/**
 * Stage 5 — Versioned tax-rule store.
 *
 * Each (taxYear, region) row in `tax_rules` carries a JSONB ruleset
 * with rates, thresholds and allowances. Storing as JSONB rather than
 * separate columns means HMRC's annual rate tweaks land as data, not
 * code. Rule shape:
 *
 *   {
 *     personalAllowancePence,
 *     personalAllowanceTaperStartPence,
 *     incomeTaxBands: [
 *       { thresholdPence, rate },   // taxable-income cumulative threshold
 *       ...
 *     ],
 *     dividendAllowancePence,        // Stage 6
 *     dividendBands: [...],          // Stage 6
 *     class2WeeklyPence, class2WeeksPerYear, class2SmallProfitsThresholdPence,
 *     class4LowerPence, class4UpperPence, class4MainRate, class4UpperRate,
 *     tradingAllowancePence,
 *     aiaLimitPence, mainPoolWdaRate, specialPoolWdaRate, sbaRate,
 *   }
 *
 * `seedDefaultRules()` is idempotent — safe to call on every server
 * boot. Values are best-effort current; an accountant can override
 * via the admin endpoint without redeploying.
 */

const { and, eq } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');

// =====================================================================
// Default rule sets (rUK)
// =====================================================================
//
// Sources: HMRC published rates as of FY2024-25 / FY2025-26.
//   Personal allowance:      £12,570
//   PA taper start:          £100,000 (£1 lost per £2 above)
//   Basic rate band (rUK):   £37,700 (20%)
//   Higher rate threshold:   £125,140 (40%)
//   Additional rate:         45% above £125,140
//   Class 2 weekly rate:     £3.45/wk (still on the books for voluntary;
//                            Class 2 effectively abolished from FY24-25
//                            for profits > LPL — engine reflects that
//                            with `class2AbolishedAtLpl: true`).
//   SPT (Small Profits):     £6,725
//   Class 4 LPL/UPL:         £12,570 / £50,270
//   Class 4 rates:           6% main / 2% upper (FY24-25 onwards)
//   Trading allowance:       £1,000
//   AIA limit:               £1,000,000
//   Main pool WDA:           18% reducing balance
//   Special pool WDA:        6% reducing balance
//   SBA:                     3% straight-line

function defaultRulesRUK() {
  return {
    region: 'rUK',
    personalAllowancePence: 1257000,
    personalAllowanceTaperStartPence: 10000000,
    incomeTaxBands: [
      { thresholdPence: 0,         rate: 20 }, // basic
      { thresholdPence: 3770000,   rate: 40 }, // higher (taxable above £37,700)
      { thresholdPence: 12514000,  rate: 45 }, // additional (taxable above £125,140)
    ],
    class2WeeklyPence: 345,
    class2WeeksPerYear: 52,
    class2SmallProfitsThresholdPence: 672500,
    class2AbolishedAtLpl: true,
    class4LowerPence: 1257000,
    class4UpperPence: 5027000,
    class4MainRate: 6,
    class4UpperRate: 2,
    tradingAllowancePence: 100000,
    aiaLimitPence: 100000000,
    mainPoolWdaRate: 18,
    specialPoolWdaRate: 6,
    sbaRate: 3,
    // ----- Stage 6 — Ltd Co additions -----
    // Employee NI (Class 1 primary) — current rates from Apr 2024
    niEePrimaryThresholdPence: 1257000,
    niEeUelPence: 5027000,
    niEeMainRate: 8,
    niEeUpperRate: 2,
    // Employer NI (Class 1 secondary)
    niErSecondaryThresholdPence: 910000,
    niErRate: 13.8,
    employmentAllowancePence: 500000,
    // Corporation Tax (FY2023+)
    ctSmallProfitsRatePct: 19,
    ctMainRatePct: 25,
    ctSmallProfitsLimitPence: 5000000,   // £50,000
    ctUpperLimitPence: 25000000,         // £250,000
    ctMarginalReliefFractionNumerator: 3,
    ctMarginalReliefFractionDenominator: 200,
    // Dividend tax (FY24-25)
    dividendAllowancePence: 50000,       // £500
    dividendOrdinaryRate: 8.75,
    dividendUpperRate: 33.75,
    dividendAdditionalRate: 39.35,
    // s.455 director's loan benefit charge (loans > £10k unpaid 9mo after YE)
    directorLoanThresholdPence: 1000000, // £10,000
    s455Rate: 33.75,
    // ----- Stage 7 — VAT -----
    vatStandardRatePct: 20,
    vatReducedRatePct: 5,
    vatZeroRatePct: 0,
    // Apr-2024 thresholds
    vatRegistrationThresholdPence: 9000000,    // £90,000 rolling 12-month turnover
    vatDeregistrationThresholdPence: 8800000,  // £88,000
    // Flat Rate Scheme: 1% discount in the first year of registration
    vatFrsFirstYearDiscountPct: 1,
    // Surcharge / late submission default points (slice 2 will use these)
    vatLateSubmissionPoints: 4,
  };
}

// Scotland uses different income-tax bands (not NI / not allowances).
// For TY2025, the bands roughly are: starter 19% to £14,876, basic 20%
// to £26,561, intermediate 21% to £43,662, higher 42% to £75,000,
// advanced 45% to £125,140, top 48%. Stored taxable-income thresholds
// (post-PA), in pence.
function defaultRulesScotland() {
  return {
    region: 'scotland',
    personalAllowancePence: 1257000,
    personalAllowanceTaperStartPence: 10000000,
    incomeTaxBands: [
      { thresholdPence: 0,         rate: 19 }, // starter
      { thresholdPence: 230600,    rate: 20 }, // basic   — taxable above £2,306
      { thresholdPence: 1399100,   rate: 21 }, // intermediate
      { thresholdPence: 3109200,   rate: 42 }, // higher
      { thresholdPence: 6243000,   rate: 45 }, // advanced
      { thresholdPence: 11257000,  rate: 48 }, // top
    ],
    class2WeeklyPence: 345,
    class2WeeksPerYear: 52,
    class2SmallProfitsThresholdPence: 672500,
    class2AbolishedAtLpl: true,
    class4LowerPence: 1257000,
    class4UpperPence: 5027000,
    class4MainRate: 6,
    class4UpperRate: 2,
    tradingAllowancePence: 100000,
    aiaLimitPence: 100000000,
    mainPoolWdaRate: 18,
    specialPoolWdaRate: 6,
    sbaRate: 3,
    // CT/PAYE/dividends are UK-wide — Scotland inherits.
    niEePrimaryThresholdPence: 1257000,
    niEeUelPence: 5027000,
    niEeMainRate: 8,
    niEeUpperRate: 2,
    niErSecondaryThresholdPence: 910000,
    niErRate: 13.8,
    employmentAllowancePence: 500000,
    ctSmallProfitsRatePct: 19,
    ctMainRatePct: 25,
    ctSmallProfitsLimitPence: 5000000,
    ctUpperLimitPence: 25000000,
    ctMarginalReliefFractionNumerator: 3,
    ctMarginalReliefFractionDenominator: 200,
    dividendAllowancePence: 50000,
    dividendOrdinaryRate: 8.75,
    dividendUpperRate: 33.75,
    dividendAdditionalRate: 39.35,
    directorLoanThresholdPence: 1000000,
    s455Rate: 33.75,
    // VAT is UK-wide (not devolved) — Scotland inherits.
    vatStandardRatePct: 20,
    vatReducedRatePct: 5,
    vatZeroRatePct: 0,
    vatRegistrationThresholdPence: 9000000,
    vatDeregistrationThresholdPence: 8800000,
    vatFrsFirstYearDiscountPct: 1,
    vatLateSubmissionPoints: 4,
  };
}

const DEFAULT_TAX_YEARS = [2024, 2025, 2026];

async function seedDefaultRules(opts = {}) {
  const writer = opts.tx || getDb();
  const { taxRules } = getSchema();
  for (const year of DEFAULT_TAX_YEARS) {
    for (const region of ['rUK', 'scotland']) {
      const existing = await writer
        .select()
        .from(taxRules)
        .where(and(eq(taxRules.taxYear, year), eq(taxRules.region, region)))
        .limit(1);
      if (existing[0]) continue;
      const ruleSet = region === 'scotland' ? defaultRulesScotland() : defaultRulesRUK();
      await writer.insert(taxRules).values({
        taxYear: year,
        region,
        ruleSet,
        notes: 'Seeded default — verify against HMRC current published rates.',
      });
    }
  }
  return { ok: true, years: DEFAULT_TAX_YEARS };
}

async function getRules(taxYear, region = 'rUK', opts = {}) {
  const reader = opts.tx || getDb();
  const { taxRules } = getSchema();
  const rows = await reader
    .select()
    .from(taxRules)
    .where(and(eq(taxRules.taxYear, taxYear), eq(taxRules.region, region)))
    .limit(1);
  if (!rows[0]) {
    // Lazy-seed on first read so a fresh DB / fresh tax year still works.
    await seedDefaultRules({ tx: opts.tx });
    const re = await reader
      .select()
      .from(taxRules)
      .where(and(eq(taxRules.taxYear, taxYear), eq(taxRules.region, region)))
      .limit(1);
    if (!re[0]) throw new Error(`no tax rules for ${taxYear}/${region}`);
    return re[0].ruleSet;
  }
  return rows[0].ruleSet;
}

async function setRules(taxYear, region, ruleSet, opts = {}) {
  const writer = opts.tx || getDb();
  const { taxRules } = getSchema();
  const existing = await writer
    .select()
    .from(taxRules)
    .where(and(eq(taxRules.taxYear, taxYear), eq(taxRules.region, region)))
    .limit(1);
  if (existing[0]) {
    await writer
      .update(taxRules)
      .set({ ruleSet, updatedAt: new Date(), notes: opts.notes || existing[0].notes })
      .where(and(eq(taxRules.taxYear, taxYear), eq(taxRules.region, region)));
  } else {
    await writer.insert(taxRules).values({ taxYear, region, ruleSet, notes: opts.notes || null });
  }
  return { ok: true };
}

module.exports = { seedDefaultRules, getRules, setRules, defaultRulesRUK, defaultRulesScotland };
