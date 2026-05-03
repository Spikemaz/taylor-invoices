/**
 * Stage 5 — UK income-tax + NI calculators.
 *
 * Pure functions. No DB. Inputs in pence, outputs in pence.
 *
 *   computePersonalAllowance(income, rules)
 *     PA = max(0, base - max(0, income - taperStart) / 2)
 *
 *   computeIncomeTax(taxableAfterPA, rules)
 *     Walks the rules' bands (cumulative thresholds in TAXABLE-income
 *     space, post-PA) and returns a band-by-band breakdown.
 *
 *   computeNI(profitPence, rules)
 *     Class 2 (flat-weekly above SPT, conditional on
 *     `class2AbolishedAtLpl`) + Class 4 (main rate between LPL/UPL,
 *     upper rate above UPL).
 */

function computePersonalAllowance(totalIncomePence, rules) {
  const base = rules.personalAllowancePence;
  const start = rules.personalAllowanceTaperStartPence;
  if (totalIncomePence <= start) return base;
  const taper = Math.floor((totalIncomePence - start) / 2);
  return Math.max(0, base - taper);
}

/**
 * Apply income-tax bands to TAXABLE income (already net of PA).
 * Bands are sorted ascending by their cumulative `thresholdPence`.
 * The threshold is the lower edge of each band, inclusive; the upper
 * edge is the next band's threshold (or +∞).
 */
function computeIncomeTax(taxablePence, rules) {
  if (taxablePence <= 0) return { taxPence: 0, breakdown: [] };
  const bands = [...rules.incomeTaxBands].sort((a, b) => a.thresholdPence - b.thresholdPence);
  const breakdown = [];
  let totalTax = 0;
  for (let i = 0; i < bands.length; i += 1) {
    const lo = bands[i].thresholdPence;
    const hi = i + 1 < bands.length ? bands[i + 1].thresholdPence : Infinity;
    if (taxablePence <= lo) break;
    const portion = Math.min(taxablePence, hi) - lo;
    if (portion <= 0) continue;
    const taxOnBand = Math.round((portion * bands[i].rate) / 100);
    totalTax += taxOnBand;
    breakdown.push({
      rate: bands[i].rate,
      fromPence: lo,
      toPence: Number.isFinite(hi) ? hi : null,
      portionPence: portion,
      taxPence: taxOnBand,
    });
  }
  return { taxPence: totalTax, breakdown };
}

function computeNI(profitPence, rules) {
  let class2Pence = 0;
  if (profitPence >= rules.class2SmallProfitsThresholdPence) {
    if (rules.class2AbolishedAtLpl && profitPence >= rules.class4LowerPence) {
      // FY24-25+: Class 2 abolished for profits ≥ LPL; the year is
      // still credited but the tax bill is £0.
      class2Pence = 0;
    } else {
      class2Pence = rules.class2WeeklyPence * rules.class2WeeksPerYear;
    }
  }
  let class4MainPence = 0;
  let class4UpperPence = 0;
  if (profitPence > rules.class4LowerPence) {
    const mainPortion = Math.min(profitPence, rules.class4UpperPence) - rules.class4LowerPence;
    if (mainPortion > 0) {
      class4MainPence = Math.round((mainPortion * rules.class4MainRate) / 100);
    }
    if (profitPence > rules.class4UpperPence) {
      const upperPortion = profitPence - rules.class4UpperPence;
      class4UpperPence = Math.round((upperPortion * rules.class4UpperRate) / 100);
    }
  }
  return {
    class2Pence,
    class4MainPence,
    class4UpperPence,
    totalPence: class2Pence + class4MainPence + class4UpperPence,
  };
}

module.exports = { computePersonalAllowance, computeIncomeTax, computeNI };
