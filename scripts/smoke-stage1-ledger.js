/**
 * Stage 1 smoke test — exercises the ledger end-to-end against the local
 * Replit Postgres instance.
 *
 * Tests:
 *   1. Seed CoA for a temp entity (sole_trader template)
 *   2. Post a sale, then a payment — verify trial balance balances
 *   3. Reject an unbalanced manual journal (application-side)
 *   4. Reject an unbalanced manual journal at the DB trigger (bypass
 *      the application validation by inserting raw SQL — defence-in-depth)
 *   5. Period-lock — locking a period rejects journals dated in it
 *   6. P&L + Balance Sheet sanity
 *   7. Backfill dry-run + commit + idempotency + reverse
 *
 * Run:   DB_BACKEND=postgres node scripts/smoke-stage1-ledger.js
 *
 * On success, prints OK and exits 0. On failure, prints what broke and
 * exits 1. Cleans up its temp entity at the end (always — even on error).
 */

process.env.DB_BACKEND = process.env.DB_BACKEND || 'postgres';

const crypto = require('crypto');
const { getDb, getSchema, getPool } = require('../api/_lib/db');
const { seedAccountsForEntity, getAccountByCode } = require('../api/_lib/ledger/accounts');
const {
  postSale,
  postPaymentReceived,
  postManualJournal,
  poundsToPence,
} = require('../api/_lib/ledger/posting');
const { trialBalance, profitAndLoss, balanceSheet } = require('../api/_lib/ledger/reports');
const { upsertPeriod, lockPeriod } = require('../api/_lib/ledger/periods');
const { backfillInvoices, reverseBackfill } = require('../api/_lib/ledger/backfill');
const { eq } = require('drizzle-orm');

let entityId;
let userId;

async function setup() {
  const db = getDb();
  const { users, entities } = getSchema();
  userId = `user_smoke_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  entityId = `ent_smoke_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  await db.insert(users).values({
    id: userId,
    email: `smoke-${userId}@test.local`,
    name: 'Smoke Test',
    role: 'user',
    status: 'active',
  });
  await db.insert(entities).values({
    id: entityId,
    userId,
    name: 'Smoke Test Co',
    type: 'sole_trader',
    defaultCurrency: 'GBP',
    isDefault: true,
  });
}

async function teardown() {
  if (!entityId) return;
  const db = getDb();
  const { users, entities, journals, periods, accounts } = getSchema();
  // Cascade order: journals (→lines), periods, accounts, then entity.
  // Direct entity-cascade-to-accounts can race with journal_lines.account_id
  // (FK is RESTRICT to prevent accidental account deletion in normal use).
  try {
    // Unlock any locked periods first — the period-lock trigger blocks
    // journal_line DELETEs whose date falls inside a locked range.
    await db.update(periods).set({ lockedAt: null, lockedBy: null }).where(eq(periods.entityId, entityId));
    await db.delete(journals).where(eq(journals.entityId, entityId));
    await db.delete(periods).where(eq(periods.entityId, entityId));
    await db.delete(accounts).where(eq(accounts.entityId, entityId));
    await db.delete(entities).where(eq(entities.id, entityId));
    // Clean up any "other entity" smoke fixtures owned by this user.
    const ownedRows = await db.select({ id: entities.id }).from(entities).where(eq(entities.userId, userId));
    for (const { id } of ownedRows) {
      await db.delete(journals).where(eq(journals.entityId, id));
      await db.delete(accounts).where(eq(accounts.entityId, id));
      await db.delete(entities).where(eq(entities.id, id));
    }
    await db.delete(users).where(eq(users.id, userId));
  } catch (err) {
    console.error('[teardown] cleanup failed:', err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`Assertion failed: ${msg} (got ${a}, expected ${b})`);
}

async function step(name, fn) {
  process.stdout.write(`  ${name} … `);
  await fn();
  process.stdout.write('OK\n');
}

async function main() {
  console.log('Stage 1 smoke test');
  await setup();
  console.log(`  using entityId=${entityId}`);

  await step('seed CoA (sole_trader)', async () => {
    const r = await seedAccountsForEntity(entityId, 'sole_trader');
    assert(r.inserted >= 30, `expected ≥30 accounts inserted, got ${r.inserted}`);
    // re-run is idempotent
    const r2 = await seedAccountsForEntity(entityId, 'sole_trader');
    assertEq(r2.inserted, 0, 'second seed should insert 0');
  });

  await step('post sale + payment, trial balance balances', async () => {
    const sale = await postSale({
      entityId,
      date: '2025-04-01',
      amountPence: poundsToPence(120.5),
      invoiceId: 'INV-1',
      customerName: 'Acme Ltd',
    });
    assert(sale.id.startsWith('jrn_'), 'sale id format');
    await postPaymentReceived({
      entityId,
      date: '2025-04-15',
      amountPence: poundsToPence(120.5),
      invoiceId: 'INV-1',
      customerName: 'Acme Ltd',
    });
    const tb = await trialBalance(entityId);
    assert(tb.totals.isBalanced, `TB unbalanced: ${JSON.stringify(tb.totals)}`);
    // Sales account should have 12050p credit
    const sales = tb.rows.find((r) => r.code === '4000');
    assertEq(sales.balancePence, 12050, '4000 Sales balance');
    // Bank should have 12050p debit
    const bank = tb.rows.find((r) => r.code === '0800');
    assertEq(bank.balancePence, 12050, '0800 Bank balance');
    // Debtors should be zero (sale + payment cancel)
    const debtors = tb.rows.find((r) => r.code === '1100');
    assertEq(debtors.balancePence, 0, '1100 Debtors balance');
  });

  await step('rejects cross-entity accountId on manual journal', async () => {
    // Create a second entity with its own seeded CoA, then try to post a
    // journal on entity #1 that references entity #2's account ids. Both
    // the application-side cross-entity guard AND the composite FK
    // (account_id, entity_id) → accounts(id, entity_id) at the DB level
    // must reject this; we assert the application error first because it
    // fires before the transaction is opened.
    const otherEntityId = `ent_smoke_other_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const pool = getPool();
    await pool.query(
      `INSERT INTO entities (id, user_id, name, type) VALUES ($1, $2, $3, $4)`,
      [otherEntityId, userId, 'Other entity', 'sole_trader']
    );
    await seedAccountsForEntity(otherEntityId, 'sole_trader');
    const otherSales = await getAccountByCode(otherEntityId, '4000');
    const ourBank = await getAccountByCode(entityId, '0800');
    let threw = false;
    let code = null;
    try {
      await postManualJournal({
        entityId, // posting onto entity #1
        date: '2025-04-20',
        description: 'cross-entity attempt',
        lines: [
          { accountId: ourBank.id, debit: 1000, credit: 0 },
          { accountId: otherSales.id, debit: 0, credit: 1000 }, // belongs to entity #2
        ],
      });
    } catch (err) {
      threw = true;
      code = err.code;
    }
    assert(threw, 'should reject cross-entity accountId');
    assert(
      code === 'ACCOUNT_ENTITY_MISMATCH',
      `expected ACCOUNT_ENTITY_MISMATCH, got ${code}`
    );
  });

  await step('rejects application-side unbalanced manual journal', async () => {
    let threw = false;
    try {
      await postManualJournal({
        entityId,
        date: '2025-04-20',
        description: 'bad',
        lines: [
          { accountCode: '0800', debit: 1000, credit: 0 },
          { accountCode: '4000', debit: 0, credit: 999 }, // off by 1p
        ],
      });
    } catch (err) {
      threw = err.message.includes('unbalanced');
    }
    assert(threw, 'should reject unbalanced manual journal');
  });

  await step('DB trigger rejects raw-SQL unbalanced insert', async () => {
    const pool = getPool();
    const client = await pool.connect();
    let threw = false;
    try {
      await client.query('BEGIN');
      const jid = `jrn_raw_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
      const bank = await getAccountByCode(entityId, '0800');
      const sales = await getAccountByCode(entityId, '4000');
      await client.query(
        `INSERT INTO journals (id, entity_id, date, description, source) VALUES ($1, $2, $3, $4, 'manual')`,
        [jid, entityId, '2025-04-20', 'raw bypass test']
      );
      await client.query(
        `INSERT INTO journal_lines (journal_id, account_id, entity_id, date, debit_pence, credit_pence, line_number)
         VALUES ($1, $2, $3, $4, 1000, 0, 1), ($1, $5, $3, $4, 0, 999, 2)`,
        [jid, bank.id, entityId, '2025-04-20', sales.id]
      );
      await client.query('COMMIT'); // should explode at the constraint trigger
    } catch (err) {
      threw = String(err.message).includes('unbalanced');
      try {
        await client.query('ROLLBACK');
      } catch {}
    } finally {
      client.release();
    }
    assert(threw, 'DB trigger should reject unbalanced commit');
  });

  await step('period lock blocks new journals dated inside', async () => {
    const period = await upsertPeriod({
      entityId,
      label: 'Apr 2025',
      startDate: '2025-04-01',
      endDate: '2025-04-30',
    });
    await lockPeriod(entityId, period.id, {
      actor: { userId, email: 'smoke@test', role: 'admin' },
    });
    let threw = false;
    try {
      await postSale({
        entityId,
        date: '2025-04-20',
        amountPence: 100,
        invoiceId: 'INV-LOCKED',
      });
    } catch (err) {
      threw = err.code === 'PERIOD_LOCKED';
    }
    assert(threw, 'expected PERIOD_LOCKED error');
    // A journal outside the locked period should still work.
    await postSale({
      entityId,
      date: '2025-05-01',
      amountPence: 500,
      invoiceId: 'INV-2',
    });
  });

  await step('P&L + Balance Sheet sanity', async () => {
    const pl = await profitAndLoss(entityId, { from: '2025-01-01', to: '2025-12-31' });
    // Two sales: £120.50 + £5.00 = £125.50 = 12550p
    assertEq(pl.income.totalPence, 12550, 'P&L income total');
    assertEq(pl.netProfitPence, 12550, 'P&L net profit (no expenses yet)');

    const bs = await balanceSheet(entityId, '2025-12-31');
    assert(bs.isBalanced, `BS unbalanced: A=${bs.assets.totalPence} L=${bs.liabilities.totalPence} E=${bs.equity.totalPence}`);
  });

  await step('backfill dry-run + commit + idempotency + reverse', async () => {
    // Use a separate entity to keep the prior assertions clean.
    const db = getDb();
    const { users, entities } = getSchema();
    const u2 = `user_smoke2_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const e2 = `ent_smoke2_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
    await db.insert(users).values({
      id: u2, email: `${u2}@test.local`, name: 'BF', role: 'user', status: 'active',
    });
    await db.insert(entities).values({
      id: e2, userId: u2, name: 'BF Co', type: 'sole_trader', defaultCurrency: 'GBP', isDefault: true,
    });
    await seedAccountsForEntity(e2, 'sole_trader');

    const invoices = [
      { id: 'I1', date: '2024-06-01', total: '£100.00', paidStatus: 'paid', paidDate: '2024-06-10', customerName: 'A' },
      { id: 'I2', date: '2024-07-01', total: 50.5, paidStatus: 'unpaid', customerName: 'B' },
      { id: 'I3', date: '2024-08-15', total: '0', customerName: 'C' }, // skipped: zero
      { id: '',   date: '2024-09-01', total: '99' },                  // skipped: no-id
    ];
    const dry = await backfillInvoices({ entityId: e2, invoices }, { dryRun: true });
    assertEq(dry.summary.planned, 3, 'planned (2 sales + 1 payment)');
    assertEq(dry.summary.posted, 0, 'dry-run posts 0');

    const live = await backfillInvoices({ entityId: e2, invoices }, { dryRun: false });
    assertEq(live.summary.posted, 3, 'live posts 3');
    assertEq(live.summary.failed, 0, 'no failures');

    // Idempotency: re-run posts 0
    const again = await backfillInvoices({ entityId: e2, invoices }, { dryRun: false });
    assertEq(again.summary.planned, 0, 're-run plans 0');
    assertEq(again.summary.alreadyBackfilled, 3, 're-run sees 3 already');

    // TB balances on the backfilled entity
    const tb2 = await trialBalance(e2);
    assert(tb2.totals.isBalanced, 'backfill TB balances');
    // £150.50 sales recognised; £100 paid → debtors £50.50 outstanding
    const sales = tb2.rows.find((r) => r.code === '4000');
    assertEq(sales.balancePence, 15050, 'sales after backfill');
    const debtors = tb2.rows.find((r) => r.code === '1100');
    assertEq(debtors.balancePence, 5050, 'debtors after backfill');

    // Reverse + verify
    const rev = await reverseBackfill(e2);
    assertEq(rev.deleted, 3, 'reversed 3 journals');
    const tb3 = await trialBalance(e2);
    assertEq(tb3.totals.debitPence, 0, 'after reverse: 0 debit');
    assertEq(tb3.totals.creditPence, 0, 'after reverse: 0 credit');

    // Cleanup
    await db.delete(entities).where(eq(entities.id, e2));
    await db.delete(users).where(eq(users.id, u2));
  });

  console.log('\nAll stage 1 smoke checks passed.');
}

main()
  .then(async () => {
    await teardown();
    await getPool().end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n[smoke] FAILED:', err);
    await teardown();
    try {
      await getPool().end();
    } catch {}
    process.exit(1);
  });
