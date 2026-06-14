/**
 * Stage 9 — Quotes (proposals that convert to invoices).
 *
 * Lifecycle:
 *   draft → sent → accepted → converted
 *               ↘ declined / expired
 *
 * Acceptance flow supports two paths:
 *   1. Authenticated admin/staff user: `acceptQuote({ id, actor })`.
 *   2. Public magic-link: `acceptQuote({ token })` — looks the quote
 *      up by `accept_token_hash`, no actor required. The token is
 *      burned on accept (single-use).
 *
 * Conversion (`convertToInvoice`) issues a real invoice via
 * `createInvoice`, links both rows together, flips the quote's
 * status to `converted`. The original quote_number is preserved as
 * provenance — Xero, FreeAgent and Sage all behave this way.
 */

const cryptoNode = require('crypto');
const { and, eq } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { audit } = require('../audit-log');
const { createInvoice } = require('./invoices');

function newQuoteId() {
  return `quo_${cryptoNode.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
function newToken() {
  return cryptoNode.randomBytes(24).toString('base64url');
}
function hashToken(token) {
  return cryptoNode.createHash('sha256').update(token).digest('hex');
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

async function createQuote(input, opts = {}) {
  const {
    entityId,
    contactId,
    quoteNumber,
    issueDate,
    expiryDate,
    currency = 'GBP',
    fxRateToBase = 1,
    totalPence,
    lineItems = [],
    notes,
    actor,
  } = input;
  if (!entityId) throw new Error('createQuote: entityId required');
  if (!quoteNumber) throw new Error('createQuote: quoteNumber required');
  if (!Number.isInteger(totalPence) || totalPence <= 0) {
    throw new Error('createQuote: totalPence must be positive integer pence');
  }
  const issue = toDateString(issueDate);
  const expiry = expiryDate ? toDateString(expiryDate) : null;
  const id = newQuoteId();
  const token = newToken();

  const db = opts.tx || getDb();
  const { quotes } = getSchema();
  await db.insert(quotes).values({
    id,
    entityId,
    contactId: contactId || null,
    quoteNumber,
    status: 'sent',
    issueDate: issue,
    expiryDate: expiry,
    currency,
    fxRateToBase: String(fxRateToBase),
    totalPence,
    lineItems,
    notes: notes || null,
    acceptTokenHash: hashToken(token),
    createdBy: actor?.userId || null,
  });
  await audit(
    {
      action: 'quote.create',
      actorUserId: actor?.userId,
      actorRole: actor?.role,
      resourceType: 'quote',
      resourceId: id,
      entityId,
      after: { quoteNumber, contactId, currency, totalPence, expiryDate: expiry },
    },
    { tx: opts.tx }
  );
  return { id, token };
}

async function acceptQuote(input, opts = {}) {
  const { id, token, actor } = input;
  if (!id && !token) throw new Error('acceptQuote: id or token required');
  const db = opts.tx || getDb();
  const { quotes } = getSchema();
  let row;
  if (token) {
    const h = hashToken(token);
    const rs = await db.select().from(quotes).where(eq(quotes.acceptTokenHash, h)).limit(1);
    row = rs[0];
    if (!row) throw new Error('acceptQuote: invalid or expired token');
  } else {
    const rs = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
    row = rs[0];
    if (!row) throw new Error(`acceptQuote: ${id} not found`);
  }
  if (row.status === 'accepted' || row.status === 'converted') {
    return { id: row.id, alreadyAccepted: true, status: row.status };
  }
  if (row.status === 'declined' || row.status === 'expired') {
    throw new Error(`acceptQuote: status is ${row.status}`);
  }
  if (row.expiryDate && row.expiryDate < toDateString(new Date())) {
    await db
      .update(quotes)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(quotes.id, row.id));
    throw new Error('acceptQuote: quote has expired');
  }
  await db
    .update(quotes)
    .set({
      status: 'accepted',
      acceptedAt: new Date(),
      acceptTokenHash: null, // burn the token
      updatedAt: new Date(),
    })
    .where(eq(quotes.id, row.id));
  await audit(
    {
      action: 'quote.accept',
      actorUserId: actor?.userId,
      actorRole: actor?.role || (token ? 'public_link' : null),
      resourceType: 'quote',
      resourceId: row.id,
      entityId: row.entityId,
      after: { status: 'accepted', viaToken: !!token },
    },
    { tx: opts.tx }
  );
  return { id: row.id, status: 'accepted' };
}

async function declineQuote({ id, actor }, opts = {}) {
  const db = opts.tx || getDb();
  const { quotes } = getSchema();
  await db
    .update(quotes)
    .set({ status: 'declined', acceptTokenHash: null, updatedAt: new Date() })
    .where(eq(quotes.id, id));
  await audit(
    {
      action: 'quote.decline',
      actorUserId: actor?.userId,
      resourceType: 'quote',
      resourceId: id,
      after: { status: 'declined' },
    },
    { tx: opts.tx }
  );
}

/**
 * Convert an accepted quote into an invoice. Quote must be in
 * `accepted` status. Returns the new invoice id.
 */
async function convertToInvoice(input, opts = {}) {
  const { id, invoiceNumber, issueDate, paymentTermsDays = 30, actor } = input;
  if (!id) throw new Error('convertToInvoice: id required');
  if (!invoiceNumber) throw new Error('convertToInvoice: invoiceNumber required');

  const runner = opts.tx ? (cb) => cb(opts.tx) : (cb) => getDb().transaction(cb);
  return runner(async (tx) => {
    const { quotes } = getSchema();
    const rows = await tx.select().from(quotes).where(eq(quotes.id, id)).limit(1);
    const q = rows[0];
    if (!q) throw new Error(`convertToInvoice: ${id} not found`);
    if (q.status !== 'accepted') {
      throw new Error(`convertToInvoice: quote status is ${q.status}, must be accepted`);
    }

    const inv = await createInvoice(
      {
        entityId: q.entityId,
        invoiceNumber,
        contactId: q.contactId,
        issueDate: issueDate || new Date(),
        paymentTermsDays,
        currency: q.currency,
        fxRateToBase: q.fxRateToBase,
        totalPence: Number(q.totalPence),
        lineItems: q.lineItems,
        notes: `Converted from quote ${q.quoteNumber}`,
        quoteId: q.id,
        actor,
      },
      { tx }
    );

    await tx
      .update(quotes)
      .set({
        status: 'converted',
        convertedInvoiceId: inv.id,
        updatedAt: new Date(),
      })
      .where(eq(quotes.id, id));

    await audit(
      {
        action: 'quote.convert',
        actorUserId: actor?.userId,
        actorRole: actor?.role,
        resourceType: 'quote',
        resourceId: id,
        entityId: q.entityId,
        after: { invoiceId: inv.id, invoiceNumber },
      },
      { tx }
    );

    return { quoteId: id, invoiceId: inv.id };
  });
}

async function getQuote(id, opts = {}) {
  const db = opts.tx || getDb();
  const { quotes } = getSchema();
  const rows = await db.select().from(quotes).where(eq(quotes.id, id)).limit(1);
  return rows[0] || null;
}

module.exports = {
  createQuote,
  acceptQuote,
  declineQuote,
  convertToInvoice,
  getQuote,
  hashToken,
};
