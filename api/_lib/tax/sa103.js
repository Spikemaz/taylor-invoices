/**
 * Stage 5 — Self Assessment SA103 (self-employment) figures.
 *
 * Combines:
 *   profit.js                 → turnover + accounting profit + tax adjustments
 *   capital-allowances.js     → AIA + WDA totals (computes if not yet snapshotted)
 *   trading allowance         → £1,000 toggle vs actual expenses
 *   income-tax.js             → bands + NI + PA taper
 *
 * Returns a structure that maps directly onto the SA103S short form
 * boxes (the long SA103F adds details slice 1 doesn't yet capture).
 *
 *   box 9   turnover                           = turnoverPence
 *   box 10  any other business income          = additionalIncomePence (caller-supplied)
 *   box 11  trading-income allowance           = if useTradingAllowance
 *   box 19  total allowable expenses           = allowableExpensesPence
 *   box 20  net profit (or loss) for tax       = adjusted profit pre-allowances
 *   box 21  total additions to net profit      = disallowables + capital P&L
 *   box 24  capital allowances                 = AIA + WDA
 *   box 28  total taxable profits              = final taxable profit for tax bill
 *
 * The numbers driving the live "Estimated tax bill" widget are
 * derived in this same call so the dashboard never has to combine
 * multiple endpoints.
 */

const { computeTradingProfit } = require('./profit');
const { computeAllowancesForYear } = require('./capital-allowances');
const { getRules } = require('./rules');
const {
  computePersonalAllowance,
  computeIncomeTax,
  computeNI,
} = require('./income-tax');

/**
 * Compute the full SA103 view.
 *
 * options:
 *   region                  — 'rUK' | 'scotland' (default rUK)
 *   useTradingAllowance     — true: claim the £1,000 trading allowance
 *                             instead of allowable expenses + AIA. The
 *                             engine picks whichever produces the
 *                             higher taxable profit by default
 *                             (HMRC rule: if turnover ≤ £1k and you
 *                             elect, no return required).
 *   additionalIncomePence   — other (non-self-employed) income, used
 *                             only for PA taper and band stacking;
 *                             we don't tax it here (other-income tax
 *                             is the user's separate problem in slice 1)
 *   pensionContribPence     — gross pension contribution; extends the
 *                             basic-rate band by this amount.
 *   skipCapitalAllowances   — for what-if snapshots (don't persist)
 */
async function computeSA103(entityId, taxYear, options = {}) {
  if (!entityId) throw new Error('entityId required');
  if (!Number.isInteger(taxYear)) throw new Error('taxYear must be an integer');
  const region = options.region || 'rUK';
  const additionalIncomePence = options.additionalIncomePence || 0;
  const pensionContribPence = options.pensionContribPence || 0;
  const tradingAllowanceMode = options.tradingAllowanceMode || 'auto'; // 'auto' | 'always' | 'never'

  const [rules, profit] = await Promise.all([
    getRules(taxYear, region),
    computeTradingProfit(entityId, taxYear),
  ]);

  // Capital allowances (AIA + WDA) are claimable INSTEAD of trading
  // allowance, never alongside.
  let capitalAllowances;
  if (options.skipCapitalAllowances) {
    capitalAllowances = { totalClaimPence: 0, pools: [], assetCount: 0 };
  } else {
    capitalAllowances = await computeAllowancesForYear(entityId, taxYear, { region });
  }

  // Path A — claim actual expenses + capital allowances.
  const taxableA = Math.max(
    0,
    profit.taxableTradingProfitPreAllowancesPence - capitalAllowances.totalClaimPence
  );

  // Path B — claim £1,000 trading allowance.
  // SA rule: trading-allowance election replaces all expenses + cap.
  // allowances. Taxable profit = max(0, turnover − allowance).
  const taxableB = Math.max(0, profit.turnoverPence - rules.tradingAllowancePence);

  let taxableTradingProfit;
  let useTradingAllowance;
  if (tradingAllowanceMode === 'always') {
    taxableTradingProfit = taxableB;
    useTradingAllowance = true;
  } else if (tradingAllowanceMode === 'never') {
    taxableTradingProfit = taxableA;
    useTradingAllowance = false;
  } else {
    // auto: pick the path producing the LOWER taxable profit.
    if (taxableB < taxableA) {
      taxableTradingProfit = taxableB;
      useTradingAllowance = true;
    } else {
      taxableTradingProfit = taxableA;
      useTradingAllowance = false;
    }
  }

  // Income-tax stack: trading profit + additional income → PA → bands.
  const totalIncomePence = taxableTradingProfit + additionalIncomePence;
  const personalAllowancePence = computePersonalAllowance(totalIncomePence, rules);
  const taxableAfterPA = Math.max(0, totalIncomePence - personalAllowancePence);

  // Apply pension-contrib band-extension by shifting the higher-rate
  // threshold up by `pensionContribPence`. We mutate a local copy of
  // the bands so the original rule object stays intact.
  const adjustedBands = rules.incomeTaxBands.map((b, i) =>
    i === 0 ? { ...b } : { ...b, thresholdPence: b.thresholdPence + pensionContribPence }
  );
  const incomeTax = computeIncomeTax(taxableAfterPA, { ...rules, incomeTaxBands: adjustedBands });

  // NI is on trading profit only (NOT additional income).
  const ni = computeNI(taxableTradingProfit, rules);

  const totalTaxBillPence = incomeTax.taxPence + ni.totalPence;

  // SA103S box mapping — names follow the HMRC short-form boxes.
  const boxes = {
    box9_turnoverPence: profit.turnoverPence,
    box10_otherBusinessIncomePence: 0,
    box11_tradingAllowanceClaimedPence: useTradingAllowance ? rules.tradingAllowancePence : 0,
    box19_totalAllowableExpensesPence: useTradingAllowance ? 0 : profit.allowableExpensesPence,
    box20_netProfitPence: profit.accountingProfitPence,
    box21_totalAdditionsPence: profit.taxAdjustmentsPence,
    box24_capitalAllowancesPence: useTradingAllowance ? 0 : capitalAllowances.totalClaimPence,
    box28_totalTaxableProfitsPence: taxableTradingProfit,
  };

  return {
    taxYear,
    region,
    rulesetVersion: { /* non-empty so callers can detect rule drift */
      personalAllowancePence: rules.personalAllowancePence,
      basicRateUpperPence: rules.incomeTaxBands[1]?.thresholdPence ?? null,
    },
    profit,
    capitalAllowances,
    pathSelected: useTradingAllowance ? 'trading_allowance' : 'actual_expenses_plus_capital_allowances',
    taxableTradingProfitPence: taxableTradingProfit,
    additionalIncomePence,
    totalIncomePence,
    personalAllowancePence,
    taxableAfterPAPence: taxableAfterPA,
    incomeTax,
    ni,
    totalTaxBillPence,
    pensionContribPence,
    boxes,
  };
}

/**
 * "What if" simulator: pure delta. Re-runs computeSA103 with overrides
 * and returns BOTH the baseline and the projected result + the diff
 * fields the dashboard slider cares about.
 */
async function whatIf(entityId, taxYear, overrides = {}, options = {}) {
  const baseline = await computeSA103(entityId, taxYear, { ...options, skipCapitalAllowances: true });
  const projected = await computeSA103(entityId, taxYear, {
    ...options,
    skipCapitalAllowances: true,
    additionalIncomePence: (options.additionalIncomePence || 0) + (overrides.additionalIncomePence || 0),
    pensionContribPence: (options.pensionContribPence || 0) + (overrides.pensionContribPence || 0),
  });
  return {
    baseline: {
      totalTaxBillPence: baseline.totalTaxBillPence,
      taxableTradingProfitPence: baseline.taxableTradingProfitPence,
      personalAllowancePence: baseline.personalAllowancePence,
    },
    projected: {
      totalTaxBillPence: projected.totalTaxBillPence,
      taxableTradingProfitPence: projected.taxableTradingProfitPence,
      personalAllowancePence: projected.personalAllowancePence,
    },
    deltaPence: projected.totalTaxBillPence - baseline.totalTaxBillPence,
  };
}

module.exports = { computeSA103, whatIf };
