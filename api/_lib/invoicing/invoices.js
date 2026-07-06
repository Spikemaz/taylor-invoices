/**
 * Stage 9 — Invoices (the new canonical record).
 *
 * Stages 1–8 stored invoice data exclusively as ledger journals tagged
 * `source = 'invoice'`. That worked but didn't carry the rich metadata
 * Stage 9 needs: contact link, due date, line items, FX rate, payment
 * status, recurring/quote provenance, notes.
 *
 * `createInvoice` is the new front door. It:
 *   1. Inserts an `invoices` row in the requested currency.
 *   2. Posts a `postSale` journal in BASE currency (GBP) using the
 *      captured fxRateToBase.
 *   3. Wires `invoices.journalId` to the journal id so reports can
 *      drill down either direction.
 *
 * `markPaid` settles all or part of an invoice. Multi-currency: if
 * the issue and settlement FX rates differ, an additional journal
 * posts the realised gain/loss against Other Income (4100) or Sundry
 * Expenses (8100). The base ledger movement (DR Bank, CR Trade
 * Debtors) always uses the ORIGINAL issue rate — that way the
 * receivable ledger account zeroes out cleanly once the invoice is
 * fully paid.
 *
 * `voidInvoice` reverses the original sale journal via
 * `postManualJournal` and flips status. We don't physically delete the
 * row so the audit trail is preserved.
 */

const cryptoNode = require('crypto');
const { and, eq, sql } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { audit } = require('../audit-log');
const { postSale, postPaymentReceived, postJournal } = require('../ledger/posting');
const { getAccountByCode } = require('../ledger/accounts');
const { toBasePence, gainLossPence, parseRate } = require('./fx');

function newInvoiceId() {
  return `inv_${cryptoNode.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function toDateString(d) {
  if (!d) throw new Error('date required');
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  throw new Error(`Invalid date: ${d}`);
}

function addDaysISO(dateStr, days) {
  const d = new Date(`${toDateString(dateStr)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Create an invoice + post the sale journal in one transaction.
 *
 * @param {object} input
 * @param {string} input.entityId
 * @param {string} input.invoiceNumber
 * @param {string} [input.contactId]
 * @param {string|Date} input.issueDate
 * @param {string|Date} [input.dueDate]      defaults to issueDate + paymentTermsDays
 * @param {number}   [input.paymentTermsDays=30]
 * @param {string}   [input.currency='GBP']
 * @param {number|string} [input.fxRateToBase=1]
 * @param {number}   input.totalPence       integer pence in invoice currency
 * @param {number}   [input.subtotalPence]  defaults to totalPence
 * @param {Array}    [input.lineItems=[]]
 * @param {string}   [input.salesCode='4000']
 * @param {string}   [input.debtorsCode='1100']
 * @param {string}   [input.notes]
 * @param {string}   [input.quoteId]
 * @param {string}   [input.recurringId]
 * @param {object}   [input.actor]
 *
 * @param {object} [opts]
 * @param {object} [opts.tx] outer transaction handle
 *
 * @returns {Promise<{ id, journalId, totalBasePence }>}
 */
async function createInvoice(input, opts = {}) {
  const {
    entityId,
    invoiceNumber,
    contactId,
    issueDate,
    paymentTermsDays = 30,
    currency = 'GBP',
    fxRateToBase = 1,
    totalPence,
    subtotalPence,
    lineItems = [],
    salesCode = '4000',
    debtorsCode = '1100',
    notes,
    quoteId,
    recurringId,
    actor,
    customerName,
  } = input;
  if (!entityId) throw new Error('createInvoice: entityId required');
  if (!invoiceNumber) throw new Error('createInvoice: invoiceNumber required');
  if (!Number.isInteger(totalPence) || totalPence <= 0) {
    throw new Error('createInvoice: totalPence must be positive integer pence');
  }
  if (subtotalPence !== undefined && (!Number.isInteger(subtotalPence) || subtotalPence < 0)) {
    throw new Error('createInvoice: subtotalPence must be non-negative integer pence');
  }
  parseRate(fxRateToBase); // validates
  const issue = toDateString(issueDate);
  const due = input.dueDate ? toDateString(input.dueDate) : addDaysISO(issue, paymentTermsDays);

  const totalBasePence = toBasePence(totalPence, fxRateToBase);
  const id = newInvoiceId();

  const runner = opts.tx ? (cb) => cb(opts.tx) : (cb) => getDb().transaction(cb);
  const result = await runner(async (tx) => {
    const { invoices } = getSchema();
    await tx.insert(invoices).values({
      id,
      entityId,
      contactId: contactId || null,
      invoiceNumber,
      status: 'sent',
      issueDate: issue,
      dueDate: due,
      currency,
      fxRateToBase: String(fxRateToBase),
      subtotalPence: subtotalPence ?? totalPence,
      totalPence,
      totalBasePence,
      paidPence: 0,
      lineItems: lineItems,
      notes: notes || null,
      quoteId: quoteId || null,
      recurringId: recurringId || null,
      sentAt: new Date(),
      createdBy: actor?.userId || null,
    });

    // Resolve customer label for journal memo: explicit override wins,
    // else look up the contact name, else fall back to invoice number.
    let memoName = customerName;
    if (!memoName && contactId) {
      const { contacts } = getSchema();
      const r = await tx.select({ name: contacts.name }).from(contacts).where(eq(contacts.id, contactId)).limit(1);
      memoName = r[0]?.name;
    }

    const sale = await postSale(
      {
        entityId,
        date: issue,
        amountPence: totalBasePence,
        invoiceId: id,
        customerName: memoName || invoiceNumber,
        description: `Invoice ${invoiceNumber}${memoName ? ' — ' + memoName : ''}${currency !== 'GBP' ? ` (${currency} ${(totalPence / 100).toFixed(2)} @ ${fxRateToBase})` : ''}`,
        salesCode,
        debtorsCode,
        currency: 'GBP', // ledger always GBP
        createdBy: actor?.userId,
      },
      { tx, actor }
    );

    await tx.update(invoices).set({ journalId: sale.id }).where(eq(invoices.id, id));

    await audit(
      {
        action: 'invoice.create',
        actorUserId: actor?.userId,
        actorEmail: actor?.email,
        actorRole: actor?.role,
        resourceType: 'invoice',
        resourceId: id,
        entityId,
        after: {
          invoiceNumber,
          contactId: contactId || null,
          currency,
          fxRateToBase: String(fxRateToBase),
          totalPence,
          totalBasePence,
          journalId: sale.id,
          quoteId: quoteId || null,
          recurringId: recurringId || null,
        },
      },
      { tx }
    );

    return { id, journalId: sale.id, totalBasePence };
  });

  return result;
}

/**
 * Mark an invoice paid (full or partial). Posts the bank/debtor
 * payment journal and, if the FX rate at settlement differs from
 * issue rate, an additional gain/loss journal.
 *
 * @param {object} input
 * @param {string} input.invoiceId
 * @param {string|Date} input.paidDate
 * @param {number} input.amountPence       in invoice currency
 * @param {number|string} [input.settleFxRateToBase] defaults to invoice's issue rate (no FX P&L)
 * @param {string} [input.bankCode='0800']
 * @param {string} [input.debtorsCode='1100']
 * @param {object} [input.actor]
 */
async function markPaid(input, opts = {}) {
  const {
    invoiceId,
    paidDate,
    amountPence,
    bankCode = '0800',
    debtorsCode = '1100',
    actor,
  } = input;
  if (!invoiceId) throw new Error('markPaid: invoiceId required');
  if (!Number.isInteger(amountPence) || amountPence <= 0) {
    throw new Error('markPaid: amountPence must be positive integer pence');
  }
  const dateStr = toDateString(paidDate);

  const runner = opts.tx ? (cb) => cb(opts.tx) : (cb) => getDb().transaction(cb);
  return runner(async (tx) => {
    const { invoices } = getSchema();
    const rows = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    const inv = rows[0];
    if (!inv) throw new Error(`markPaid: invoice ${invoiceId} not found`);
    if (inv.status === 'void') throw new Error('markPaid: invoice is void');
    if (inv.status === 'paid') throw new Error('markPaid: invoice already fully paid');

    const newPaid = Number(inv.paidPence) + amountPence;
    if (newPaid > Number(inv.totalPence)) {
      throw new Error(
        `markPaid: overpayment — invoice total ${inv.totalPence}p, would settle ${newPaid}p`
      );
    }
    const fullySettled = newPaid === Number(inv.totalPence);

    // Cash leg in GBP, valued at ORIGINAL issue rate so the trade
    // debtors ledger zeroes when fully paid. FX gain/loss is booked
    // separately below.
    const issueRate = inv.fxRateToBase;
    const baseAmountAtIssue = toBasePence(amountPence, issueRate);

    const { id: paymentJournalId } = await postPaymentReceived(
      {
        entityId: inv.entityId,
        date: dateStr,
        amountPence: baseAmountAtIssue,
        invoiceId,
        customerName: inv.contactId || inv.invoiceNumber,
        description: `Payment for invoice ${inv.invoiceNumber}${inv.currency !== 'GBP' ? ` (${inv.currency} ${(amountPence / 100).toFixed(2)})` : ''}`,
        bankCode,
        debtorsCode,
        currency: 'GBP',
        createdBy: actor?.userId,
      },
      { tx, actor }
    );

    // Multi-currency settlement: if the spot rate has moved, post a
    // realised FX gain/loss. We post a manual journal because postSale
    // is constrained to invoice/sale shape.
    let fxJournalId = null;
    const settleRate = input.settleFxRateToBase;
    if (settleRate !== undefined && String(settleRate) !== String(issueRate)) {
      const { gainPence, lossPence } = gainLossPence(amountPence, issueRate, settleRate);
      if (gainPence > 0 || lossPence > 0) {
        // GAIN: settled GBP > booked GBP → bank gets the extra; cancel
        //       the over-receipt with CR Other Income (4100).
        // We have already posted DR Bank @ issue-rate. The settlement
        // bank deposit was actually larger by `gainPence`. Post a
        // top-up: DR Bank, CR Other Income.
        // LOSS: opposite — CR Bank, DR Sundry Expenses (8100).
        const bank = await getAccountByCode(inv.entityId, bankCode, { tx });
        const fxAccount = await getAccountByCode(inv.entityId, gainPence > 0 ? '4100' : '8100', { tx });
        const lines = gainPence > 0
          ? [
              { accountId: bank.id, debit: gainPence, credit: 0, memo: 'FX gain on settlement' },
              { accountId: fxAccount.id, debit: 0, credit: gainPence, memo: 'FX gain on settlement' },
            ]
          : [
              { accountId: fxAccount.id, debit: lossPence, credit: 0, memo: 'FX loss on settlement' },
              { accountId: bank.id, debit: 0, credit: lossPence, memo: 'FX loss on settlement' },
            ];
        const fx = await postJournal(
          {
            entityId: inv.entityId,
            date: dateStr,
            description: `FX ${gainPence > 0 ? 'gain' : 'loss'} on invoice ${inv.invoiceNumber}`,
            source: 'manual',
            sourceType: 'fx_settlement',
            sourceId: invoiceId,
            createdBy: actor?.userId,
            lines,
          },
          { tx, actor }
        );
        fxJournalId = fx.id;
      }
    }

    await tx
      .update(invoices)
      .set({
        paidPence: newPaid,
        status: fullySettled ? 'paid' : 'partially_paid',
        paidAt: fullySettled ? new Date(`${dateStr}T00:00:00Z`) : inv.paidAt,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoiceId));

    await audit(
      {
        action: 'invoice.payment',
        actorUserId: actor?.userId,
        actorEmail: actor?.email,
        actorRole: actor?.role,
        resourceType: 'invoice',
        resourceId: invoiceId,
        entityId: inv.entityId,
        after: {
          paidPence: newPaid,
          fullySettled,
          paymentJournalId,
          fxJournalId,
        },
      },
      { tx }
    );

    return {
      id: invoiceId,
      paidPence: newPaid,
      fullySettled,
      paymentJournalId,
      fxJournalId,
    };
  });
}

/**
 * Void an invoice: post a reversing journal and flip status. The
 * original journal is preserved in the ledger for audit.
 */
async function voidInvoice({ invoiceId, voidDate, reason, actor }, opts = {}) {
  if (!invoiceId) throw new Error('voidInvoice: invoiceId required');
  const dateStr = toDateString(voidDate || new Date());
  const runner = opts.tx ? (cb) => cb(opts.tx) : (cb) => getDb().transaction(cb);
  return runner(async (tx) => {
    const { invoices } = getSchema();
    const rows = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
    const inv = rows[0];
    if (!inv) throw new Error(`voidInvoice: ${invoiceId} not found`);
    if (inv.status === 'void') return { id: invoiceId, alreadyVoid: true };
    if (Number(inv.paidPence) > 0) {
      throw new Error('voidInvoice: cannot void a partially-paid invoice; refund first');
    }

    // Reverse: CR Trade Debtors, DR Sales (the inverse of postSale).
    const sales = await getAccountByCode(inv.entityId, '4000', { tx });
    const debtors = await getAccountByCode(inv.entityId, '1100', { tx });
    const reverse = await postJournal(
      {
        entityId: inv.entityId,
        date: dateStr,
        description: `Void invoice ${inv.invoiceNumber}${reason ? ': ' + reason : ''}`,
        source: 'manual',
        sourceType: 'invoice_void',
        sourceId: invoiceId,
        reversesId: inv.journalId || null,
        createdBy: actor?.userId,
        lines: [
          { accountId: sales.id, debit: Number(inv.totalBasePence), credit: 0, memo: 'Void' },
          { accountId: debtors.id, debit: 0, credit: Number(inv.totalBasePence), memo: 'Void' },
        ],
      },
      { tx, actor }
    );

    await tx
      .update(invoices)
      .set({ status: 'void', voidedAt: new Date(), updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId));

    await audit(
      {
        action: 'invoice.void',
        actorUserId: actor?.userId,
        actorRole: actor?.role,
        resourceType: 'invoice',
        resourceId: invoiceId,
        entityId: inv.entityId,
        after: { reverseJournalId: reverse.id, reason: reason || null },
      },
      { tx }
    );

    return { id: invoiceId, reverseJournalId: reverse.id };
  });
}

async function getInvoice(id, opts = {}) {
  const db = opts.tx || getDb();
  const { invoices } = getSchema();
  const rows = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  return rows[0] || null;
}

async function listInvoices({ entityId, contactId, status }, opts = {}) {
  const db = opts.tx || getDb();
  const { invoices } = getSchema();
  const conds = [eq(invoices.entityId, entityId)];
  if (contactId) conds.push(eq(invoices.contactId, contactId));
  if (status) conds.push(eq(invoices.status, status));
  return db
    .select()
    .from(invoices)
    .where(conds.length > 1 ? and(...conds) : conds[0]);
}

module.exports = {
  createInvoice,
  markPaid,
  voidInvoice,
  getInvoice,
  listInvoices,
  addDaysISO,
};
