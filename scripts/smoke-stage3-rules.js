/**
 * Stage 3 smoke test — auto-categorisation engine.
 *
 *  1. Seed CoA + a bank account
 *  2. Seed UK default rule library (idempotent)
 *  3. Merchant signature normalisation (different layouts → same sig)
 *  4. Rule matching: TFL → 7100, AWS → 7500, hotel → 7100
 *  5. Inflow/outflow filter: a credit-side TFL doesn't match the
 *     out-only rule
 *  6. Bulk apply with dryRun → returns suggestions, posts nothing
 *  7. Bulk apply with autoPost → journals posted, status='posted',
 *     trial balance still balances
 *  8. Merchant memory: after categorising "FRESH FLOWERS LTD" once,
 *     a second visit auto-suggests the same code (memory hit, conf=70)
 *  9. Memory re-pointing: re-categorising drops hits to 1
 * 10. testRuleAgainstHistory preview returns match count
 * 11. CRUD: create → update → delete a user rule; priority order
 *     resolves higher-priority rule when two would match
 */

process.env.DB_BACKEND = process.env.DB_BACKEND || 'postgres';

const crypto = require('crypto');
const { eq } = require('drizzle-orm');
const { getDb, getSchema, getPool } = require('../api/_lib/db');
const { seedAccountsForEntity, getAccountByCode } = require('../api/_lib/ledger/accounts');
const { trialBalance } = require('../api/_lib/ledger/reports');
const {
  createBankConnection,
  createBankAccount,
  importTransactions,
  categoriseTransaction,
  listTransactions,
} = require('../api/_lib/bank/transactions');
const {
  extractMerchantSignature,
  seedDefaultRulesForEntity,
  findRuleMatch,
  findMemoryMatch,
  recordMerchantMemory,
  suggestCategory,
  applyRulesToUnmatched,
  createRule,
  updateRule,
  deleteRule,
  listRules,
  testRuleAgainstHistory,
  memoryConfidenceFor,
} = require('../api/_lib/bank/rules');

let userId;
let entityId;

async function setup() {
  const db = getDb();
  const { users, entities } = getSchema();
  userId = `user_smoke3_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  entityId = `ent_smoke3_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  await db.insert(users).values({
    id: userId,
    email: `smoke-${userId}@test.local`,
    name: 'Stage 3 Smoke',
    role: 'user',
    status: 'active',
  });
  await db.insert(entities).values({
    id: entityId,
    userId,
    name: 'Stage 3 Smoke Co',
    type: 'sole_trader',
    defaultCurrency: 'GBP',
    isDefault: true,
  });
  await seedAccountsForEntity(entityId, 'sole_trader');
}

async function teardown() {
  if (!entityId) return;
  const db = getDb();
  const {
    users,
    entities,
    journals,
    accounts,
    bankConnections,
    bankAccounts,
    bankTransactions,
    bankRules,
    merchantMemory,
  } = getSchema();
  try {
    await db.delete(merchantMemory).where(eq(merchantMemory.entityId, entityId));
    await db.delete(bankRules).where(eq(bankRules.entityId, entityId));
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
  if (a !== b) throw new Error(`Assertion failed: ${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
}
async function step(name, fn) {
  process.stdout.write(`  ${name} … `);
  await fn();
  process.stdout.write('OK\n');
}

async function main() {
  console.log('Stage 3 smoke test (auto-categorisation engine)');
  await setup();
  console.log(`  using entityId=${entityId}`);

  let bankAccountId;

  // ------------------------------------------------------------------
  await step('merchant signature is stable across noisy descriptions', async () => {
    // All three describe the same merchant with different
    // refs/dates/cards/casing.
    const a = extractMerchantSignature('Card 1234 STARBUCKS LIVERPOOL ST 03MAR25', null);
    const b = extractMerchantSignature('starbucks liverpool st REF 887742', null);
    const c = extractMerchantSignature('STARBUCKS LIVERPOOL ST 2025-03-10', null);
    assertEq(a, b, 'starbucks: a == b');
    assertEq(b, c, 'starbucks: b == c');
    assert(a.includes('starbucks'), `signature contains brand: ${a}`);

    // Counterparty preferred when present (cleaner).
    const d = extractMerchantSignature('Some noisy memo', 'Acme Ltd');
    assertEq(d, 'acme ltd', 'counterparty preferred');
  });

  await step('signature confidence ramp behaves', async () => {
    assertEq(memoryConfidenceFor(1), 60, '1 hit');
    assertEq(memoryConfidenceFor(2), 70, '2 hits');
    assertEq(memoryConfidenceFor(3), 80, '3 hits');
    assertEq(memoryConfidenceFor(4), 88, '4 hits');
    assertEq(memoryConfidenceFor(10), 95, '10 hits caps at 95');
  });

  // ------------------------------------------------------------------
  await step('seed UK default rule library is idempotent', async () => {
    const r1 = await seedDefaultRulesForEntity(entityId);
    assert(r1.inserted >= 40, `>= 40 rules inserted (got ${r1.inserted})`);
    const r2 = await seedDefaultRulesForEntity(entityId);
    assertEq(r2.inserted, 0, 're-seed inserts 0');
    const rows = await listRules(entityId);
    assertEq(rows.length, r1.inserted, 'list count matches insert');
  });

  // ------------------------------------------------------------------
  await step('set up bank account + import a fixture batch', async () => {
    const conn = await createBankConnection({
      entityId,
      provider: 'csv',
      institutionName: 'Starling',
    });
    const acct = await createBankAccount({
      entityId,
      connectionId: conn.id,
      ledgerAccountCode: '0800',
      name: 'Starling Personal',
    });
    bankAccountId = acct.id;
    const rows = [
      { date: '2025-04-01', amountPence: -350,  description: 'TFL TRAVEL CH 12345', counterparty: 'TfL' },
      { date: '2025-04-02', amountPence: -1500, description: 'AWS EMEA s.a r.l.',   counterparty: 'Amazon Web Services' },
      { date: '2025-04-03', amountPence: -8500, description: 'PREMIER INN MANCHESTER 03APR25', counterparty: 'Premier Inn' },
      { date: '2025-04-04', amountPence: -4500, description: 'FRESH FLOWERS LTD ref 7785', counterparty: 'Fresh Flowers Ltd' },
      { date: '2025-04-05', amountPence: -4500, description: 'FRESH FLOWERS LTD ref 9912', counterparty: 'Fresh Flowers Ltd' },
      // an inflow that LOOKS like TFL — should NOT match the out-only rule
      { date: '2025-04-06', amountPence:  500,  description: 'TFL refund',             counterparty: 'TfL' },
    ];
    const r = await importTransactions({ bankAccountId, entityId, rows });
    assertEq(r.inserted, 6, '6 rows imported');
  });

  // ------------------------------------------------------------------
  let tflId, awsId, hotelId, flowers1Id, flowers2Id, refundId;

  await step('rule engine matches TFL/AWS/hotel; refund inflow does not match', async () => {
    const all = await listTransactions({ bankAccountId });
    tflId    = all.find((r) => r.description.startsWith('TFL TRAVEL')).id;
    awsId    = all.find((r) => r.description.startsWith('AWS EMEA')).id;
    hotelId  = all.find((r) => r.description.startsWith('PREMIER INN')).id;
    flowers1Id = all.find((r) => r.description === 'FRESH FLOWERS LTD ref 7785').id;
    flowers2Id = all.find((r) => r.description === 'FRESH FLOWERS LTD ref 9912').id;
    refundId = all.find((r) => r.description === 'TFL refund').id;

    const tflTx    = all.find((r) => r.id === tflId);
    const awsTx    = all.find((r) => r.id === awsId);
    const hotelTx  = all.find((r) => r.id === hotelId);
    const refundTx = all.find((r) => r.id === refundId);

    const tflMatch = await findRuleMatch(entityId, tflTx);
    assert(tflMatch, 'TFL matches');
    assertEq(tflMatch.action.accountCode, '7100', 'TFL → 7100');
    assertEq(tflMatch.confidence, 100, 'rule confidence 100');

    const awsMatch = await findRuleMatch(entityId, awsTx);
    assert(awsMatch, 'AWS matches');
    assertEq(awsMatch.action.accountCode, '7500', 'AWS → 7500');

    const hotelMatch = await findRuleMatch(entityId, hotelTx);
    assert(hotelMatch, 'Premier Inn matches');
    assertEq(hotelMatch.action.accountCode, '7100', 'Premier Inn → 7100');

    // Inflow on a TFL-keyword line: rule has amountSign='out' so it
    // should NOT match — refunds aren't expenses.
    const refundMatch = await findRuleMatch(entityId, refundTx);
    assertEq(refundMatch, null, 'inflow does NOT match out-only rule');
  });

  // ------------------------------------------------------------------
  await step('dry-run apply: 3 suggestions, 0 posts', async () => {
    const r = await applyRulesToUnmatched({
      bankAccountId,
      autoPost: true,
      dryRun: true,
      autoPostThreshold: 95,
    });
    assertEq(r.scanned, 6, 'scanned all 6');
    assertEq(r.suggested, 3, 'suggested = 3 rule hits');
    assertEq(r.posted, 0, 'dryRun posted 0');
    const stillUnmatched = await listTransactions({ bankAccountId, status: 'unmatched' });
    assertEq(stillUnmatched.length, 6, 'still all unmatched after dryRun');
  });

  // ------------------------------------------------------------------
  await step('autoPost: 3 rule-hit lines posted, TB still balances', async () => {
    const r = await applyRulesToUnmatched({
      bankAccountId,
      autoPost: true,
      dryRun: false,
      autoPostThreshold: 95,
    }, { actor: { userId, email: 'smoke@test', role: 'admin' } });
    assertEq(r.posted, 3, 'posted 3');
    const tb = await trialBalance(entityId);
    assert(tb.totals.isBalanced, 'TB balanced after auto-post');
    const code7100 = tb.rows.find((r) => r.code === '7100');
    const code7500 = tb.rows.find((r) => r.code === '7500');
    // TFL £3.50 + Premier Inn £85.00 = £88.50 → 8850p in 7100
    assertEq(code7100.balancePence, 8850, '7100 balance');
    // AWS £15.00 = 1500p in 7500
    assertEq(code7500.balancePence, 1500, '7500 balance');
    // Bank should be -10350 (3 outflows)
    const bank = tb.rows.find((r) => r.code === '0800');
    assertEq(bank.balancePence, -10350, '0800 balance after 3 outflows');
  });

  // ------------------------------------------------------------------
  await step('manual categorise of FRESH FLOWERS feeds merchant memory', async () => {
    // FRESH FLOWERS doesn't match any default rule. User manually
    // categorises the first one as 7000 Office Costs. Memory should
    // record it.
    await categoriseTransaction(
      { bankTxId: flowers1Id, accountCode: '7000', vendorOrPayer: 'Fresh Flowers Ltd' },
      { actor: { userId, email: 'smoke@test', role: 'admin' } }
    );
    // The earlier auto-post pass also wrote memory rows for TFL/AWS/
    // Premier Inn (that's the whole point — every accepted categorise
    // teaches the engine). So total memory count = 3 from autopost +
    // 1 from this manual call = 4. Assert by signature instead.
    const sig = extractMerchantSignature('FRESH FLOWERS LTD ref 7785', 'Fresh Flowers Ltd');
    const db = getDb();
    const { merchantMemory } = getSchema();
    const mem = await db
      .select()
      .from(merchantMemory)
      .where(eq(merchantMemory.merchantSignature, sig));
    assertEq(mem.length, 1, 'one memory row for FRESH FLOWERS');
    assertEq(mem[0].hitsCount, 1, 'first hit');
    assertEq(mem[0].confidence, 60, 'confidence=60 after 1 hit');
  });

  // ------------------------------------------------------------------
  await step('memory hit on the second FRESH FLOWERS line', async () => {
    const db = getDb();
    const { bankTransactions } = getSchema();
    const [tx2] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, flowers2Id));
    const mem = await findMemoryMatch(entityId, tx2);
    assert(mem, 'memory match found');
    assertEq(mem.accountCode, '7000', 'memory points at 7000');
    assertEq(mem.confidence, 60, 'confidence=60');
    // suggestCategory should now find this via memory (no rule hit).
    const s = await suggestCategory(entityId, flowers2Id);
    assert(s, 'suggestion found');
    assertEq(s.source, 'memory', 'source=memory');
    assertEq(s.action.accountCode, '7000', 'suggestion action 7000');
  });

  // ------------------------------------------------------------------
  await step('memory bumps to hits=2 after second categorise', async () => {
    await categoriseTransaction(
      { bankTxId: flowers2Id, accountCode: '7000', vendorOrPayer: 'Fresh Flowers Ltd' },
      { actor: { userId, email: 'smoke@test', role: 'admin' } }
    );
    const sig = extractMerchantSignature('FRESH FLOWERS LTD ref 9912', 'Fresh Flowers Ltd');
    const db = getDb();
    const { merchantMemory } = getSchema();
    const mem = await db
      .select()
      .from(merchantMemory)
      .where(eq(merchantMemory.merchantSignature, sig));
    assertEq(mem.length, 1, 'still one memory row for FRESH FLOWERS (upsert)');
    assertEq(mem[0].hitsCount, 2, 'hitsCount=2');
    assertEq(mem[0].confidence, 70, 'confidence=70 after 2 hits');
  });

  // ------------------------------------------------------------------
  await step('memory re-points: writing a different account drops hits to 1', async () => {
    // Simulate user changing their mind via the helper directly
    // (the schema-aware path) — re-pointing FRESH FLOWERS at 8100.
    const sundry = await getAccountByCode(entityId, '8100');
    const r = await recordMerchantMemory(
      entityId,
      { description: 'FRESH FLOWERS LTD ref 9912', counterparty: 'Fresh Flowers Ltd' },
      sundry.id
    );
    assert(r.repointed, 'repointed=true');
    assertEq(r.hitsCount, 1, 'hits reset to 1 on repoint');
  });

  // ------------------------------------------------------------------
  await step('testRuleAgainstHistory preview', async () => {
    // Hypothetical rule: ANY description containing "FLOWERS" → 7000.
    const r = await testRuleAgainstHistory(entityId, {
      anyOf: [{ field: 'description', op: 'contains_ci', value: 'FLOWERS' }],
      amountSign: 'out',
    }, { windowDays: 1000 });
    assertEq(r.matched, 2, 'two flowers lines would have matched');
    assert(r.scanned >= 2, 'scanned at least 2');
  });

  // ------------------------------------------------------------------
  await step('CRUD + priority order: higher-priority custom rule wins over default', async () => {
    // Default rule "Hotels" priority 14 → 7100.
    // Add a HIGHER-priority (lower number) custom rule that specifically
    // re-routes Premier Inn → 8100 Sundry Expenses, then verify the
    // engine returns the custom rule's action.
    const created = await createRule(
      {
        entityId,
        name: 'Premier Inn → Sundry (test override)',
        priority: 5,
        conditions: {
          anyOf: [{ field: 'description', op: 'contains_ci', value: 'PREMIER INN' }],
          amountSign: 'out',
        },
        action: { kind: 'categorise', accountCode: '8100' },
      },
      { actor: { userId, email: 'smoke@test', role: 'admin' } }
    );
    assert(created.id.startsWith('br_'), 'rule id format');

    const db = getDb();
    const { bankTransactions } = getSchema();
    const [hotelTx] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, hotelId));
    const m = await findRuleMatch(entityId, hotelTx);
    assert(m, 'priority match found');
    assertEq(m.action.accountCode, '8100', 'higher-priority custom rule wins');
    assertEq(m.rule.id, created.id, 'matching rule is the custom one');

    // Update + delete CRUD round trip.
    await updateRule(created.id, { active: false });
    const rules = await listRules(entityId);
    const r = rules.find((x) => x.id === created.id);
    assertEq(r.active, false, 'rule disabled');
    await deleteRule(created.id);
    const after = await listRules(entityId);
    assert(!after.find((x) => x.id === created.id), 'rule deleted');
  });

  console.log('\nAll Stage 3 smoke checks passed.');
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
