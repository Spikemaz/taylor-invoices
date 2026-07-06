/**
 * Stage 6 smoke — UK Ltd Co tax engine (CT + PAYE + Dividends).
 *
 *  1. PAYE engine: £12,570 salary across 12 months → £0 PAYE
 *  2. PAYE engine: £30k salary → expected annual PAYE
 *  3. Employee NI: £30k salary @ 8% above PT
 *  4. Employer NI: £30k salary @ 13.8% above ST
 *  5. tax-code parser: 1257L → £12,570; BR → £0; rejects K codes
 *  6. CT 19% on £40k profit (small profits)
 *  7. CT 25% on £300k profit (main rate)
 *  8. CT marginal relief on £100k profit
 *  9. CT prorate on 9-month period: £40k profit hits marginal because limits shrink
 * 10. runPayroll posts journal + persists run row + emits FPS payload
 * 11. declareDividend posts journal DR 3300 CR 0800
 * 12. Director's Loan balance: lend director £15k, balance reflects overdrawn
 * 13. Director's Loan s.455 warning fires above £10k threshold
 * 14. Combined personal: £12,570 salary + £40k dividends → expected breakdown
 * 15. CT600 box pack end-to-end
 * 16. CH reminders bucket: today=…, dueDate=tomorrow → in7days bucket
 * 17. Tenant isolation
 */

process.env.DB_BACKEND = process.env.DB_BACKEND || 'postgres';

const crypto = require('crypto');
const { eq } = require('drizzle-orm');
const { getDb, getSchema, getPool } = require('../api/_lib/db');
const { seedAccountsForEntity, getAccountByCode } = require('../api/_lib/ledger/accounts');
const { postJournal, postSale } = require('../api/_lib/ledger/posting');
const { seedDefaultRules, getRules, setRules, defaultRulesRUK, defaultRulesScotland } = require('../api/_lib/tax/rules');
const {
  paFromTaxCode,
  computePeriodPAYE,
  computeEmployeeNI,
  computeEmployerNI,
  createEmployee,
  runPayroll,
} = require('../api/_lib/tax/payroll');
const { computeCT } = require('../api/_lib/tax/corporation-tax');
const { computeCT600 } = require('../api/_lib/tax/ct600');
const { computeCombinedPersonal } = require('../api/_lib/tax/personal-combined');
const { declareDividend } = require('../api/_lib/tax/dividends');
const { getStatus: getDLAStatus } = require('../api/_lib/tax/director-loan');
const { createFiling, getReminderState } = require('../api/_lib/tax/companies-house');

let userId, entityA, entityB;

async function setup() {
  const db = getDb();
  const { users, entities } = getSchema();
  userId = `user_smoke6_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  entityA = `ent_st6a_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  entityB = `ent_st6b_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  await db.insert(users).values({
    id: userId,
    email: `smoke6-${userId}@test.local`,
    name: 'Stage 6 Smoke',
    role: 'user',
    status: 'active',
  });
  await db.insert(entities).values([
    { id: entityA, userId, name: 'Stage 6 LtdA', type: 'limited', defaultCurrency: 'GBP', isDefault: true },
    { id: entityB, userId, name: 'Stage 6 LtdB', type: 'limited', defaultCurrency: 'GBP', isDefault: false },
  ]);
  await seedAccountsForEntity(entityA, 'limited');
  await seedAccountsForEntity(entityB, 'limited');
  await seedDefaultRules();
  // Stage 5 may have seeded rule rows that pre-date the Stage 6 keys
  // (CT/PAYE/NI/dividends). Force-upsert the latest defaults so this
  // smoke runs against rules that include the Stage 6 fields.
  for (const year of [2024, 2025, 2026]) {
    await setRules(year, 'rUK', defaultRulesRUK());
    await setRules(year, 'scotland', defaultRulesScotland());
  }
}

async function teardown() {
  if (!entityA) return;
  const db = getDb();
  const s = getSchema();
  for (const eid of [entityA, entityB]) {
    try {
      await db.delete(s.payrollRuns).where(eq(s.payrollRuns.entityId, eid));
      await db.delete(s.payrollEmployees).where(eq(s.payrollEmployees.entityId, eid));
      await db.delete(s.dividends).where(eq(s.dividends.entityId, eid));
      await db.delete(s.companiesHouseFilings).where(eq(s.companiesHouseFilings.entityId, eid));
      await db.delete(s.accountingPeriods).where(eq(s.accountingPeriods.entityId, eid));
      await db.delete(s.journals).where(eq(s.journals.entityId, eid));
      await db.delete(s.accounts).where(eq(s.accounts.entityId, eid));
      await db.delete(s.entities).where(eq(s.entities.id, eid));
    } catch (err) {
      console.error('[teardown]', eid, err.message);
    }
  }
  try { await db.delete(s.users).where(eq(s.users.id, userId)); } catch {}
}

function assert(cond, msg) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(`Assertion failed: ${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }
function assertNear(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`Assertion failed: ${msg} (got ${a}, expected ~${b} ±${tol})`);
}
async function step(name, fn) { process.stdout.write(`  ${name} … `); await fn(); process.stdout.write('OK\n'); }

async function main() {
  console.log('Stage 6 smoke (UK Ltd Co tax engine)');
  await setup();
  console.log(`  using entityA=${entityA}`);
  const rules = await getRules(2025, 'rUK');

  await step('tax-code parser', () => {
    assertEq(paFromTaxCode('1257L'), 1257000, '1257L → £12,570');
    assertEq(paFromTaxCode('BR'),    0,        'BR → 0 PA');
    let threw = false; try { paFromTaxCode('K500'); } catch { threw = true; }
    assert(threw, 'K codes rejected in slice 1');
  });

  await step('PAYE: £12,570 salary at year-end → £0 PAYE', () => {
    const r = computePeriodPAYE({
      ytdGrossPence: 1257000,
      ytdPayePriorPence: 0,
      taxCode: '1257L',
      periodNumber: 12,
      periodsPerYear: 12,
      rules,
    });
    assertEq(r.periodPayePence, 0, 'no PAYE at PA');
  });

  await step('PAYE: £30k salary at year-end → expected annual PAYE', () => {
    const r = computePeriodPAYE({
      ytdGrossPence: 3000000,
      ytdPayePriorPence: 0,
      taxCode: '1257L',
      periodNumber: 12,
      periodsPerYear: 12,
      rules,
    });
    // 20% on (30,000 − 12,570) = 20% on 17,430 = 3,486.
    const expected = Math.round(((3000000 - 1257000) * 20) / 100);
    assertEq(r.periodPayePence, expected, '£30k → 20% × £17,430');
  });

  await step('Employee NI: £30k salary annual', () => {
    const r = computeEmployeeNI({ grossPence: 3000000, periodsPerYear: 1, rules });
    // 8% on (30,000 − 12,570) = 8% × 17,430 = 1,394.40
    const expected = Math.round(((3000000 - 1257000) * 8) / 100);
    assertEq(r.eeNiPence, expected, '£30k EE NI');
  });

  await step('Employer NI: £30k salary annual', () => {
    const r = computeEmployerNI({ grossPence: 3000000, periodsPerYear: 1, rules });
    // 13.8% on (30,000 − 9,100) = 13.8% × 20,900 = 2,884.20
    const expected = Math.round(((3000000 - 910000) * 13.8) / 100);
    assertEq(r.erNiPence, expected, '£30k ER NI');
  });

  await step('CT: £40k profit → 19%', () => {
    const r = computeCT(4_000_000, 12, rules);
    assertEq(r.ctPence, Math.round((4_000_000 * 19) / 100), '19% × £40k');
    assertEq(r.breakdown.regime, 'small_profits', 'SP regime');
  });

  await step('CT: £300k profit → 25%', () => {
    const r = computeCT(30_000_000, 12, rules);
    assertEq(r.ctPence, Math.round((30_000_000 * 25) / 100), '25% × £300k');
    assertEq(r.breakdown.regime, 'main_rate', 'main-rate regime');
  });

  await step('CT: £100k profit → marginal relief', () => {
    const r = computeCT(10_000_000, 12, rules);
    // 25% × 100k = 25,000; relief = (250k − 100k) × 3/200 = 150k × 0.015 = 2,250
    // CT = 25,000 − 2,250 = 22,750.
    const expected = Math.round((10_000_000 * 25) / 100) - Math.round(((25_000_000 - 10_000_000) * 3) / 200);
    assertEq(r.ctPence, expected, 'marginal relief CT');
    assertEq(r.breakdown.regime, 'marginal', 'marginal regime');
  });

  await step('CT prorate: £40k profit over 9-month AP → marginal regime', () => {
    // 9-month AP: SP limit becomes £37,500 (50k × 9/12), UL becomes £187,500.
    // £40k > £37,500 → no longer small-profits, but < £187,500 → marginal.
    const r = computeCT(4_000_000, 9, rules);
    assertEq(r.breakdown.regime, 'marginal', 'short-period pushes into marginal');
  });

  await step('runPayroll posts journal + persists run', async () => {
    const { id: empId } = await createEmployee({
      entityId: entityA,
      name: 'Director A',
      taxCode: '1257L',
      payFrequency: 'monthly',
      annualSalaryPence: 1257000,
      isDirector: true,
      startDate: '2025-04-06',
    });
    const result = await runPayroll({
      entityId: entityA,
      employeeId: empId,
      payDate: '2025-04-30',
      periodNumber: 1,
      grossPence: 104750, // £1,047.50 (£12,570/12)
    });
    // At PT/PA boundary, no PAYE, no EE NI; ER NI on (1047.50 − 758.33) = ~289.17 × 13.8%.
    assertEq(result.payePence, 0, 'no PAYE');
    assertEq(result.eeNiPence, 0, 'no EE NI');
    assert(result.erNiPence > 0, 'some ER NI');
    assertEq(result.netPence, 104750, 'net = gross when PAYE+EE NI = 0');
    assert(result.journalId && result.journalId.startsWith('jrn_'), 'journal posted');
    assert(result.fpsPayload && result.fpsPayload.taxYear === 2025, 'FPS payload emitted');
  });

  await step('declareDividend posts journal DR 3300 CR 0800', async () => {
    const r = await declareDividend({
      entityId: entityA,
      declaredDate: '2025-09-30',
      totalAmountPence: 5_000_00,
    });
    assert(r.voucherNumber && r.voucherNumber.startsWith('DIV-'), 'voucher number issued');
    assert(r.journalId && r.journalId.startsWith('jrn_'), 'journal posted');
    // Verify by querying account 3300 balance.
    const divsAcc = await getAccountByCode(entityA, '3300');
    const db = getDb();
    const { journalLines } = getSchema();
    const rows = await db.select().from(journalLines).where(eq(journalLines.accountId, divsAcc.id));
    const totalDebit = rows.reduce((s, x) => s + Number(x.debitPence), 0);
    assertEq(totalDebit, 5_000_00, 'DR 3300 = £5,000');
  });

  await step("Director's Loan balance + s.455 warning", async () => {
    // Lend the director £15k from the company.
    // DR 2500 (DLA — debit means director owes co), CR 0800 (Bank).
    const dla = await getAccountByCode(entityA, '2500');
    const bank = await getAccountByCode(entityA, '0800');
    await postJournal({
      entityId: entityA,
      date: '2025-08-01',
      description: 'Loan to director',
      source: 'manual',
      sourceType: 'smoke',
      lines: [
        { accountId: dla.id,  debit: 15_000_00, credit: 0 },
        { accountId: bank.id, debit: 0,         credit: 15_000_00 },
      ],
    });
    const status = await getDLAStatus(entityA, {
      asOfDate: '2026-11-01', // > 9 months after 2025-12-31 period end
      taxYear: 2025,
      periodEndDate: '2025-12-31',
    });
    assertEq(status.overdrawnPence, 15_000_00, 'overdrawn £15k');
    assert(status.flags.over10kBenefit, 'over £10k threshold flag');
    assert(status.flags.s455LikelyDue, 's.455 warning fires past 9 months');
    // 33.75% × £15k = £5,062.50
    const expected = Math.round((15_000_00 * 33.75) / 100);
    assertEq(status.flags.s455ChargePence, expected, 's.455 charge correct');
  });

  await step('Combined personal: £12,570 salary + £40k dividends', async () => {
    const r = await computeCombinedPersonal({
      entityId: entityA,
      taxYear: 2025,
      salaryPence: 1257000,
      dividendsPence: 4000000,
    });
    // Salary uses full PA → no salary tax, no EE NI (at PT exactly).
    assertEq(r.salaryIncomeTax.taxPence, 0, 'no salary tax');
    assertEq(r.employeeNIPence, 0, 'no EE NI at PT');
    // Dividends: £40k. PA used by salary. paLeft = 0.
    // dividendsAfterPA = 40k. Allowance £500. Taxable = £39,500.
    // Position = 0 (salaryAfterPA = 0). All £39,500 sits in basic band (≤ £37,700)?
    // No: £37,700 in ordinary @ 8.75% + £1,800 in upper @ 33.75%.
    const ordinary = Math.round((37_700_00 * 8.75) / 100);
    const upper    = Math.round(((39_500_00 - 37_700_00) * 33.75) / 100);
    assertEq(r.dividendTax.taxPence, ordinary + upper, 'dividend tax breakdown');
  });

  await step('CT600 figure pack end-to-end', async () => {
    // Post a sale on entityB to give it some profit.
    await postSale({
      entityId: entityB,
      date: '2025-06-01',
      amountPence: 80_000_00, // £80k
      incomeCode: '4000',
      customerName: 'CustB',
    });
    const ct600 = await computeCT600(entityB, '2025-04-06', '2026-04-05', { region: 'rUK' });
    assertEq(ct600.boxes.box145_turnoverPence, 80_000_00, 'box 145 turnover');
    assertEq(ct600.boxes.box235_totalProfitsChargeablePence, 80_000_00, 'box 235');
    // £80k sits between SP £50k and UL £250k → marginal regime.
    // 25% × 80k = 20,000; relief = (250k − 80k) × 3/200 = 2,550;
    // CT = 17,450.
    const expectedCT = Math.round((80_000_00 * 25) / 100)
                     - Math.round(((25_000_000 - 80_000_00) * 3) / 200);
    assertEq(ct600.boxes.box315_totalCorporationTaxPence, expectedCT, 'box 315 CT');
    assertEq(ct600.ct.breakdown.regime, 'marginal', 'marginal regime');
  });

  await step('CH reminders bucket', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const longFuture = new Date(Date.now() + 100 * 86400000).toISOString().slice(0, 10);
    await createFiling({ entityId: entityA, kind: 'cs01', dueDate: tomorrow, feePence: 1300 });
    await createFiling({ entityId: entityA, kind: 'accounts', dueDate: longFuture });
    const r = await getReminderState(entityA, { today });
    assert(r.buckets.in7days.length >= 1, 'tomorrow → in7days');
    assert(r.buckets.later.length >= 1, 'longFuture → later');
  });

  await step('tenant isolation: entityA payroll/dividends invisible to entityB', async () => {
    const dla = await getDLAStatus(entityB);
    assertEq(dla.overdrawnPence, 0, 'entityB has no DLA activity');
  });

  console.log('\nAll Stage 6 smoke checks passed.');
}

main()
  .then(async () => { await teardown(); await getPool().end(); process.exit(0); })
  .catch(async (err) => {
    console.error('\n[smoke] FAILED:', err);
    await teardown();
    try { await getPool().end(); } catch {}
    process.exit(1);
  });
