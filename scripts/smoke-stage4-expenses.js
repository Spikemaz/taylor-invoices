/**
 * Stage 4 smoke test — Expenses & Receipts (slice 1).
 *
 *  1. AMAP rate maths: car under 10 000 mi → 45p
 *  2. AMAP rate maths: car spanning the 10 000 mi taper
 *  3. Motorbike + bike flat rates
 *  4. UK tax-year boundary (2025-04-05 → TY2024, 2025-04-06 → TY2025)
 *  5. Mileage create posts journal DR 7200 / CR 3100 (sole trader)
 *  6. YTD summary aggregates by vehicle
 *  7. Receipt create → ocr → approve posts DR <expense> / CR 0800
 *  8. Trial balance still balances after receipt approval
 *  9. Auto-bank-match: receipt approval links to a same-amount,
 *     same-date unmatched bank transaction
 * 10. Expense claim: 2 items → approve posts one journal with 2 DRs +
 *     1 CR (director's loan for Ltd) and "owed to claimant" reflects it
 * 11. Tenant-isolation guard: expense code must exist for the entity
 *     (foreign expense code raises)
 */

process.env.DB_BACKEND = process.env.DB_BACKEND || 'postgres';

const crypto = require('crypto');
const { eq } = require('drizzle-orm');
const { getDb, getSchema, getPool } = require('../api/_lib/db');
const { seedAccountsForEntity } = require('../api/_lib/ledger/accounts');
const { trialBalance } = require('../api/_lib/ledger/reports');
const {
  createBankConnection,
  createBankAccount,
  importTransactions,
} = require('../api/_lib/bank/transactions');
const {
  computeAmap,
  taxYearFor,
  createMileageLog,
  ytdMileageSummary,
  AMAP_RATES,
} = require('../api/_lib/expenses/mileage');
const {
  createReceipt,
  recordOcrResult,
  approveReceipt,
  listReceipts,
} = require('../api/_lib/expenses/receipts');
const {
  createClaim,
  addItem,
  approveClaim,
  owedToClaimant,
} = require('../api/_lib/expenses/claims');

let userId;
let stEntityId; // sole trader
let ltdEntityId; // limited company

async function setup() {
  const db = getDb();
  const { users, entities } = getSchema();
  userId = `user_smoke4_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  stEntityId = `ent_st4_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  ltdEntityId = `ent_ltd4_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  await db.insert(users).values({
    id: userId,
    email: `smoke-${userId}@test.local`,
    name: 'Stage 4 Smoke',
    role: 'user',
    status: 'active',
  });
  await db.insert(entities).values([
    { id: stEntityId,  userId, name: 'Stage 4 ST',  type: 'sole_trader', defaultCurrency: 'GBP', isDefault: true },
    { id: ltdEntityId, userId, name: 'Stage 4 Ltd', type: 'limited',     defaultCurrency: 'GBP', isDefault: false },
  ]);
  await seedAccountsForEntity(stEntityId, 'sole_trader');
  await seedAccountsForEntity(ltdEntityId, 'limited');
}

async function teardown() {
  if (!stEntityId) return;
  const db = getDb();
  const s = getSchema();
  for (const eid of [stEntityId, ltdEntityId]) {
    try {
      await db.delete(s.expenseClaimItems).where(eq(s.expenseClaimItems.claimId, 'placeholder')); // no-op
      // Cascade-delete via entity is safer, but explicit cleanup keeps
      // the test isolated even if a FK cascade is misconfigured.
      const claims = await db.select({ id: s.expenseClaims.id }).from(s.expenseClaims).where(eq(s.expenseClaims.entityId, eid));
      for (const c of claims) await db.delete(s.expenseClaimItems).where(eq(s.expenseClaimItems.claimId, c.id));
      await db.delete(s.expenseClaims).where(eq(s.expenseClaims.entityId, eid));
      await db.delete(s.mileageLogs).where(eq(s.mileageLogs.entityId, eid));
      await db.delete(s.receipts).where(eq(s.receipts.entityId, eid));
      await db.delete(s.bankTransactions).where(eq(s.bankTransactions.entityId, eid));
      await db.delete(s.bankAccounts).where(eq(s.bankAccounts.entityId, eid));
      await db.delete(s.bankConnections).where(eq(s.bankConnections.entityId, eid));
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
async function step(name, fn) { process.stdout.write(`  ${name} … `); await fn(); process.stdout.write('OK\n'); }

async function main() {
  console.log('Stage 4 smoke test (Expenses & Receipts)');
  await setup();
  console.log(`  using stEntityId=${stEntityId} ltdEntityId=${ltdEntityId}`);

  // ------------------------------------------------------------------
  await step('AMAP — car under 10k miles uses 45p/mile', () => {
    const r = computeAmap(50_00, 0, 'car'); // 50.00 miles, no YTD
    assertEq(r.amountPence, Math.round((5000 * 45) / 100), '50 mi × 45p = 2250p');
    assertEq(r.portionAtFullRateMilesX100, 5000, 'full portion = full distance');
    assertEq(r.portionAtTaperRateMilesX100, 0, 'taper portion = 0');
  });

  await step('AMAP — taper kicks in across 10k boundary', () => {
    // YTD already 9 950 mi; this trip is 100 mi → 50 at 45p, 50 at 25p.
    const r = computeAmap(100_00, 9950_00, 'car');
    assertEq(r.portionAtFullRateMilesX100, 50_00, '50 mi at full');
    assertEq(r.portionAtTaperRateMilesX100, 50_00, '50 mi at taper');
    const expected = Math.round((5000 * 45) / 100) + Math.round((5000 * 25) / 100);
    assertEq(r.amountPence, expected, '£22.50 + £12.50 = £35.00');
  });

  await step('AMAP — motorbike 24p, bike 20p flat', () => {
    const m = computeAmap(40_00, 0, 'motorbike');
    assertEq(m.amountPence, Math.round((4000 * 24) / 100), '40 mi × 24p');
    const b = computeAmap(40_00, 0, 'bike');
    assertEq(b.amountPence, Math.round((4000 * 20) / 100), '40 mi × 20p');
  });

  await step('UK tax-year boundary at 6 April', () => {
    assertEq(taxYearFor('2025-04-05'), 2024, '5 Apr 2025 → TY2024');
    assertEq(taxYearFor('2025-04-06'), 2025, '6 Apr 2025 → TY2025');
    assertEq(taxYearFor('2025-12-31'), 2025, '31 Dec 2025 → TY2025');
    assertEq(taxYearFor('2026-04-05'), 2025, '5 Apr 2026 → TY2025');
  });

  // ------------------------------------------------------------------
  await step('mileage create posts DR 7200 / CR 3100 (sole trader)', async () => {
    const r = await createMileageLog({
      entityId: stEntityId,
      journeyDate: '2025-06-15',
      fromAddress: 'London',
      toAddress: 'Manchester',
      distanceMilesX100: 200_00,
      vehicleType: 'car',
    }, { actor: { userId, email: 'smoke@test', role: 'admin' } });
    assertEq(r.amountPence, 9000, '200 mi × 45p = £90.00 = 9000p');
    assertEq(r.taxYear, 2025, 'TY2025');
    const tb = await trialBalance(stEntityId);
    assert(tb.totals.isBalanced, 'TB balanced');
    const motor = tb.rows.find((x) => x.code === '7200');
    const drawings = tb.rows.find((x) => x.code === '3100');
    assertEq(motor.balancePence, 9000, '7200 = 9000p');
    assertEq(drawings.balancePence, 9000, '3100 (equity) carries 9000p natural-balance credit');
  });

  await step('YTD summary aggregates by vehicle', async () => {
    // Add a motorbike journey so the summary has 2 vehicle rows.
    await createMileageLog({
      entityId: stEntityId,
      journeyDate: '2025-06-20',
      fromAddress: 'A',
      toAddress: 'B',
      distanceMilesX100: 30_00,
      vehicleType: 'motorbike',
    });
    const sum = await ytdMileageSummary(stEntityId, 2025);
    assertEq(sum.byVehicle.length, 2, 'two vehicle rows');
    const car = sum.byVehicle.find((v) => v.vehicleType === 'car');
    const moto = sum.byVehicle.find((v) => v.vehicleType === 'motorbike');
    assertEq(car.milesX100, 200_00, 'car miles');
    assertEq(moto.milesX100, 30_00, 'motorbike miles');
    assertEq(sum.totalAmountPence, 9000 + 720, 'total = 9000 + 720');
  });

  // ------------------------------------------------------------------
  let receiptId, bankAccountId, bankTxId;

  await step('create + OCR a receipt; approve posts journal', async () => {
    const r = await createReceipt({
      entityId: stEntityId,
      fileId: 'drive_abc123',
      fileName: 'costa-2025-06-10.jpg',
      mimeType: 'image/jpeg',
      paymentMethod: 'bank',
    }, { actor: { userId, email: 'smoke@test', role: 'admin' } });
    receiptId = r.id;
    await recordOcrResult(receiptId, {
      vendor: 'Costa Coffee',
      receiptDate: '2025-06-10',
      totalPence: 450,
      vatPence: 75,
      payload: { raw: 'OCR JSON would go here' },
      confidence: 92,
      model: 'gpt-4o-mini',
    });
    // Approve with expense code 7100 Travel & Subsistence.
    const r2 = await approveReceipt(receiptId, { expenseAccountCode: '7100' });
    assert(r2.journalId, 'journal posted');
    // Without a bank tx to match, matched=false.
    assertEq(r2.matched, false, 'no bank tx to match yet');
  });

  await step('TB balanced after receipt approval', async () => {
    const tb = await trialBalance(stEntityId);
    assert(tb.totals.isBalanced, 'TB still balances');
    const travel = tb.rows.find((x) => x.code === '7100');
    const bank = tb.rows.find((x) => x.code === '0800');
    assertEq(travel.balancePence, 450, '7100 = 450p (receipt)');
    // 0800 (asset, debit-natural) only had a credit posting → -450p.
    assertEq(bank.balancePence, -450, '0800 = -450p (credit-only on bank-paid receipt)');
  });

  // ------------------------------------------------------------------
  await step('auto-bank-match: receipt links to matching bank tx', async () => {
    // Set up a bank account + a matching bank transaction.
    const conn = await createBankConnection({ entityId: stEntityId, provider: 'csv', institutionName: 'Starling' });
    const acct = await createBankAccount({ entityId: stEntityId, connectionId: conn.id, ledgerAccountCode: '0800', name: 'Starling' });
    bankAccountId = acct.id;
    await importTransactions({
      bankAccountId,
      entityId: stEntityId,
      rows: [
        { date: '2025-06-12', amountPence: -1295, description: 'PRET A MANGER', counterparty: 'Pret' }, // matches our next receipt
        { date: '2025-08-01', amountPence: -9999, description: 'NOPE',          counterparty: null },
      ],
    });
    // Create a receipt for £12.95 dated 2025-06-13 (within ±2 days).
    const r = await createReceipt({
      entityId: stEntityId,
      paymentMethod: 'bank',
      vendor: 'Pret',
      receiptDate: '2025-06-13',
      totalPence: 1295,
      vatPence: 0,
      expenseAccountCode: '7100',
    });
    const approved = await approveReceipt(r.id, {});
    assertEq(approved.matched, true, 'auto-matched');
    assert(approved.bankTxId, 'bankTxId returned');
    bankTxId = approved.bankTxId;
    // Verify state in DB.
    const db = getDb();
    const { bankTransactions, receipts } = getSchema();
    const [btx] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, bankTxId));
    assertEq(btx.status, 'matched', 'bank tx → matched');
    assertEq(btx.matchedJournalId, approved.journalId, 'bank tx points at the receipt journal');
    const [rcp] = await db.select().from(receipts).where(eq(receipts.id, r.id));
    assertEq(rcp.status, 'matched', 'receipt → matched');
    assertEq(rcp.matchedBankTxId, bankTxId, 'receipt points at the bank tx');
  });

  // ------------------------------------------------------------------
  await step('expense claim (Ltd) posts DR×N + CR Director\'s Loan', async () => {
    const c = await createClaim({
      entityId: ltdEntityId,
      title: 'June out-of-pocket',
      claimDate: '2025-06-30',
    }, { actor: { userId, email: 'smoke@test', role: 'admin' } });
    await addItem(c.id, { description: 'Train to client',  amountPence: 5500, expenseAccountCode: '7100' });
    await addItem(c.id, { description: 'Stationery',       amountPence: 1200, expenseAccountCode: '7000' });
    const r = await approveClaim(c.id, { actor: { userId, email: 'smoke@test', role: 'admin' } });
    assertEq(r.totalPence, 6700, 'claim total = 6700p');
    const tb = await trialBalance(ltdEntityId);
    assert(tb.totals.isBalanced, 'Ltd TB balanced');
    const travel = tb.rows.find((x) => x.code === '7100');
    const office = tb.rows.find((x) => x.code === '7000');
    const dla = tb.rows.find((x) => x.code === '2500');
    assertEq(travel.balancePence, 5500, '7100 = 5500p');
    assertEq(office.balancePence, 1200, '7000 = 1200p');
    assertEq(dla.balancePence, 6700, '2500 (DLA, liability) = 6700p natural-balance credit');
    const owed = await owedToClaimant(ltdEntityId);
    assertEq(owed.totalPence, 6700, 'owed to claimant = 6700p');
  });

  // ------------------------------------------------------------------
  await step('tenant guard: unknown expense code throws', async () => {
    const c = await createClaim({ entityId: stEntityId, title: 'bad', claimDate: '2025-06-30' });
    let caught = false;
    try {
      // 7110 is Ltd-only (Director's Salary) — not seeded for ST.
      await addItem(c.id, { description: 'x', amountPence: 100, expenseAccountCode: '7110' });
    } catch (err) {
      caught = /not found/i.test(err.message);
    }
    assert(caught, 'sole trader rejected Ltd-only code');
  });

  console.log('\nAll Stage 4 smoke checks passed.');
}

main()
  .then(async () => { await teardown(); await getPool().end(); process.exit(0); })
  .catch(async (err) => {
    console.error('\n[smoke] FAILED:', err);
    await teardown();
    try { await getPool().end(); } catch {}
    process.exit(1);
  });
