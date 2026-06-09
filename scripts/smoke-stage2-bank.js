/**
 * Stage 2 smoke test — exercises the bank-feeds inbox end-to-end against
 * the local Replit Postgres instance.
 *
 * Tests:
 *   1. Create a CSV bank connection + bank account pinned to 0800
 *   2. Parse a Starling CSV — auto-detect format, normalised rows
 *   3. Import — first run inserts N, re-run inserts 0 (idempotent)
 *   4. Auto-suggest matches an open invoice (exact amount + date window)
 *   5. Match the bank line → posts an invoice_payment journal, TB balances
 *   6. Categorise an outflow → posts a bank-source expense journal
 *   7. Ignore a line — no journal posted
 *   8. Cross-bank dedupe — same row imported into a different bank
 *      account is allowed (dedupe is per-account)
 *   9. Generic CSV with custom column mapping
 *  10. Lloyds two-column debit/credit CSV
 *
 * Run:   DB_BACKEND=postgres node scripts/smoke-stage2-bank.js
 */

process.env.DB_BACKEND = process.env.DB_BACKEND || 'postgres';

const crypto = require('crypto');
const { eq } = require('drizzle-orm');
const { getDb, getSchema, getPool } = require('../api/_lib/db');
const { seedAccountsForEntity } = require('../api/_lib/ledger/accounts');
const { postSale, poundsToPence } = require('../api/_lib/ledger/posting');
const { trialBalance } = require('../api/_lib/ledger/reports');
const {
  createBankConnection,
  createBankAccount,
  importTransactions,
  suggestMatches,
  matchTransactionToInvoice,
  categoriseTransaction,
  ignoreTransaction,
  listTransactions,
} = require('../api/_lib/bank/transactions');
const { parseStatementCsv, detectFormat } = require('../api/_lib/bank/csv-parsers');

let userId;
let entityId;

async function setup() {
  const db = getDb();
  const { users, entities } = getSchema();
  userId = `user_smoke2_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  entityId = `ent_smoke2_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  await db.insert(users).values({
    id: userId,
    email: `smoke-${userId}@test.local`,
    name: 'Stage 2 Smoke',
    role: 'user',
    status: 'active',
  });
  await db.insert(entities).values({
    id: entityId,
    userId,
    name: 'Stage 2 Smoke Co',
    type: 'sole_trader',
    defaultCurrency: 'GBP',
    isDefault: true,
  });
  await seedAccountsForEntity(entityId, 'sole_trader');
}

async function teardown() {
  if (!entityId) return;
  const db = getDb();
  const { users, entities, journals, accounts, bankConnections, bankAccounts, bankTransactions } = getSchema();
  try {
    await db.delete(bankTransactions).where(eq(bankTransactions.entityId, entityId));
    await db.delete(bankAccounts).where(eq(bankAccounts.entityId, entityId));
    await db.delete(bankConnections).where(eq(bankConnections.entityId, entityId));
    await db.delete(journals).where(eq(journals.entityId, entityId));
    await db.delete(accounts).where(eq(accounts.entityId, entityId));
    await db.delete(entities).where(eq(entities.id, entityId));
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

// ---------------------------------------------------------------------
// Fixture: a Starling-format CSV with three rows. Two outflows and one
// inflow that matches an open invoice.
// ---------------------------------------------------------------------
const STARLING_CSV = `Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP),Spending Category,Notes
01/04/2025,Acme Ltd,INV-1 payment,FASTER PAYMENT,120.50,1120.50,Income,
03/04/2025,Tesco,Groceries,DEBIT CARD,-15.40,1105.10,Food,
05/04/2025,EE,Mobile bill,DIRECT DEBIT,-25.00,1080.10,Utilities,
`;

// Lloyds-style two-column CSV (Debit Amount / Credit Amount, one is blank per row).
const LLOYDS_CSV = `Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance
07/04/2025,DD,12-34-56,12345678,EDF Energy,42.00,,1038.10
08/04/2025,FPI,12-34-56,12345678,Bob Smith,,200.00,1238.10
`;

// Generic CSV (no recognised bank). Columns are unusually named;
// importer needs an explicit mapping.
const GENERIC_CSV = `When,Where,Movement
2025-04-09,Coffee shop,-3.50
2025-04-10,Refund from Amazon,7.99
`;

async function main() {
  console.log('Stage 2 smoke test (bank feeds)');
  await setup();
  console.log(`  using entityId=${entityId}`);

  let connId;
  let bankAccountId;
  let secondBankAccountId;

  await step('CSV format detection works', async () => {
    assertEq(detectFormat(STARLING_CSV), 'starling', 'starling detection');
    assertEq(detectFormat(LLOYDS_CSV), 'lloyds', 'lloyds detection');
    // Generic CSV with no canonical bank-name has no auto-format.
    const genericFmt = detectFormat(GENERIC_CSV);
    assert(genericFmt === null || genericFmt === 'generic', 'generic detect');
  });

  await step('parses Starling CSV into 3 normalised rows', async () => {
    const parsed = parseStatementCsv(STARLING_CSV);
    assertEq(parsed.format, 'starling', 'format');
    assertEq(parsed.rows.length, 3, 'row count');
    assertEq(parsed.rows[0].amountPence, 12050, 'row 1 amount (+£120.50)');
    assertEq(parsed.rows[0].date, '2025-04-01', 'row 1 date (UK→ISO)');
    assertEq(parsed.rows[1].amountPence, -1540, 'row 2 amount (-£15.40)');
    assertEq(parsed.rows[2].amountPence, -2500, 'row 3 amount (-£25.00)');
  });

  await step('creates a CSV connection + bank account pinned to 0800', async () => {
    const c = await createBankConnection({
      entityId,
      provider: 'csv',
      institutionName: 'Starling',
    });
    connId = c.id;
    const a = await createBankAccount({
      entityId,
      connectionId: connId,
      ledgerAccountCode: '0800',
      name: 'Starling Personal',
      accountNumberLast4: '1234',
    });
    bankAccountId = a.id;
    assert(a.ledgerAccountId, 'ledgerAccountId returned');
  });

  await step('post a sale so we have an open invoice to match', async () => {
    await postSale({
      entityId,
      date: '2025-04-01',
      amountPence: poundsToPence(120.5),
      invoiceId: 'INV-1',
      customerName: 'Acme Ltd',
    });
  });

  await step('imports CSV — 3 inserted, re-import inserts 0', async () => {
    const parsed = parseStatementCsv(STARLING_CSV);
    const r1 = await importTransactions({
      bankAccountId,
      entityId,
      rows: parsed.rows,
    });
    assertEq(r1.inserted, 3, 'first import inserted');
    assertEq(r1.skipped, 0, 'first import skipped');
    const r2 = await importTransactions({
      bankAccountId,
      entityId,
      rows: parsed.rows,
    });
    assertEq(r2.inserted, 0, 'second import inserted (idempotent)');
    assertEq(r2.skipped, 3, 'second import skipped');
  });

  let inflowId;
  let outflow1Id;
  let outflow2Id;

  await step('lists imported transactions in date-desc order', async () => {
    const rows = await listTransactions({ bankAccountId });
    assertEq(rows.length, 3, 'list count');
    // Most recent first
    assertEq(rows[0].date, '2025-04-05', 'newest first');
    // Find each
    inflowId = rows.find((r) => r.amountPence === 12050).id;
    outflow1Id = rows.find((r) => r.amountPence === -1540).id;
    outflow2Id = rows.find((r) => r.amountPence === -2500).id;
    assert(inflowId && outflow1Id && outflow2Id, 'all three ids resolved');
  });

  await step('auto-suggest finds the open invoice for the inflow', async () => {
    const suggestions = await suggestMatches(inflowId);
    assert(suggestions.length >= 1, 'at least one suggestion');
    assertEq(suggestions[0].kind, 'invoice_payment', 'kind');
    assertEq(suggestions[0].invoiceId, 'INV-1', 'matched invoice id');
  });

  await step('match inflow → posts payment journal, TB balances', async () => {
    const r = await matchTransactionToInvoice(
      { bankTxId: inflowId, invoiceId: 'INV-1', customerName: 'Acme Ltd' },
      { actor: { userId, email: 'smoke@test', role: 'admin' } }
    );
    assert(r.journalId.startsWith('jrn_'), 'journal id format');
    const tb = await trialBalance(entityId);
    assert(tb.totals.isBalanced, 'TB balanced after match');
    // Bank should be 12050p debit (sale paid in)
    const bank = tb.rows.find((r) => r.code === '0800');
    assertEq(bank.balancePence, 12050, '0800 Bank balance');
    // Debtors should be 0 (sale + payment cancel)
    const debtors = tb.rows.find((r) => r.code === '1100');
    assertEq(debtors.balancePence, 0, '1100 Debtors balance');
  });

  await step('categorise outflow → posts an expense journal', async () => {
    // Use a real expense code from the seed CoA. Pick the first expense
    // account (any code in the 5000-8999 range will do) — find one by
    // querying the schema directly.
    const db = getDb();
    const { accounts: accountsT } = getSchema();
    const expenseAccts = await db
      .select()
      .from(accountsT)
      .where(eq(accountsT.entityId, entityId));
    const expense = expenseAccts.find((a) => a.type === 'expense');
    assert(expense, 'has at least one expense account');

    await categoriseTransaction(
      {
        bankTxId: outflow1Id,
        accountCode: expense.code,
        vendorOrPayer: 'Tesco',
      },
      { actor: { userId, email: 'smoke@test', role: 'admin' } }
    );
    const tb = await trialBalance(entityId);
    assert(tb.totals.isBalanced, 'TB balanced after categorise');
    const bank = tb.rows.find((r) => r.code === '0800');
    // 12050 in - 1540 out = 10510
    assertEq(bank.balancePence, 10510, '0800 after expense');
    const exp = tb.rows.find((r) => r.code === expense.code);
    assertEq(exp.balancePence, 1540, 'expense balance');
  });

  await step('ignore line — no journal posted', async () => {
    await ignoreTransaction(outflow2Id, 'personal', {
      actor: { userId, email: 'smoke@test', role: 'admin' },
    });
    const rows = await listTransactions({ bankAccountId, status: 'ignored' });
    assertEq(rows.length, 1, 'one ignored');
    assertEq(rows[0].id, outflow2Id, 'right line ignored');
    // TB should be unchanged from previous step
    const tb = await trialBalance(entityId);
    const bank = tb.rows.find((r) => r.code === '0800');
    assertEq(bank.balancePence, 10510, '0800 unchanged after ignore');
  });

  await step('cross-bank dedupe — same row in a 2nd bank account is allowed', async () => {
    const a2 = await createBankAccount({
      entityId,
      connectionId: connId,
      ledgerAccountCode: '0810', // Cash in Hand
      name: 'Cash drawer',
    });
    secondBankAccountId = a2.id;
    const parsed = parseStatementCsv(STARLING_CSV);
    const r = await importTransactions({
      bankAccountId: secondBankAccountId,
      entityId,
      rows: parsed.rows,
    });
    assertEq(r.inserted, 3, 'all 3 inserted into 2nd bank account');
  });

  await step('generic CSV with explicit mapping parses correctly', async () => {
    const parsed = parseStatementCsv(GENERIC_CSV, {
      format: 'generic',
      mapping: { date: 'When', description: 'Where', amount: 'Movement' },
    });
    assertEq(parsed.rows.length, 2, 'generic row count');
    assertEq(parsed.rows[0].amountPence, -350, 'generic row 1');
    assertEq(parsed.rows[1].amountPence, 799, 'generic row 2');
  });

  await step('Lloyds two-column debit/credit CSV', async () => {
    const parsed = parseStatementCsv(LLOYDS_CSV);
    assertEq(parsed.format, 'lloyds', 'format');
    assertEq(parsed.rows.length, 2, 'row count');
    // 42.00 in debit column → -£42.00; 200.00 in credit column → +£200.00
    assertEq(parsed.rows[0].amountPence, -4200, 'lloyds row 1 (debit)');
    assertEq(parsed.rows[1].amountPence, 20000, 'lloyds row 2 (credit)');
  });

  console.log('\nAll Stage 2 smoke checks passed.');
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
