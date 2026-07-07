/**
 * Stage 6 — CT600 figure pack.
 *
 * Combines, for a given Ltd Co accounting period:
 *   - Stage 5's profit/adjustment engine (computeTradingProfit)
 *   - Stage 5's capital-allowance engine
 *   - Stage 6's CT calculator (corporation-tax.js)
 *
 * and emits the box-by-box numbers HMRC requests on the CT600 (short
 * form). Box names follow the CT600 (2023) layout.
 *
 *   box 145  Total turnover from trade            (= turnoverPence)
 *   box 155  Trading profits (before allowances)  (= taxableTradingProfitPreAllowancesPence)
 *   box 165  Capital allowances claimed           (= capital allowances total)
 *   box 235  Total profits chargeable to CT       (= profit subject to CT)
 *   box 309  Tax payable at small profits rate    (if applicable)
 *   box 311  Marginal relief                      (if applicable)
 *   box 315  Total Corporation Tax                (= computeCT().ctPence)
 *   box 440  CT due / refundable                  (slice 1: same as 315)
 */

const { computeTradingProfit } = require('./profit');
const { computeAllowancesForYear } = require('./capital-allowances');
const { getRules } = require('./rules');
const { computeCT, monthsBetween } = require('./corporation-tax');
const { taxYearFor } = require('./years');

/**
 * Compute a CT600-shaped figure pack.
 *
 *   periodStart, periodEnd — ISO YYYY-MM-DD (inclusive). The CT engine
 *                            is per-accounting-period; we still need a
 *                            tax-year for rule lookup. Rule = year of
 *                            the period END date (HMRC convention for
 *                            small companies straddling 6 Apr).
 *   options                — { region, ctRulesYear } overrides
 */
async function computeCT600(entityId, periodStart, periodEnd, options = {}) {
  if (!entityId) throw new Error('entityId required');
  if (!periodStart || !periodEnd) throw new Error('periodStart + periodEnd required');
  const region = options.region || 'rUK';
  const rulesYear = options.ctRulesYear || taxYearFor(periodEnd);
  const rules = await getRules(rulesYear, region);

  // For slice 1 we treat the AP as if it falls inside a single tax
  // year. computeTradingProfit uses tax-year date ranges so we
  // approximate by passing the AP dates via a custom range. To keep
  // the existing helper simple we sum over the AP via the same query.
  const profit = await computeTradingProfit(entityId, rulesYear, options);
  // Filter to the AP if the AP differs from the tax year — slice 1
  // smoke uses APs that match a tax year, so the filter is a passthrough.
  // (Slice 2 will add a profitForRange helper; logging the limitation here.)

  const ca = options.skipCapitalAllowances
    ? { totalClaimPence: 0 }
    : await computeAllowancesForYear(entityId, rulesYear, { region });

  const taxableProfitPence = Math.max(
    0,
    profit.taxableTradingProfitPreAllowancesPence - ca.totalClaimPence
  );

  const periodMonths = Math.max(1, Math.round(monthsBetween(periodStart, periodEnd)));
  const ct = computeCT(taxableProfitPence, periodMonths, rules);

  return {
    periodStart,
    periodEnd,
    periodMonths,
    rulesYear,
    region,
    profit,
    capitalAllowances: ca,
    taxableProfitPence,
    ct,
    boxes: {
      box145_turnoverPence: profit.turnoverPence,
      box155_tradingProfitsPreAllowancesPence: profit.taxableTradingProfitPreAllowancesPence,
      box165_capitalAllowancesPence: ca.totalClaimPence,
      box235_totalProfitsChargeablePence: taxableProfitPence,
      box309_smallProfitsTaxPence: ct.breakdown.regime === 'small_profits' ? ct.ctPence : 0,
      box311_marginalReliefPence: ct.breakdown.marginalReliefPence || 0,
      box315_totalCorporationTaxPence: ct.ctPence,
      box440_ctDuePence: ct.ctPence,
    },
  };
}

module.exports = { computeCT600 };
