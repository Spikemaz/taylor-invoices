/**
 * Stage 7 smoke — UK VAT + MTD engine.
 *
 *   1. Tenant setup + CoA seeded with VAT control (2200)
 *   2. registerForVAT(scheme=standard) inserts row
 *   3. Capture output VAT on a sale and input VAT on an expense
 *   4. computeReturn standard scheme: boxes 1, 4, 5, 6, 7 correct
 *   5. computeReturn flat_rate: box1 = grossSales × FRS%; box6 = grossSales
 *   6. computeReturn cash basis: only paid invoices land in box1/6
 *   7. submitReturn locks the captured lines + records receipt
 *   8. Re-submit same periodKey → 409 / VAT_RETURN_DUPLICATE
 *   9. After lock: subsequent computeReturn for same period excludes locked lines
 *  10. getThresholdState: under = ok; ≥80% = warn; ≥90% = mustRegister
 *  11. syncObligations + listObligations returns 4 quarterly windows
 *  12. Tenant isolation: entityB cannot see entityA's data
 */

process.env.DB_BACKEND = process.env.DB_BACKEND || 'postgres';

const crypto = require('crypto');
const { eq } = require('drizzle-orm');
const { getDb, getSchema, getPool } = require('../api/_lib/db');
const { seedAccountsForEntity, getAccountByCode } = require('../api/_lib/ledger/accounts');
const { postJournal, postSale, postExpense } = require('../api/_lib/ledger/posting');
const { seedDefaultRules } = require('../api/_lib/tax/rules');
const vat = require('../api/_lib/tax/vat');

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${msg} (got ${actual}, expected ${expected})`);
  }
}
function assertClose(actual, expected, tolPence, msg) {
  if (Math.abs(actual - expected) > tolPence) {
    throw new Error(
      `Assertion failed: ${msg} (got ${actual}p, expected ${expected}p ±${tolPence}p)`
    );
  }
}

async function step(name, fn) {
  process.stdout.write(`  ${name} … `);
  try {
    await fn();
    console.log('OK');
  } catch (err) {
    console.log('FAIL');
    throw err;
  }
}

async function makeEntity(prefix, userId) {
  const db = getDb();
  const { entities } = getSchema();
  const id = `ent_${prefix}_${crypto.randomBytes(4).toString('hex')}`;
  await db.insert(entities).values({
    id,
    userId,
    name: `Stage7 ${prefix}`,
    type: 'sole_trader',
    defaultCurrency: 'GBP',
    isDefault: false,
  });
  await seedAccountsForEntity(id, 'sole_trader');
  return id;
}

async function getOutputLineId(entityId, journalId) {
  // The "output" line on a sale = the credit to 4000 Sales.
  const db = getDb();
  const { journalLines } = getSchema();
  const sales = await getAccountByCode(entityId, '4000');
  const rows = await db
    .select({ id: journalLines.id })
    .from(journalLines)
    .where(eq(journalLines.journalId, journalId));
  // pick the row that posted to 4000
  for (const r of rows) {
    const detail = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.id, r.id))
      .limit(1);
    if (detail[0].accountId === sales.id) return r.id;
  }
  throw new Error('sales line not found');
}

async function getInputLineId(entityId, journalId, expenseCode) {
  const db = getDb();
  const { journalLines } = getSchema();
  const acc = await getAccountByCode(entityId, expenseCode);
  const rows = await db
    .select({ id: journalLines.id, accountId: journalLines.accountId })
    .from(journalLines)
    .where(eq(journalLines.journalId, journalId));
  for (const r of rows) if (r.accountId === acc.id) return r.id;
  throw new Error(`expense line ${expenseCode} not found`);
}

async function main() {
  console.log('Stage 7 smoke (UK VAT + MTD)');
  const db = getDb();
  const { users } = getSchema();
  const userId = `usr_smoke7_${crypto.randomBytes(4).toString('hex')}`;
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    name: 'Stage 7 Smoke',
    role: 'user',
    status: 'active',
  });
  await seedDefaultRules();
  // Force-upsert latest defaults so VAT keys are present even if a
  // prior stage seeded older rule rows.
  const { setRules, defaultRulesRUK, defaultRulesScotland } = require('../api/_lib/tax/rules');
  for (const year of [2024, 2025, 2026]) {
    await setRules(year, 'rUK', defaultRulesRUK());
    await setRules(year, 'scotland', defaultRulesScotland());
  }
  const entityA = await makeEntity('st7a', userId);
  const entityB = await makeEntity('st7b', userId);
  console.log(`  using entityA=${entityA}, entityB=${entityB}`);

  await step('CoA: VAT control 2200 exists', async () => {
    const acc = await getAccountByCode(entityA, '2200');
    assert(acc && acc.code === '2200', '2200 found');
  });

  let regId;
  await step('registerForVAT(scheme=standard)', async () => {
    const { id } = await vat.registerForVAT({
      entityId: entityA,
      vatNumber: 'GB123456789',
      scheme: 'standard',
      registrationDate: '2025-01-01',
    });
    regId = id;
    const reg = await vat.getActiveRegistration(entityA);
    assertEq(reg.id, id, 'active reg matches');
    assertEq(reg.scheme, 'standard', 'scheme=standard');
  });

  // Q1 2025: Apr 1 → Jun 30
  const periodStart = '2025-04-01';
  const periodEnd = '2025-06-30';

  // Capture output VAT on a £1,000 (net) sale = £200 VAT, £1,200 gross
  await step('capture output VAT on a £1,000 net sale', async () => {
    const sale = await postSale({
      entityId: entityA,
      date: '2025-05-15',
      amountPence: 1_200_00, // gross
      invoiceId: 'INV-001',
      customerName: 'Cust A',
    });
    const lineId = await getOutputLineId(entityA, sale.id);
    await vat.captureLineVat({
      journalLineId: lineId,
      entityId: entityA,
      side: 'output',
      vatRatePct: 20,
      grossPence: 1_200_00,
    });
  });

  // Capture input VAT on a £200 net expense = £40 VAT, £240 gross
  await step('capture input VAT on a £200 net expense', async () => {
    const exp = await postExpense({
      entityId: entityA,
      date: '2025-05-20',
      amountPence: 240_00,
      expenseCode: '7000', // Office Costs
      vendorName: 'Office Supplies Co',
    });
    const lineId = await getInputLineId(entityA, exp.id, '7000');
    await vat.captureLineVat({
      journalLineId: lineId,
      entityId: entityA,
      side: 'input',
      vatRatePct: 20,
      grossPence: 240_00,
    });
  });

  await step('computeReturn (standard) → boxes correct', async () => {
    const ret = await vat.computeReturn({
      entityId: entityA,
      periodStart,
      periodEnd,
      scheme: 'standard',
    });
    assertEq(ret.boxes.box1_outputVatPence, 200_00, 'box1 = £200 output VAT');
    assertEq(ret.boxes.box4_inputVatPence, 40_00, 'box4 = £40 input VAT');
    assertEq(ret.boxes.box3_totalVatDuePence, 200_00, 'box3 = box1 + box2');
    assertEq(ret.boxes.box5_netVatPayablePence, 160_00, 'box5 = £160 due to HMRC');
    assertEq(ret.boxes.box6_totalSalesExVatPence, 1_000_00, 'box6 = £1,000 net sales');
    assertEq(ret.boxes.box7_totalPurchasesExVatPence, 200_00, 'box7 = £200 net purchases');
  });

  await step('computeReturn (flat_rate, FRS=12%) → grossSales × 12%', async () => {
    const ret = await vat.computeReturn({
      entityId: entityA,
      periodStart,
      periodEnd,
      scheme: 'flat_rate',
      flatRateScheme: { ratePct: 12 },
    });
    // grossSales = £1,200 → box1 = 12% × £1,200 = £144
    assertEq(ret.boxes.box1_outputVatPence, 144_00, 'box1 = £144 (FRS)');
    assertEq(ret.boxes.box4_inputVatPence, 0, 'box4 = 0 under FRS');
    assertEq(ret.boxes.box6_totalSalesExVatPence, 1_200_00, 'box6 = grossSales £1,200 (FRS)');
    assertEq(ret.boxes.box5_netVatPayablePence, 144_00, 'box5 = £144 due');
  });

  // Cash basis: post a sale in the period but DON'T mark it paid → not in box1
  let unpaidSaleId;
  await step('cash basis: unpaid sale excluded from box1', async () => {
    const sale = await postSale({
      entityId: entityA,
      date: '2025-06-05',
      amountPence: 600_00, // £500 net + £100 VAT
      invoiceId: 'INV-002',
      customerName: 'Cust B',
    });
    unpaidSaleId = 'INV-002';
    const lineId = await getOutputLineId(entityA, sale.id);
    await vat.captureLineVat({
      journalLineId: lineId,
      entityId: entityA,
      side: 'output',
      vatRatePct: 20,
      grossPence: 600_00,
    });
    const ret = await vat.computeReturn({
      entityId: entityA,
      periodStart,
      periodEnd,
      scheme: 'cash',
    });
    // Cash basis: only the *paid* sale matters. INV-001 is unpaid (no
    // payment journal in the period) and INV-002 is unpaid → box1 = 0.
    assertEq(ret.boxes.box1_outputVatPence, 0, 'box1 = 0 (no paid sales)');
    assertEq(ret.boxes.box4_inputVatPence, 40_00, 'box4 = £40 (postExpense is paid-on-post)');
  });

  await step('cash basis: paid sale appears in box1', async () => {
    // Pay INV-001 inside the period via postPaymentReceived shape.
    const { postPaymentReceived } = require('../api/_lib/ledger/posting');
    await postPaymentReceived({
      entityId: entityA,
      date: '2025-06-10',
      amountPence: 1_200_00,
      invoiceId: 'INV-001',
      customerName: 'Cust A',
    });
    const ret = await vat.computeReturn({
      entityId: entityA,
      periodStart,
      periodEnd,
      scheme: 'cash',
    });
    assertEq(ret.boxes.box1_outputVatPence, 200_00, 'box1 = £200 (INV-001 paid)');
    assertEq(ret.boxes.box6_totalSalesExVatPence, 1_000_00, 'box6 = £1,000 (paid net only)');
  });

  await step('submitReturn locks captured lines + emits receipt', async () => {
    const out = await vat.submitReturn({
      entityId: entityA,
      periodStart,
      periodEnd,
      periodKey: '25A2',
      signedByUserId: 'usr_smoke_admin',
    });
    assert(out.id && out.id.startsWith('vatret_'), 'return id minted');
    assert(out.receipt && out.receipt.formBundleNumber, 'receipt bundle');
    assertEq(out.receipt.stub, true, 'stub flag');
    assert(out.lockedLineCount >= 3, `≥3 lines locked (got ${out.lockedLineCount})`);
  });

  await step('re-submit same periodKey → duplicate error', async () => {
    let threw = null;
    try {
      await vat.submitReturn({
        entityId: entityA,
        periodStart,
        periodEnd,
        periodKey: '25A2',
      });
    } catch (e) {
      threw = e;
    }
    assert(threw, 'second submit threw');
    assertEq(threw.code, 'VAT_RETURN_DUPLICATE', 'duplicate code');
  });

  await step('after lock: same period recompute excludes locked lines', async () => {
    const ret = await vat.computeReturn({
      entityId: entityA,
      periodStart,
      periodEnd,
      scheme: 'standard',
    });
    // All captured rows in the period are locked → boxes back to 0.
    assertEq(ret.boxes.box1_outputVatPence, 0, 'box1 = 0 after lock');
    assertEq(ret.boxes.box4_inputVatPence, 0, 'box4 = 0 after lock');
    assertEq(ret.boxes.box6_totalSalesExVatPence, 0, 'box6 = 0 after lock');
  });

  await step('threshold: under £90k = ok', async () => {
    const t = await vat.getThresholdState({
      entityId: entityA,
      asOfDate: '2025-06-30',
    });
    assert(t.rollingTurnoverPence >= 0, 'turnover non-negative');
    assertEq(t.thresholdPence, 9_000_000, '£90k threshold');
    assert(['ok', 'warn'].includes(t.status), `status ok or warn (got ${t.status})`);
  });

  await step('threshold: warn at ≥80% and mustRegister at ≥90%', async () => {
    // entityB: post a single £75k sale. With the fallback (no VAT
    // capture), the threshold tracker should sum the 4000 Sales
    // credit into box6-equivalent rolling turnover.
    await postSale({
      entityId: entityB,
      date: '2025-06-15',
      amountPence: 75_000_00,
      invoiceId: 'INV-B-001',
      customerName: 'Big Cust',
    });
    const t = await vat.getThresholdState({
      entityId: entityB,
      asOfDate: '2025-06-30',
    });
    assertEq(t.rollingTurnoverPence, 75_000_00, '£75k rolling');
    assertEq(t.status, 'warn', '£75k = 83% → warn');

    await postSale({
      entityId: entityB,
      date: '2025-06-20',
      amountPence: 7_000_00, // +£7k → £82k = 91%
      invoiceId: 'INV-B-002',
      customerName: 'Big Cust',
    });
    const t2 = await vat.getThresholdState({
      entityId: entityB,
      asOfDate: '2025-06-30',
    });
    assertEq(t2.status, 'mustRegister', '£82k = 91% → mustRegister');
  });

  await step('syncObligations + listObligations', async () => {
    const sync = await vat.syncObligations({
      entityId: entityA,
      from: '2025-04-01',
    });
    assertEq(sync.obligations.length, 4, '4 quarterly windows');
    assert(sync.inserted >= 1, `inserted ≥1 (got ${sync.inserted})`);
    const obs = await vat.listObligations(entityA);
    assert(obs.length >= 4, `listed ≥4 (got ${obs.length})`);
    // The 25A2 obligation should be marked fulfilled because we
    // submitted that periodKey above.
    const q2 = obs.find((o) => o.periodKey === '25A2');
    if (q2) assertEq(q2.status, 'fulfilled', 'submitted period marked fulfilled');
  });

  await step('tenant isolation: entityB cannot see entityA returns/registration', async () => {
    const regB = await vat.getActiveRegistration(entityB);
    assertEq(regB, null, 'entityB has no registration');
    const retsB = await vat.listReturns(entityB);
    assertEq(retsB.length, 0, 'entityB has 0 returns');
    const obsB = await vat.listObligations(entityB);
    assertEq(obsB.length, 0, 'entityB has 0 obligations');
  });

  console.log('\nAll Stage 7 smoke checks passed.');
}

main()
  .then(async () => {
    await getPool().end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n[smoke] FAILED:', err);
    try { await getPool().end(); } catch {}
    process.exit(1);
  });
