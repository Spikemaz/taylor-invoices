/**
 * Stage 9 — Payment links (Stripe + GoCardless).
 *
 * This slice ships the data plane only:
 *
 *   recordIntent({ invoiceId, provider, providerRef, amountPence })
 *     — the UI/SDK creates the checkout session / mandate, then calls
 *       us with the provider id so we can correlate webhook events.
 *
 *   processWebhookEvent({ provider, eventId, eventType, providerRef,
 *                          status, paidAt, payload })
 *     — idempotent on (provider, eventId). On the first `succeeded`
 *       event we mark the invoice paid and post the bank journal.
 *       Subsequent events for the same id are ignored.
 *
 *   verifySignature(provider, payload, signature, secret)
 *     — signature verification stub. Stripe + GoCardless both sign
 *       with HMAC-SHA256; the helper computes the expected value and
 *       constant-time compares. The actual webhook HTTP endpoint
 *       (incl. raw-body capture, secret rotation, replay protection)
 *       is a follow-up — we deliberately do NOT bring in the Stripe /
 *       GoCardless SDKs in this slice.
 */

const cryptoNode = require('crypto');
const { and, eq } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { audit } = require('../audit-log');
const { markPaid } = require('./invoices');

function newPaymentLinkId() {
  return `pml_${cryptoNode.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
function newPaymentLinkEventId() {
  return `ple_${cryptoNode.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

const PROVIDERS = new Set(['stripe', 'gocardless']);

async function recordIntent(input, opts = {}) {
  const { invoiceId, provider, providerRef, amountPence, currency = 'GBP', actor } = input;
  if (!invoiceId) throw new Error('recordIntent: invoiceId required');
  if (!PROVIDERS.has(provider)) throw new Error(`recordIntent: bad provider ${provider}`);
  if (!providerRef) throw new Error('recordIntent: providerRef required');
  if (!Number.isInteger(amountPence) || amountPence <= 0) {
    throw new Error('recordIntent: amountPence must be positive integer pence');
  }
  const db = opts.tx || getDb();
  const { paymentLinks } = getSchema();
  // Upsert by (provider, providerRef) so re-issuing the same link is
  // idempotent. We try the insert first and fall back to a read on
  // unique-violation so concurrent intent calls cannot both succeed
  // and produce duplicate rows.
  const id = newPaymentLinkId();
  try {
    await db.insert(paymentLinks).values({
      id,
      invoiceId,
      provider,
      providerRef,
      status: 'pending',
      amountPence,
      currency,
    });
  } catch (e) {
    const code = e?.code || e?.cause?.code;
    const msg = e?.message || e?.cause?.message || '';
    if (code === '23505' || /unique/i.test(msg)) {
      const existing = await db
        .select()
        .from(paymentLinks)
        .where(and(eq(paymentLinks.provider, provider), eq(paymentLinks.providerRef, providerRef)))
        .limit(1);
      if (existing[0]) return { id: existing[0].id, reused: true };
    }
    throw e;
  }
  await audit(
    {
      action: 'payment_link.intent',
      actorUserId: actor?.userId,
      resourceType: 'payment_link',
      resourceId: id,
      after: { invoiceId, provider, amountPence, currency },
    },
    { tx: opts.tx }
  );
  return { id, reused: false };
}

/**
 * Process a webhook event. Idempotent on (provider, eventId) — re-
 * delivery of the same event is a no-op. On `succeeded` events we
 * settle the invoice via markPaid in the same transaction.
 */
async function processWebhookEvent(input, opts = {}) {
  const {
    provider,
    eventId,
    eventType,
    providerRef,
    status, // 'succeeded' | 'failed' | 'refunded' | 'cancelled' | 'processing'
    paidAt,
    amountPence,
    settleFxRateToBase,
    payload = {},
    actor,
  } = input;
  if (!PROVIDERS.has(provider)) throw new Error(`processWebhookEvent: bad provider ${provider}`);
  if (!eventId) throw new Error('processWebhookEvent: eventId required');
  if (!providerRef) throw new Error('processWebhookEvent: providerRef required');
  if (!eventType) throw new Error('processWebhookEvent: eventType required');

  const runner = opts.tx ? (cb) => cb(opts.tx) : (cb) => getDb().transaction(cb);
  return runner(async (tx) => {
    const { paymentLinks, paymentLinkEvents } = getSchema();

    const links = await tx
      .select()
      .from(paymentLinks)
      .where(and(eq(paymentLinks.provider, provider), eq(paymentLinks.providerRef, providerRef)))
      .limit(1);
    const link = links[0];
    if (!link) throw new Error(`processWebhookEvent: no payment link for ${provider}/${providerRef}`);

    // Idempotency: rely on the (provider,event_id) unique index. Insert
    // first; on duplicate-key, treat as a no-op redelivery. This is
    // race-safe under concurrent webhook delivery.
    try {
      await tx.insert(paymentLinkEvents).values({
        id: newPaymentLinkEventId(),
        paymentLinkId: link.id,
        provider,
        eventId,
        eventType,
        payload,
      });
    } catch (e) {
      const code = e?.code || e?.cause?.code;
      const msg = e?.message || e?.cause?.message || '';
      if (code === '23505' || /unique/i.test(msg)) {
        return { duplicate: true, eventId };
      }
      throw e;
    }

    let paymentJournalId = link.paymentJournalId;
    let newStatus = status || link.status;

    if (status === 'succeeded' && link.status !== 'succeeded') {
      // Settle the invoice in the same tx.
      const settled = await markPaid(
        {
          invoiceId: link.invoiceId,
          paidDate: paidAt || new Date(),
          amountPence: amountPence || Number(link.amountPence),
          settleFxRateToBase,
          actor: actor || { userId: 'system', role: 'system' },
        },
        { tx }
      );
      paymentJournalId = settled.paymentJournalId;
      newStatus = 'succeeded';
    } else if (status === 'failed' || status === 'refunded' || status === 'cancelled') {
      newStatus = status;
    } else if (status === 'processing') {
      newStatus = 'processing';
    }

    await tx
      .update(paymentLinks)
      .set({
        status: newStatus,
        succeededAt: newStatus === 'succeeded' ? new Date() : link.succeededAt,
        lastEventId: eventId,
        paymentJournalId,
        updatedAt: new Date(),
      })
      .where(eq(paymentLinks.id, link.id));

    await audit(
      {
        action: 'payment_link.event',
        actorUserId: actor?.userId || null,
        actorRole: actor?.role || 'webhook',
        resourceType: 'payment_link',
        resourceId: link.id,
        after: { eventType, status: newStatus, eventId, paymentJournalId },
      },
      { tx }
    );

    return {
      paymentLinkId: link.id,
      newStatus,
      paymentJournalId,
      duplicate: false,
    };
  });
}

/**
 * Provider-agnostic HMAC-SHA256 signature check. Both Stripe and
 * GoCardless sign the raw request body with a webhook-specific
 * secret and send the digest in a header. This lets the (future)
 * webhook endpoint do a constant-time compare without us pulling in
 * a vendor SDK.
 *
 * Returns true on match, false otherwise. Caller is responsible for
 * 401-ing on false.
 */
function verifySignature(provider, rawBody, signatureHeader, secret) {
  if (!PROVIDERS.has(provider)) return false;
  if (!signatureHeader || !secret || rawBody == null) return false;
  const computed = cryptoNode.createHmac('sha256', secret).update(rawBody).digest('hex');
  // Stripe header form is "t=...,v1=<digest>"; extract the v1 part.
  // GoCardless sends just the hex digest. We handle both.
  let presented = signatureHeader;
  if (signatureHeader.includes('v1=')) {
    const m = signatureHeader.match(/v1=([0-9a-f]+)/i);
    if (!m) return false;
    presented = m[1];
  }
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(presented, 'hex');
  if (a.length !== b.length) return false;
  return cryptoNode.timingSafeEqual(a, b);
}

async function getPaymentLink(id, opts = {}) {
  const db = opts.tx || getDb();
  const { paymentLinks } = getSchema();
  const rows = await db.select().from(paymentLinks).where(eq(paymentLinks.id, id)).limit(1);
  return rows[0] || null;
}

module.exports = {
  recordIntent,
  processWebhookEvent,
  verifySignature,
  getPaymentLink,
};
