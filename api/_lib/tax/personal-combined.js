/**
 * Stage 6 — Combined personal tax view for a Ltd Co director.
 *
 * Stacks (in order of band consumption):
 *   1. Salary (non-savings income)
 *      - Personal allowance applied first
 *      - Then standard income-tax bands (20 / 40 / 45)
 *      - Plus Class 1 EE NI on the salary (slice 1: assumes annual)
 *   2. Dividends
 *      - Use any leftover personal allowance
 *      - Apply the £500 dividend allowance (taxed at 0% but consumes
 *        band space)
 *      - Dividend bands: 8.75 / 33.75 / 39.35 at the corresponding
 *        income-tax band positions
 *
 * Other income (interest, rent etc.) is out of scope for slice 1.
 * Assumes rUK bands; computeIncomeTax handles Scotland for the
 * salary portion if the caller passes a Scottish region.
 */

const { getRules } = require('./rules');
const { computePersonalAllowance, computeIncomeTax } = require('./income-tax');

async function computeCombinedPersonal({
  entityId,
  taxYear,
  salaryPence,
  dividendsPence,
  region = 'rUK',
}) {
  if (typeof salaryPence !== 'number' || typeof dividendsPence !== 'number') {
    throw new Error('salaryPence + dividendsPence required (numbers)');
  }
  const rules = await getRules(taxYear, region);
  const totalIncomePence = salaryPence + dividendsPence;
  const personalAllowancePence = computePersonalAllowance(totalIncomePence, rules);

  // PA fills salary first.
  const salaryAfterPA = Math.max(0, salaryPence - personalAllowancePence);
  const paLeftForDividends = Math.max(0, personalAllowancePence - salaryPence);
  const dividendsAfterPA = Math.max(0, dividendsPence - paLeftForDividends);

  // Salary income tax — uses the standard rUK / Scotland bands.
  const salaryIT = computeIncomeTax(salaryAfterPA, rules);

  // Dividend bands sit at the SAME band thresholds as income tax
  // (basic-rate band ends at £37,700 of taxable income; higher ends
  // at £125,140). We position dividends in the band stack starting
  // at salaryAfterPA.
  const basicTopPence = rules.incomeTaxBands[1]?.thresholdPence ?? 3770000;
  const higherTopPence = rules.incomeTaxBands[rules.incomeTaxBands.length - 1]?.thresholdPence ?? 12514000;

  // Effective taxable dividends = dividendsAfterPA − allowance.
  // (Allowance is a 0% rate but still occupies band space; functionally
  //  the result is identical to subtracting from the total.)
  const taxableDividendsPence = Math.max(0, dividendsAfterPA - rules.dividendAllowancePence);

  // Walk the dividend bands.
  let pos = salaryAfterPA;
  let remaining = taxableDividendsPence;
  let dividendTaxPence = 0;
  const dividendBreakdown = [];
  const bands = [
    { upperPence: basicTopPence,  rate: rules.dividendOrdinaryRate,   label: 'ordinary' },
    { upperPence: higherTopPence, rate: rules.dividendUpperRate,      label: 'upper' },
    { upperPence: Infinity,       rate: rules.dividendAdditionalRate, label: 'additional' },
  ];
  for (const b of bands) {
    if (remaining <= 0) break;
    if (pos >= b.upperPence) continue;
    const slot = b.upperPence - pos;
    const take = Math.min(remaining, slot);
    const tax = Math.round((take * b.rate) / 100);
    dividendTaxPence += tax;
    dividendBreakdown.push({ band: b.label, rate: b.rate, portionPence: take, taxPence: tax });
    pos += take;
    remaining -= take;
  }

  // Class 1 employee NI on the salary (annualised). For salaries at
  // or below the £12,570 PT no NI is due — we approximate using the
  // annual primary threshold.
  let eeNiPence = 0;
  if (salaryPence > rules.niEePrimaryThresholdPence) {
    const mainPortion = Math.min(salaryPence, rules.niEeUelPence) - rules.niEePrimaryThresholdPence;
    const upperPortion = Math.max(0, salaryPence - rules.niEeUelPence);
    eeNiPence = Math.round((mainPortion * rules.niEeMainRate) / 100)
              + Math.round((upperPortion * rules.niEeUpperRate) / 100);
  }

  return {
    taxYear,
    region,
    entityId,
    inputs: { salaryPence, dividendsPence },
    totalIncomePence,
    personalAllowancePence,
    paLeftForDividendsPence: paLeftForDividends,
    salaryAfterPAPence: salaryAfterPA,
    dividendsAfterPAPence: dividendsAfterPA,
    dividendAllowancePence: rules.dividendAllowancePence,
    taxableDividendsPence,
    salaryIncomeTax: salaryIT,
    dividendTax: { taxPence: dividendTaxPence, breakdown: dividendBreakdown },
    employeeNIPence: eeNiPence,
    totalPersonalTaxPence: salaryIT.taxPence + dividendTaxPence + eeNiPence,
  };
}

module.exports = { computeCombinedPersonal };
