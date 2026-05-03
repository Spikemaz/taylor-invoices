/**
 * Stage 9 — Customer statements.
 *
 * `buildStatement({ contactId, periodStart, periodEnd })` returns a
 * structured running balance for one customer:
 *
 *   {
 *     contact, periodStart, periodEnd,
 *     openingBalancePence,        // owed at periodStart-1
 *     transactions: [             // chronological
 *       { date, kind, ref, debitPence, creditPence, runningBalancePence },
 *       ...
 *     ],
 *     closingBalancePence,
 *     totals: { invoicedPence, paidPence, outstandingPence },
 *   }
 *
 * Source of truth is the ledger: we walk this contact's invoices and
 * payment journals (linked via `journals.sourceId`) and bucket them
 * by date. All amounts are GBP base pence — multi-currency display
 * is left to the renderer using the invoice row's original currency.
 */

const { and, eq, gte, lte, inArray } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');

function toDateString(d) {
  if (!d) throw new Error('date required');
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  throw new Error(`Invalid date: ${d}`);
}

async function buildStatement(input, opts = {}) {
  const { contactId, periodStart, periodEnd } = input;
  if (!contactId) throw new Error('buildStatement: contactId required');
  const start = toDateString(periodStart);
  const end = toDateString(periodEnd);
  if (end < start) throw new Error('buildStatement: periodEnd before periodStart');

  const db = opts.tx || getDb();
  const { contacts, invoices, journals } = getSchema();

  const contactRows = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
  const contact = contactRows[0];
  if (!contact) throw new Error(`buildStatement: contact ${contactId} not found`);

  // Pull every invoice for this contact (irrespective of date so the
  // opening balance is computed correctly).
  const invs = await db
    .select()
    .from(invoices)
    .where(eq(invoices.contactId, contactId));

  if (invs.length === 0) {
    return {
      contact,
      periodStart: start,
      periodEnd: end,
      openingBalancePence: 0,
      transactions: [],
      closingBalancePence: 0,
      totals: { invoicedPence: 0, paidPence: 0, outstandingPence: 0 },
    };
  }

  const invoiceIds = invs.map((i) => i.id);

  // Pull every payment journal for these invoices (sourceId IN ...,
  // sourceType = 'invoice_payment' OR source = 'invoice_payment').
  const paymentJournals = await db
    .select()
    .from(journals)
    .where(
      and(
        eq(journals.entityId, contact.entityId),
        inArray(journals.sourceId, invoiceIds),
        eq(journals.source, 'invoice_payment')
      )
    );

  // Pull void reversal journals so voided invoices appear as a credit
  // cancelling the original debt instead of being silently dropped.
  const voidJournals = await db
    .select()
    .from(journals)
    .where(
      and(
        eq(journals.entityId, contact.entityId),
        inArray(journals.sourceId, invoiceIds),
        eq(journals.sourceType, 'invoice_void')
      )
    );
  const invById = new Map(invs.map((i) => [i.id, i]));

  // Build a flat list of statement lines from invoices + payments.
  const events = [];
  for (const inv of invs) {
    events.push({
      date: inv.issueDate,
      kind: 'invoice',
      ref: inv.invoiceNumber,
      debitPence: Number(inv.totalBasePence),
      creditPence: 0,
      sortKey: `${inv.issueDate}-1-${inv.id}`,
    });
  }
  for (const j of voidJournals) {
    const inv = invById.get(j.sourceId);
    if (!inv) continue;
    events.push({
      date: j.date,
      kind: 'void',
      ref: `VOID ${inv.invoiceNumber}`,
      debitPence: 0,
      creditPence: Number(inv.totalBasePence),
      sortKey: `${j.date}-3-${j.id}`,
    });
  }
  for (const j of paymentJournals) {
    // Payment journals' "amount" is the sum of debit lines on the bank
    // side. We don't need to query journal_lines: the journal row
    // doesn't store the amount, but the source links to an invoice
    // and the corresponding receipt amount is encoded by what we
    // posted via postPaymentReceived. To stay accurate we read the
    // journal_lines for these payment journals.
    events.push({
      date: j.date,
      kind: 'payment',
      ref: j.id,
      journalId: j.id,
      sortKey: `${j.date}-2-${j.id}`,
    });
  }

  // Resolve payment amounts from journal_lines (debit on bank account
  // = receipt amount). One query for all payment journals.
  if (paymentJournals.length > 0) {
    const { journalLines } = getSchema();
    const lines = await db
      .select()
      .from(journalLines)
      .where(inArray(journalLines.journalId, paymentJournals.map((j) => j.id)));
    const byJournal = new Map();
    for (const l of lines) {
      const tot = byJournal.get(l.journalId) || 0;
      byJournal.set(l.journalId, tot + Number(l.debitPence));
    }
    for (const e of events) {
      if (e.kind === 'payment') {
        const amt = byJournal.get(e.journalId) || 0;
        e.debitPence = 0;
        e.creditPence = amt;
      }
    }
  }

  events.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  // Walk events: anything before periodStart contributes to opening;
  // events in [start..end] populate the running list.
  let opening = 0;
  let running = 0;
  const transactions = [];
  let invoicedInPeriod = 0;
  let paidInPeriod = 0;

  for (const e of events) {
    if (e.date < start) {
      opening += (e.debitPence || 0) - (e.creditPence || 0);
      running = opening;
      continue;
    }
    if (e.date > end) continue;
    running += (e.debitPence || 0) - (e.creditPence || 0);
    transactions.push({
      date: e.date,
      kind: e.kind,
      ref: e.ref,
      debitPence: e.debitPence || 0,
      creditPence: e.creditPence || 0,
      runningBalancePence: running,
    });
    if (e.kind === 'invoice') invoicedInPeriod += e.debitPence || 0;
    if (e.kind === 'payment') paidInPeriod += e.creditPence || 0;
    if (e.kind === 'void') paidInPeriod += e.creditPence || 0;
  }

  return {
    contact,
    periodStart: start,
    periodEnd: end,
    openingBalancePence: opening,
    transactions,
    closingBalancePence: running,
    totals: {
      invoicedPence: invoicedInPeriod,
      paidPence: paidInPeriod,
      outstandingPence: running,
    },
  };
}

module.exports = { buildStatement };
