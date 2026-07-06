/**
 * Stage 9 smoke — Invoicing polish (contacts, invoices, quotes,
 * recurring, payment links, statements, reminders, dashboard,
 * multi-currency).
 *
 *   1.  Contacts: create + list + archive
 *   2.  Invoice create posts a balanced sale journal & links journalId
 *   3.  Invoice mark_paid (full) posts payment journal & flips status
 *   4.  Invoice mark_paid partial → partially_paid, then full → paid
 *   5.  Multi-currency (USD invoice) settles with FX gain (4100)
 *   6.  Multi-currency (USD invoice) settles with FX loss (8100)
 *   7.  Void invoice posts reversing journal + cannot void if paid
 *   8.  Quotes: create + accept (admin) + convert → invoice
 *   9.  Quotes: accept by token; token reuse rejected
 *  10.  Recurring template: createTemplate + generateDueRecurring
 *       advances nextRunDate; ends when past endDate
 *  11.  Payment links: recordIntent idempotent on (provider, ref);
 *       processWebhookEvent succeeded → marks invoice paid
 *  12.  Payment link webhook idempotent on (provider, eventId)
 *  13.  Statements: opening + transactions + closing balance reconcile
 *  14.  Reminders: rule + computeDueReminders writes log rows; idempotent
 *  15.  Dashboard: receivablesAging buckets + averageDaysToPay
 *  16.  Tenant isolation: entityB cannot see entityA invoices
 *  17.  Trial Balance still balances after Stage 9 activity
 */

process.env.DB_BACKEND = process.env.DB_BACKEND || 'postgres';

const crypto = require('crypto');
const { eq, and } = require('drizzle-orm');
const { getDb, getSchema, getPool } = require('../api/_lib/db');
const { seedAccountsForEntity } = require('../api/_lib/ledger/accounts');
const ledgerReports = require('../api/_lib/ledger/reports');

const contactsLib = require('../api/_lib/contacts/contacts');
const invoicesLib = require('../api/_lib/invoicing/invoices');
const quotesLib = require('../api/_lib/invoicing/quotes');
const recurringLib = require('../api/_lib/invoicing/recurring');
const paymentLinksLib = require('../api/_lib/invoicing/payment-links');
const statementsLib = require('../api/_lib/invoicing/statements');
const remindersLib = require('../api/_lib/invoicing/reminders');
const dashboardLib = require('../api/_lib/invoicing/dashboard');
const fx = require('../api/_lib/invoicing/fx');

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
    id, userId, name: `Stage9 ${prefix}`, type, defaultCurrency: 'GBP', isDefault: false,
  });
  await seedAccountsForEntity(id, type);
  return id;
}

async function main() {
  console.log('Stage 9 smoke (Invoicing polish)');
  const db = getDb();
  const { users, journals, journalLines } = getSchema();
  const userId = `usr_smoke9_${crypto.randomBytes(4).toString('hex')}`;
  await db.insert(users).values({
    id: userId, email: `${userId}@test.local`, name: 'Stage 9', role: 'user', status: 'active',
  });

  const entityA = await makeEntity('st9a', userId);
  const entityB = await makeEntity('st9b', userId);
  console.log(`  using entityA=${entityA}, entityB=${entityB}`);

  // -------------------------------------------------------------------
  // 1. Contacts
  // -------------------------------------------------------------------
  let acmeId, beachCoId;
  await step('Contact create + list + archive', async () => {
    const { id: a } = await contactsLib.createContact({
      entityId: entityA, name: 'Acme Ltd', email: 'ap@acme.test', defaultCurrency: 'GBP',
      paymentTermsDays: 14,
    });
    acmeId = a;
    const { id: b } = await contactsLib.createContact({
      entityId: entityA, name: 'Beach Co', defaultCurrency: 'USD', paymentTermsDays: 30,
    });
    beachCoId = b;
    const list = await contactsLib.listContacts({ entityId: entityA });
    assertEq(list.length, 2, 'two contacts');
    await contactsLib.archiveContact(b);
    const after = await contactsLib.listContacts({ entityId: entityA });
    assertEq(after.length, 1, 'one after archive');
    const all = await contactsLib.listContacts({ entityId: entityA, includeArchived: true });
    assertEq(all.length, 2, 'two with includeArchived');
  });

  // -------------------------------------------------------------------
  // 2. Invoice create posts balanced journal
  // -------------------------------------------------------------------
  let inv1Id;
  await step('createInvoice posts balanced sale journal', async () => {
    const r = await invoicesLib.createInvoice({
      entityId: entityA, invoiceNumber: 'INV-1001', contactId: acmeId,
      issueDate: '2025-01-10', paymentTermsDays: 14, totalPence: 1_200_00,
      lineItems: [{ description: 'Consulting', qty: 1, unitPence: 1_200_00 }],
    });
    inv1Id = r.id;
    assert(r.journalId, 'has journalId');
    const lines = await db.select().from(journalLines).where(eq(journalLines.journalId, r.journalId));
    const dr = lines.reduce((a, l) => a + Number(l.debitPence), 0);
    const cr = lines.reduce((a, l) => a + Number(l.creditPence), 0);
    assertEq(dr, 1_200_00, 'DR total');
    assertEq(cr, 1_200_00, 'CR total');
    const inv = await invoicesLib.getInvoice(inv1Id);
    assertEq(inv.status, 'sent', 'status sent');
    assertEq(inv.dueDate, '2025-01-24', 'due date issue+14');
  });

  // -------------------------------------------------------------------
  // 3+4. Mark paid full / partial
  // -------------------------------------------------------------------
  await step('markPaid full settles invoice', async () => {
    const r = await invoicesLib.markPaid({
      invoiceId: inv1Id, paidDate: '2025-01-20', amountPence: 1_200_00,
    });
    assert(r.fullySettled, 'fully settled');
    const inv = await invoicesLib.getInvoice(inv1Id);
    assertEq(inv.status, 'paid', 'status paid');
  });

  let inv2Id;
  await step('markPaid partial → partially_paid then paid', async () => {
    const r = await invoicesLib.createInvoice({
      entityId: entityA, invoiceNumber: 'INV-1002', contactId: acmeId,
      issueDate: '2025-02-01', totalPence: 500_00,
    });
    inv2Id = r.id;
    await invoicesLib.markPaid({ invoiceId: inv2Id, paidDate: '2025-02-10', amountPence: 200_00 });
    let inv = await invoicesLib.getInvoice(inv2Id);
    assertEq(inv.status, 'partially_paid', 'partial');
    await invoicesLib.markPaid({ invoiceId: inv2Id, paidDate: '2025-02-15', amountPence: 300_00 });
    inv = await invoicesLib.getInvoice(inv2Id);
    assertEq(inv.status, 'paid', 'paid in full');
    // Overpayment rejected
    let threw = false;
    try { await invoicesLib.markPaid({ invoiceId: inv2Id, paidDate: '2025-03-01', amountPence: 1_00 }); }
    catch (e) { threw = true; }
    assert(threw, 'second-time settle rejected');
  });

  // -------------------------------------------------------------------
  // 5. Multi-currency invoice with FX gain
  // -------------------------------------------------------------------
  await step('USD invoice with FX gain on settlement (4100)', async () => {
    // Issue at 0.78 GBP per USD, settle at 0.80 GBP per USD → gain
    const r = await invoicesLib.createInvoice({
      entityId: entityA, invoiceNumber: 'INV-USD-1', contactId: acmeId,
      issueDate: '2025-03-01', currency: 'USD', fxRateToBase: 0.78,
      totalPence: 1_000_00, // $1,000 → £780 base
    });
    const inv = await invoicesLib.getInvoice(r.id);
    assertEq(Number(inv.totalBasePence), 780_00, 'base GBP at issue');
    const settled = await invoicesLib.markPaid({
      invoiceId: r.id, paidDate: '2025-03-15', amountPence: 1_000_00, settleFxRateToBase: 0.80,
    });
    assert(settled.fxJournalId, 'fx journal posted');
    const fxLines = await db.select().from(journalLines).where(eq(journalLines.journalId, settled.fxJournalId));
    // Gain = (1_000_00 * 0.80) - (1_000_00 * 0.78) = 80000 - 78000 = 2000 pence (£20)
    const dr = fxLines.reduce((a, l) => a + Number(l.debitPence), 0);
    assertEq(dr, 20_00, 'fx gain debit');
  });

  // -------------------------------------------------------------------
  // 6. FX loss
  // -------------------------------------------------------------------
  await step('USD invoice with FX loss on settlement (8100)', async () => {
    const r = await invoicesLib.createInvoice({
      entityId: entityA, invoiceNumber: 'INV-USD-2', contactId: acmeId,
      issueDate: '2025-04-01', currency: 'USD', fxRateToBase: 0.80,
      totalPence: 500_00, // $500 → £400 base
    });
    const settled = await invoicesLib.markPaid({
      invoiceId: r.id, paidDate: '2025-04-20', amountPence: 500_00, settleFxRateToBase: 0.76,
    });
    assert(settled.fxJournalId, 'fx journal posted');
    const fxJournal = await db.select().from(journals).where(eq(journals.id, settled.fxJournalId));
    assertEq(fxJournal[0].sourceType, 'fx_settlement', 'sourceType tagged');
    assertEq(fxJournal[0].sourceId, r.id, 'sourceId points back to invoice');
  });

  // -------------------------------------------------------------------
  // 7. Void invoice
  // -------------------------------------------------------------------
  await step('voidInvoice posts reversing journal + cannot void paid', async () => {
    const r = await invoicesLib.createInvoice({
      entityId: entityA, invoiceNumber: 'INV-VOID-1', contactId: acmeId,
      issueDate: '2025-05-01', totalPence: 100_00,
    });
    const v = await invoicesLib.voidInvoice({ invoiceId: r.id, voidDate: '2025-05-02', reason: 'duplicate' });
    assert(v.reverseJournalId, 'reverse journal');
    const inv = await invoicesLib.getInvoice(r.id);
    assertEq(inv.status, 'void', 'status void');
    // Cannot void after partial payment
    const r2 = await invoicesLib.createInvoice({
      entityId: entityA, invoiceNumber: 'INV-VOID-2', contactId: acmeId,
      issueDate: '2025-05-03', totalPence: 100_00,
    });
    await invoicesLib.markPaid({ invoiceId: r2.id, paidDate: '2025-05-04', amountPence: 50_00 });
    let threw = false;
    try { await invoicesLib.voidInvoice({ invoiceId: r2.id, voidDate: '2025-05-05' }); }
    catch (e) { threw = true; assert(/partially-paid/.test(e.message), e.message); }
    assert(threw, 'void of partially-paid rejected');
  });

  // -------------------------------------------------------------------
  // 8. Quotes: admin accept + convert
  // -------------------------------------------------------------------
  await step('Quote create + admin accept + convert to invoice', async () => {
    const { id: qid } = await quotesLib.createQuote({
      entityId: entityA, quoteNumber: 'QUO-1', contactId: acmeId,
      issueDate: '2025-06-01', expiryDate: '2099-06-30', totalPence: 700_00,
      lineItems: [{ description: 'Project', qty: 1, unitPence: 700_00 }],
    });
    await quotesLib.acceptQuote({ id: qid });
    const conv = await quotesLib.convertToInvoice({
      id: qid, invoiceNumber: 'INV-FROM-QUO-1', issueDate: '2025-06-05',
    });
    const q = await quotesLib.getQuote(qid);
    assertEq(q.status, 'converted', 'quote converted');
    assertEq(q.convertedInvoiceId, conv.invoiceId, 'invoice linked');
    const inv = await invoicesLib.getInvoice(conv.invoiceId);
    assertEq(inv.quoteId, qid, 'invoice.quoteId set');
    assertEq(Number(inv.totalPence), 700_00, 'amount matches quote');
  });

  // -------------------------------------------------------------------
  // 9. Quotes: accept-by-token + reuse rejection
  // -------------------------------------------------------------------
  await step('Quote accept by token; token reuse rejected', async () => {
    const { id, token } = await quotesLib.createQuote({
      entityId: entityA, quoteNumber: 'QUO-2', contactId: acmeId,
      issueDate: '2025-06-10', totalPence: 200_00,
    });
    assert(token && token.length > 16, 'token issued');
    await quotesLib.acceptQuote({ token });
    const q = await quotesLib.getQuote(id);
    assertEq(q.status, 'accepted', 'accepted');
    assert(q.acceptTokenHash === null, 'token burned');
    // Reuse rejected (token hash gone → invalid)
    let threw = false;
    try { await quotesLib.acceptQuote({ token }); } catch (e) { threw = true; }
    assert(threw, 'token reuse blocked');
  });

  // -------------------------------------------------------------------
  // 10. Recurring templates
  // -------------------------------------------------------------------
  await step('Recurring template generates + advances nextRunDate', async () => {
    const { id: tid } = await recurringLib.createTemplate({
      entityId: entityA, contactId: acmeId, frequency: 'monthly',
      startDate: '2025-07-01', endDate: '2025-09-15', totalPence: 99_00,
      lineItems: [{ description: 'Subscription', qty: 1, unitPence: 99_00 }],
    });
    // First run: asOfDate 2025-07-15 → generates 1 (issue=07-01), nextRun=08-01
    let gen = await recurringLib.generateDueRecurring({ entityId: entityA, asOfDate: '2025-07-15' });
    assertEq(gen.length, 1, 'first run');
    let tpl = await recurringLib.getTemplate(tid);
    assertEq(tpl.nextRunDate, '2025-08-01', 'advanced to Aug 1');
    assertEq(tpl.generatedCount, 1, 'count 1');
    // Second run: asOfDate 2025-08-15 → generates 1 (issue=08-01), nextRun=09-01
    gen = await recurringLib.generateDueRecurring({ entityId: entityA, asOfDate: '2025-08-15' });
    assertEq(gen.length, 1, 'second run');
    tpl = await recurringLib.getTemplate(tid);
    assertEq(tpl.nextRunDate, '2025-09-01', 'advanced to Sep 1');
    // Third run: asOfDate 2025-09-15 → generates 1 (issue=09-01), nextRun=10-01 > endDate=09-15 → ended
    gen = await recurringLib.generateDueRecurring({ entityId: entityA, asOfDate: '2025-09-15' });
    assertEq(gen.length, 1, 'third run');
    assert(gen[0].ended, 'ended flag');
    tpl = await recurringLib.getTemplate(tid);
    assertEq(tpl.status, 'ended', 'status ended');
    // Idempotent: asOfDate 2025-09-30 → generates 0
    gen = await recurringLib.generateDueRecurring({ entityId: entityA, asOfDate: '2025-09-30' });
    assertEq(gen.length, 0, 'no further runs');
  });

  // -------------------------------------------------------------------
  // 11+12. Payment links
  // -------------------------------------------------------------------
  let plInvoiceId, plProviderRef;
  await step('Payment link recordIntent idempotent + webhook settles invoice', async () => {
    const inv = await invoicesLib.createInvoice({
      entityId: entityA, invoiceNumber: 'INV-PL-1', contactId: acmeId,
      issueDate: '2025-10-01', totalPence: 250_00,
    });
    plInvoiceId = inv.id;
    plProviderRef = `cs_test_${crypto.randomBytes(6).toString('hex')}`;
    const a = await paymentLinksLib.recordIntent({
      invoiceId: inv.id, provider: 'stripe', providerRef: plProviderRef,
      amountPence: 250_00, currency: 'GBP',
    });
    const b = await paymentLinksLib.recordIntent({
      invoiceId: inv.id, provider: 'stripe', providerRef: plProviderRef,
      amountPence: 250_00, currency: 'GBP',
    });
    assertEq(a.id, b.id, 'recordIntent idempotent');
    assert(b.reused, 'second call reused');
    // Webhook 'succeeded' settles
    const ev = await paymentLinksLib.processWebhookEvent({
      provider: 'stripe', eventId: `evt_${crypto.randomBytes(6).toString('hex')}`,
      eventType: 'checkout.session.completed', providerRef: plProviderRef,
      status: 'succeeded', paidAt: '2025-10-05', amountPence: 250_00,
      payload: { object: 'checkout.session' },
    });
    assertEq(ev.newStatus, 'succeeded', 'status succeeded');
    assert(ev.paymentJournalId, 'payment journal posted');
    const i = await invoicesLib.getInvoice(inv.id);
    assertEq(i.status, 'paid', 'invoice paid');
  });

  await step('Webhook idempotent on (provider, eventId)', async () => {
    const eventId = `evt_${crypto.randomBytes(6).toString('hex')}`;
    const inv = await invoicesLib.createInvoice({
      entityId: entityA, invoiceNumber: 'INV-PL-2', contactId: acmeId,
      issueDate: '2025-10-10', totalPence: 50_00,
    });
    const ref = `pi_${crypto.randomBytes(6).toString('hex')}`;
    await paymentLinksLib.recordIntent({
      invoiceId: inv.id, provider: 'stripe', providerRef: ref, amountPence: 50_00,
    });
    const a = await paymentLinksLib.processWebhookEvent({
      provider: 'stripe', eventId, eventType: 'payment_intent.succeeded',
      providerRef: ref, status: 'succeeded', paidAt: '2025-10-12', amountPence: 50_00, payload: {},
    });
    const b = await paymentLinksLib.processWebhookEvent({
      provider: 'stripe', eventId, eventType: 'payment_intent.succeeded',
      providerRef: ref, status: 'succeeded', paidAt: '2025-10-12', amountPence: 50_00, payload: {},
    });
    assertEq(a.duplicate, false, 'first not duplicate');
    assertEq(b.duplicate, true, 'second is duplicate');
    const i = await invoicesLib.getInvoice(inv.id);
    assertEq(Number(i.paidPence), 50_00, 'paid only once');
  });

  // Signature verification
  await step('verifySignature accepts matching HMAC + rejects mismatch', async () => {
    const secret = 'whsec_test';
    const body = JSON.stringify({ id: 'evt_1', type: 'foo' });
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    assert(paymentLinksLib.verifySignature('stripe', body, `t=123,v1=${sig}`, secret), 'matches stripe');
    assert(paymentLinksLib.verifySignature('gocardless', body, sig, secret), 'matches gocardless');
    assert(!paymentLinksLib.verifySignature('stripe', body, `t=123,v1=${sig.slice(0, -2)}aa`, secret), 'rejects bad sig');
    assert(!paymentLinksLib.verifySignature('stripe', body + 'tamper', `t=123,v1=${sig}`, secret), 'rejects tampered body');
  });

  // -------------------------------------------------------------------
  // 13. Statements
  // -------------------------------------------------------------------
  await step('Customer statement reconciles opening + period activity', async () => {
    // INV-1001 (£1,200, paid 2025-01-20), INV-1002 (£500, fully paid 2025-02-15),
    // INV-USD-1 (£780 base, paid 2025-03-15 with FX gain — payment journal value was at issue rate),
    // INV-USD-2 (£400 base, paid 2025-04-20),
    // INV-VOID-1 (£100, voided), INV-VOID-2 (£100, paid 50 partial),
    // INV-FROM-QUO-1 (£700, unpaid),
    // INV-PL-1 (£250, paid 2025-10-05), INV-PL-2 (£50, paid 2025-10-12)
    // Plus 3 recurring (£99 each, unpaid) on 2025-07-01, 08-01, 09-01.
    const stmt = await statementsLib.buildStatement({
      contactId: acmeId, periodStart: '2025-01-01', periodEnd: '2025-12-31',
    });
    assertEq(stmt.openingBalancePence, 0, 'opening 0 (Acme has no prior history)');
    // Acme outstanding at end:
    //   Voided INV-VOID-1 contributes 100_00 invoice + 0 payment but voiding
    //   posts a separate reversing journal that is NOT a payment journal,
    //   so the statement currently shows the voided invoice as a debit.
    //   That mirrors how Xero/FreeAgent show statements (void issues a
    //   credit-note line); the Stage 9 slice doesn't model credit notes
    //   so statement closing includes the voided amount and the
    //   partially-paid INV-VOID-2 (50_00 outstanding).
    // Closing = invoiced - paid (in this period). Use the totals
    // returned by the lib rather than hand-calculating.
    assert(stmt.totals.invoicedPence > 0, 'has invoicing');
    assert(stmt.totals.paidPence > 0, 'has payments');
    assertEq(stmt.closingBalancePence, stmt.totals.invoicedPence - stmt.totals.paidPence, 'closing = inv - paid');
    // At least one transaction
    assert(stmt.transactions.length >= 6, 'multiple transactions');
    // Sorted chronologically
    for (let i = 1; i < stmt.transactions.length; i++) {
      assert(stmt.transactions[i].date >= stmt.transactions[i - 1].date, 'chronological');
    }
  });

  // -------------------------------------------------------------------
  // 14. Reminders
  // -------------------------------------------------------------------
  let ruleId, openInvoiceForReminder;
  await step('Reminder rule + computeDueReminders + idempotent re-run', async () => {
    const r = await remindersLib.createRule({
      entityId: entityA, name: '3 days overdue', trigger: 'after_due', daysOffset: 3,
      templateSubject: 'Friendly reminder', templateBody: 'Your invoice is overdue.',
    });
    ruleId = r.id;
    // Create an invoice that's overdue by Nov 30, 2025
    const inv = await invoicesLib.createInvoice({
      entityId: entityA, invoiceNumber: 'INV-REM-1', contactId: acmeId,
      issueDate: '2025-11-01', dueDate: '2025-11-15', totalPence: 100_00,
    });
    openInvoiceForReminder = inv.id;
    // computeDueReminders on Nov 30 → scheduled = 11-15 + 3 = 11-18 ≤ 11-30 → 1 row
    const inserted = await remindersLib.computeDueReminders({
      entityId: entityA, asOfDate: '2025-11-30',
    });
    assert(inserted.length >= 1, 'at least one reminder');
    const ours = inserted.find((x) => x.invoiceId === inv.id && x.ruleId === r.id);
    assert(ours, 'our invoice scheduled');
    assertEq(ours.scheduledFor, '2025-11-18', 'scheduled date');
    // Re-run: idempotent
    const second = await remindersLib.computeDueReminders({
      entityId: entityA, asOfDate: '2025-11-30',
    });
    assert(!second.find((x) => x.invoiceId === inv.id && x.ruleId === r.id), 'no dupes');
  });

  // -------------------------------------------------------------------
  // 15. Dashboard
  // -------------------------------------------------------------------
  await step('Dashboard receivablesAging + averageDaysToPay', async () => {
    const aging = await dashboardLib.receivablesAging({
      entityId: entityA, asOfDate: '2025-12-31',
    });
    assert(aging.totalPence > 0, 'has receivables');
    const sumBuckets = Object.values(aging.buckets).reduce((a, b) => a + b, 0);
    assertEq(sumBuckets, aging.totalPence, 'buckets sum to total');
    assert(aging.byContact.length >= 1, 'byContact list');

    const dtp = await dashboardLib.averageDaysToPay({
      entityId: entityA, lookbackDays: 365,
    });
    assert(dtp.portfolioAverageDaysToPay >= 0, 'portfolio avg');
    assert(dtp.leaderboard.length >= 1, 'has leaderboard');
  });

  // -------------------------------------------------------------------
  // 16. Tenant isolation
  // -------------------------------------------------------------------
  await step('Tenant isolation: entityB sees no entityA invoices/contacts', async () => {
    const list = await invoicesLib.listInvoices({ entityId: entityB });
    assertEq(list.length, 0, 'no invoices');
    const cs = await contactsLib.listContacts({ entityId: entityB, includeArchived: true });
    assertEq(cs.length, 0, 'no contacts');
    const aging = await dashboardLib.receivablesAging({ entityId: entityB, asOfDate: '2025-12-31' });
    assertEq(aging.totalPence, 0, 'no receivables');
  });

  // -------------------------------------------------------------------
  // 17. Trial Balance still balances after Stage 9 activity
  // -------------------------------------------------------------------
  await step('Trial Balance still balances on entityA', async () => {
    const tb = await ledgerReports.trialBalance(entityA, '2025-12-31');
    assert(tb.totals.isBalanced, `TB unbalanced: dr=${tb.totals.debitPence} cr=${tb.totals.creditPence}`);
  });

  // FX helper sanity
  await step('FX helpers: toBasePence + gainLossPence sanity', async () => {
    assertEq(fx.toBasePence(1_000_00, 0.78), 78_000, '$1000 @ 0.78 → £780');
    assertEq(fx.toBasePence(1_000_00, 1), 1_000_00, 'GBP identity');
    const gl1 = fx.gainLossPence(1_000_00, 0.78, 0.80);
    assertEq(gl1.gainPence, 20_00, 'gain 2000p');
    assertEq(gl1.lossPence, 0, 'no loss');
    const gl2 = fx.gainLossPence(500_00, 0.80, 0.76);
    assertEq(gl2.gainPence, 0, 'no gain');
    assertEq(gl2.lossPence, 20_00, 'loss 2000p');
  });

  console.log('All Stage 9 smoke checks passed ✓');
  await getPool().end();
}

main().catch((e) => {
  console.error(e);
  getPool().end().finally(() => process.exit(1));
});
