/**
 * Stage 8 smoke — Reports, Year-End, Accountant Access.
 *
 *   1.  Tenant + CoA seeded (sole trader)
 *   2.  Trial Balance debits === credits after a sale + expense
 *   3.  P&L matches expected income / expense / net profit
 *   4.  P&L comparison vs prior period (variance %)
 *   5.  Balance Sheet balances (assets === liabilities + equity)
 *   6.  Cash flow indirect: opening + operating === closing (no I/F)
 *   7.  Aged Debtors: open invoices bucketed by age
 *   8.  Aged Creditors: open bills bucketed by age (manual journal)
 *   9.  CSV export of P&L is deterministic
 *  10. Year-end checklist: create + tickStep + lock fails on unticked
 *  11. lockYearEnd snapshots all reports + locks period (post inside fails)
 *  12. Accountant invite + accept token; revoke + assertAccessAllowed
 *  13. Tenant isolation across two entities
 */

process.env.DB_BACKEND = process.env.DB_BACKEND || 'postgres';

const crypto = require('crypto');
const { eq, and } = require('drizzle-orm');
const { getDb, getSchema, getPool } = require('../api/_lib/db');
const { seedAccountsForEntity, getAccountByCode } = require('../api/_lib/ledger/accounts');
const { postJournal, postSale, postPaymentReceived, postExpense, postManualJournal } = require('../api/_lib/ledger/posting');
const ledgerReports = require('../api/_lib/ledger/reports');
const { agedDebtors, agedCreditors } = require('../api/_lib/reports/aged');
const { cashFlow } = require('../api/_lib/reports/cash-flow');
const { comparePeriods } = require('../api/_lib/reports/comparison');
const { toCsv } = require('../api/_lib/reports/csv');
const { listSnapshots } = require('../api/_lib/reports/snapshots');
const yearEnd = require('../api/_lib/year-end/checklist');
const accountants = require('../api/_lib/accountants/access');

function assert(c, m) { if (!c) throw new Error(`Assertion failed: ${m}`); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`Assertion failed: ${m} (got ${a}, expected ${b})`); }

async function step(name, fn) {
  process.stdout.write(`  ${name} … `);
  try { await fn(); console.log('OK'); } catch (e) { console.log('FAIL'); throw e; }
}

async function makeEntity(prefix, userId, type = 'sole_trader') {
  const db = getDb();
  const { entities } = getSchema();
  const id = `ent_${prefix}_${crypto.randomBytes(4).toString('hex')}`;
  await db.insert(entities).values({
    id, userId, name: `Stage8 ${prefix}`, type, defaultCurrency: 'GBP', isDefault: false,
  });
  await seedAccountsForEntity(id, type);
  return id;
}

async function main() {
  console.log('Stage 8 smoke (Reports / Year-End / Accountants)');
  const db = getDb();
  const { users, auditLog } = getSchema();
  const clientUserId = `usr_smoke8c_${crypto.randomBytes(4).toString('hex')}`;
  const accountantUserId = `usr_smoke8a_${crypto.randomBytes(4).toString('hex')}`;
  await db.insert(users).values({
    id: clientUserId, email: `${clientUserId}@test.local`, name: 'Stage 8 Client', role: 'user', status: 'active',
  });
  await db.insert(users).values({
    id: accountantUserId, email: `${accountantUserId}@test.local`, name: 'Stage 8 Accountant', role: 'user', status: 'active',
  });

  const entityA = await makeEntity('st8a', clientUserId);
  const entityB = await makeEntity('st8b', clientUserId);
  console.log(`  using entityA=${entityA}, entityB=${entityB}`);

  // --- ledger activity for FY2024 ---
  // Prior period: a £400 sale + £100 expense in 2023 (for comparison).
  await postSale({ entityId: entityA, date: '2023-06-15', amountPence: 400_00, invoiceId: 'PRIOR-1', customerName: 'OldCust' });
  await postPaymentReceived({ entityId: entityA, date: '2023-06-30', amountPence: 400_00, invoiceId: 'PRIOR-1', customerName: 'OldCust' });
  await postExpense({ entityId: entityA, date: '2023-07-01', amountPence: 100_00, expenseCode: '7000', vendorName: 'Old Office' });

  // Current FY: 2024-04-01 → 2025-03-31
  const fyStart = '2024-04-01', fyEnd = '2025-03-31';
  // Sale £1,000 (paid)
  await postSale({ entityId: entityA, date: '2024-05-10', amountPence: 1_000_00, invoiceId: 'INV-PAID', customerName: 'Cust A' });
  await postPaymentReceived({ entityId: entityA, date: '2024-05-20', amountPence: 1_000_00, invoiceId: 'INV-PAID', customerName: 'Cust A' });
  // Sale £200 (unpaid, recent)
  await postSale({ entityId: entityA, date: '2025-03-15', amountPence: 200_00, invoiceId: 'INV-OPEN-NEW', customerName: 'Cust B' });
  // Sale £150 (unpaid, ancient — to land in 90+ bucket relative to fyEnd)
  await postSale({ entityId: entityA, date: '2024-09-01', amountPence: 150_00, invoiceId: 'INV-OPEN-OLD', customerName: 'Cust C' });
  // Expense £300 (paid)
  await postExpense({ entityId: entityA, date: '2024-06-05', amountPence: 300_00, expenseCode: '7000', vendorName: 'Office Co' });
  // Trade creditor £80 (manual: DR expense 7000 / CR 2100 trade creditors), aged old
  await postManualJournal({
    entityId: entityA,
    date: '2024-08-01',
    description: 'Bill from supplier',
    lines: [
      { accountCode: '7000', debit: 80_00, credit: 0 },
      { accountCode: '2100', debit: 0, credit: 80_00 },
    ],
  });
  // Trade creditor £40 (manual: recent)
  await postManualJournal({
    entityId: entityA,
    date: '2025-03-20',
    description: 'Recent bill',
    lines: [
      { accountCode: '7000', debit: 40_00, credit: 0 },
      { accountCode: '2100', debit: 0, credit: 40_00 },
    ],
  });

  // --- Tests ---
  await step('Trial Balance balances', async () => {
    const tb = await ledgerReports.trialBalance(entityA, fyEnd);
    assert(tb.totals.isBalanced, `TB unbalanced: dr=${tb.totals.debitPence} cr=${tb.totals.creditPence}`);
  });

  await step('P&L: income £1,350, expenses £420, net £930', async () => {
    const pl = await ledgerReports.profitAndLoss(entityA, { from: fyStart, to: fyEnd });
    // income: 1,000 (paid sale) + 200 (open) + 150 (open) = 1,350
    assertEq(pl.income.totalPence, 1_350_00, 'income');
    // expenses: 300 (office) + 80 + 40 (creditor bills) = 420
    assertEq(pl.expenses.totalPence, 420_00, 'expenses');
    assertEq(pl.netProfitPence, 930_00, 'net profit');
  });

  await step('P&L comparison vs prior period', async () => {
    const compute = (a) => ledgerReports.profitAndLoss(a.entityId, { from: a.from, to: a.to });
    const r = await comparePeriods(compute, { entityId: entityA, from: fyStart, to: fyEnd }, {
      pickValue: (x) => x.netProfitPence,
    });
    assertEq(r.headline.currentPence, 930_00, 'cur');
    assertEq(r.headline.priorPence, 300_00, 'prior'); // 400 - 100 = 300
    assertEq(r.headline.varianceAbsPence, 630_00, 'variance abs');
  });

  await step('Balance Sheet balances', async () => {
    const bs = await ledgerReports.balanceSheet(entityA, fyEnd);
    assert(bs.isBalanced, `BS unbalanced by ${bs.differencePence}`);
  });

  await step('Cash flow indirect reconciles', async () => {
    const cf = await cashFlow({ entityId: entityA, from: fyStart, to: fyEnd });
    assert(cf.cash.reconciles, `CF mismatch ${cf.cash.differencePence}`);
    // Operating cash should equal change in bank net of anything non-bank.
    // Net profit 930, dep 0, ΔAR (open 200+150=350) -350, ΔAP +120 = 700
    assertEq(cf.operating.totalPence, 700_00, 'operating cash');
  });

  await step('Aged Debtors buckets correct', async () => {
    const aged = await agedDebtors({ entityId: entityA, asOfDate: fyEnd });
    assertEq(aged.totalPence, 350_00, 'total open');
    // INV-OPEN-NEW (2025-03-15) is 16 days before 2025-03-31 → 0_30
    // INV-OPEN-OLD (2024-09-01) is ≈ 211 days → over_90
    assertEq(aged.buckets['0_30'], 200_00, 'bucket 0-30');
    assertEq(aged.buckets.over_90, 150_00, 'bucket 90+');
  });

  await step('Aged Creditors buckets correct', async () => {
    const aged = await agedCreditors({ entityId: entityA, asOfDate: fyEnd });
    assertEq(aged.totalPence, 120_00, 'total open');
    // 2024-08-01 → 90+, 2025-03-20 → 0-30
    assertEq(aged.buckets['0_30'], 40_00, 'bucket 0-30');
    assertEq(aged.buckets.over_90, 80_00, 'bucket 90+');
  });

  await step('CSV export deterministic', async () => {
    const pl = await ledgerReports.profitAndLoss(entityA, { from: fyStart, to: fyEnd });
    const csv = toCsv('profit_and_loss', pl);
    assert(csv.includes('Net profit,930.00'), 'csv contains net profit row');
    assert(csv.startsWith('Section,Code,Account,Amount\n'), 'csv header');
  });

  let checklistFY;
  await step('Year-end checklist created with default steps', async () => {
    const c = await yearEnd.createChecklist({ entityId: entityA, fiscalYear: 2024 });
    checklistFY = c;
    assert(Array.isArray(c.steps) && c.steps.length >= 6, 'has steps');
    assert(c.steps.every((s) => s.done === false), 'all unticked');
  });

  await step('tickStep updates the row', async () => {
    const updated = await yearEnd.tickStep({
      entityId: entityA, fiscalYear: 2024, stepId: 'reconcile_all_banks', actor: { userId: clientUserId },
    });
    assert(updated.steps.find((s) => s.id === 'reconcile_all_banks').done, 'ticked');
  });

  await step('lockYearEnd refuses when steps undone', async () => {
    let threw = false;
    try {
      await yearEnd.lockYearEnd({
        entityId: entityA, fiscalYear: 2024, periodStart: fyStart, periodEnd: fyEnd, actor: { userId: clientUserId },
      });
    } catch (e) { threw = true; assert(/not done/.test(e.message), e.message); }
    assert(threw, 'should have thrown');
  });

  await step('lockYearEnd with allowSkipped: locks period + writes 7 snapshots', async () => {
    const result = await yearEnd.lockYearEnd({
      entityId: entityA, fiscalYear: 2024, periodStart: fyStart, periodEnd: fyEnd,
      allowSkipped: true, actor: { userId: clientUserId, email: 'client@test.local', role: 'user' },
    });
    assert(result.lockedAt, 'locked');
    assertEq(result.snapshots.length, 7, '7 snapshots');
    const snaps = await listSnapshots(entityA);
    assertEq(snaps.length, 7, 'listSnapshots returns 7');
  });

  await step('Posting inside locked period fails', async () => {
    let threw = false;
    try {
      await postExpense({
        entityId: entityA, date: '2024-12-01', amountPence: 10_00, expenseCode: '7000', vendorName: 'Late Bill',
      });
    } catch (e) { threw = true; assert(/locked/i.test(e.message), e.message); }
    assert(threw, 'expected period-lock error');
  });

  let inviteToken;
  let accessId;
  await step('inviteAccountant returns raw token', async () => {
    const r = await accountants.inviteAccountant({
      clientUserId, email: 'acc@test.local', scope: 'read_only', actor: { userId: clientUserId, role: 'user' },
    });
    assert(r.token && r.token.length > 16, 'token length');
    inviteToken = r.token;
    accessId = r.id;
  });

  await step('acceptInvite flips status to accepted and burns token', async () => {
    const a = await accountants.acceptInvite({ token: inviteToken, accountantUserId });
    assertEq(a.clientUserId, clientUserId, 'client linked');
    // Token must be unusable second time
    let threw = false;
    try { await accountants.acceptInvite({ token: inviteToken, accountantUserId }); }
    catch (e) { threw = true; }
    assert(threw, 'token reuse blocked');
  });

  await step('assertAccessAllowed returns row for accepted; rejects scope mismatch', async () => {
    const row = await accountants.assertAccessAllowed({ clientUserId, accountantUserId });
    assertEq(row.scope, 'read_only', 'scope');
    let threw = false;
    try { await accountants.assertAccessAllowed({ clientUserId, accountantUserId, requireFullScope: true }); }
    catch (e) { threw = true; assert(/read_only/.test(e.message), e.message); }
    assert(threw, 'requireFullScope should reject');
  });

  await step('Expired invite tokens are rejected', async () => {
    const r = await accountants.inviteAccountant({
      clientUserId, email: 'old@test.local', scope: 'read_only',
      actor: { userId: clientUserId, role: 'user' },
      expiresAt: new Date(Date.now() - 60_000), // already expired
    });
    let threw = false;
    try { await accountants.acceptInvite({ token: r.token, accountantUserId }); }
    catch (e) { threw = true; assert(/expired/i.test(e.message), e.message); }
    assert(threw, 'expected expired-token rejection');
  });

  await step('revokeAccess flips to revoked + audit logged', async () => {
    await accountants.revokeAccess({ id: accessId, actor: { userId: clientUserId, role: 'user' } });
    let threw = false;
    try { await accountants.assertAccessAllowed({ clientUserId, accountantUserId }); }
    catch (e) { threw = true; }
    assert(threw, 'revoked access denied');
    // Verify audit row exists
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'accountant.revoke'));
    assert(rows.length > 0, 'accountant.revoke audit row');
  });

  await step('Tenant isolation: entityB cannot see entityA reports', async () => {
    const tb = await ledgerReports.trialBalance(entityB, fyEnd);
    assertEq(tb.totals.debitPence, 0, 'B has no activity');
    const aged = await agedDebtors({ entityId: entityB, asOfDate: fyEnd });
    assertEq(aged.totalPence, 0, 'B aged debtors 0');
  });

  console.log('All Stage 8 smoke checks passed ✓');
  await getPool().end();
}

main().catch((e) => {
  console.error(e);
  getPool().end().finally(() => process.exit(1));
});
