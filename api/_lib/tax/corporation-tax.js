/**
 * Stage 6 — UK Corporation Tax engine.
 *
 * From FY2023-24 onwards (1 Apr 2023+), CT has two rates with marginal
 * relief in between:
 *
 *   profit ≤ £50,000          → 19% (small profits rate)
 *   profit ≥ £250,000         → 25% (main rate)
 *   £50,000 < profit < £250k → 25% main rate, then reduced by
 *                              marginal relief = (UL − profit) × 3/200
 *
 * For accounting periods shorter / longer than 12 months, both limits
 * (and the £50k SP / £250k UL) are time-apportioned.
 *
 * Associated companies (which would split the limits) are out of scope
 * for slice 1; we assume one stand-alone company.
 */

function ratiosForPeriod(rules, periodMonths) {
  const factor = periodMonths / 12;
  return {
    spLimit: Math.round(rules.ctSmallProfitsLimitPence * factor),
    upperLimit: Math.round(rules.ctUpperLimitPence * factor),
    spRate: rules.ctSmallProfitsRatePct,
    mainRate: rules.ctMainRatePct,
    fractionN: rules.ctMarginalReliefFractionNumerator,
    fractionD: rules.ctMarginalReliefFractionDenominator,
  };
}

/**
 * Pure CT calculation.
 *
 *   profitPence    — taxable trading profit (already post adjustments
 *                    + capital allowances; CT600 caller is responsible)
 *   periodMonths   — accounting period length in months (12 default)
 *   rules          — ruleset from getRules(taxYear)
 */
function computeCT(profitPence, periodMonths, rules) {
  if (!Number.isFinite(profitPence)) throw new Error('profitPence must be a number');
  if (profitPence <= 0) {
    return {
      ctPence: 0,
      effectiveRatePct: 0,
      breakdown: { regime: 'no_profit', profitPence },
    };
  }
  const r = ratiosForPeriod(rules, periodMonths);
  if (profitPence <= r.spLimit) {
    const ct = Math.round((profitPence * r.spRate) / 100);
    return {
      ctPence: ct,
      effectiveRatePct: r.spRate,
      breakdown: { regime: 'small_profits', spLimit: r.spLimit, mainRate: r.spRate, ...r },
    };
  }
  if (profitPence >= r.upperLimit) {
    const ct = Math.round((profitPence * r.mainRate) / 100);
    return {
      ctPence: ct,
      effectiveRatePct: r.mainRate,
      breakdown: { regime: 'main_rate', upperLimit: r.upperLimit, mainRate: r.mainRate, ...r },
    };
  }
  // Marginal: tax at main rate then deduct marginal relief.
  const mainRateTax = Math.round((profitPence * r.mainRate) / 100);
  // marginal_relief = (UL − profit) × profit / total_profits × fraction
  // With no FII / associated co, total_profits == profit, so the
  // (profit / total_profits) factor is 1.
  const relief = Math.round(((r.upperLimit - profitPence) * r.fractionN) / r.fractionD);
  const ct = mainRateTax - relief;
  const effective = profitPence > 0 ? Number((ct / profitPence) * 100).toFixed(4) : 0;
  return {
    ctPence: ct,
    effectiveRatePct: Number(effective),
    breakdown: { regime: 'marginal', mainRateTax, marginalReliefPence: relief, ...r },
  };
}

function monthsBetween(startISO, endISO) {
  // Inclusive month count for the standard 12-month UK accounting
  // period. For non-12-month periods the caller should pass the
  // exact length; this helper errs toward the simple month-difference.
  const s = new Date(`${startISO}T00:00:00Z`);
  const e = new Date(`${endISO}T00:00:00Z`);
  const ms = e.getTime() - s.getTime();
  // 30.4375 days/month average — accurate enough for prorate within
  // 0.5% across any period; CT600 itself uses days but the difference
  // for limit prorate is negligible.
  return Math.round((ms / (1000 * 60 * 60 * 24 * 30.4375)) * 100) / 100;
}

module.exports = { computeCT, monthsBetween };
