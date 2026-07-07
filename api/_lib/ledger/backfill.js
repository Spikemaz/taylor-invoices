/**
 * Stage 1 — Backfill from Sheets-era data into the double-entry ledger.
 *
 * The live booksiq.app site has stored invoices and entries in Google
 * Sheets since launch. This module replays that history into the
 * Postgres ledger so reports can show historical totals when we cut over.
 *
 * Design choices:
 *
 *   - Caller passes already-parsed invoices/entries arrays. We don't reach
 *     into Google Sheets here; the admin endpoint and `sheets-sync.js`
 *     handle fetching. Keeping the I/O outside the function makes it
 *     trivially unit-testable and lets us dry-run against live data.
 *
 *   - Every backfill journal is stamped `source='backfill_v1'` and carries
 *     the originating row id in `sourceId`. This is the reversibility
 *     hatch — if the v1 backfill is wrong, we delete WHERE source='backfill_v1'
 *     and re-run.
 *
 *   - Idempotent. We check for an existing journal with the same
 *     (entityId, source='backfill_v1', sourceType, sourceId) before posting.
 *     Re-running is a no-op for already-backfilled rows. Means the admin
 *     can run dry-run, then execute, then re-run without fear.
 *
 *   - Each invoice produces 1–2 journals:
 *       (a) revenue accrual on invoice.date:        DR Debtors / CR Sales
 *       (b) payment on invoice.paidDate (if paid):  DR Bank    / CR Debtors
 *     Loose entries (without an attached invoice) are NOT backfilled —
 *     they are draft work-in-progress that becomes revenue only when an
 *     invoice is issued. Posting them would double-count.
 *
 *   - Money: parses from various legacy formats (string "£12.34", number,
 *     possibly already-pence) using `poundsToPence`. Rejects negatives.
 *
 *   - Dry-run mode (`opts.dryRun = true`) builds the plan without writing.
 *     Returns counts and a sample of the journals it WOULD post. Used by
 *     the admin "preview backfill" endpoint.
 */

const { getDb, getSchema } = require('../db');
const { and, eq, inArray, sql } = require('drizzle-orm');
const { postSale, postPaymentReceived, poundsToPence, toDateString } = require('./posting');

/**
 * Normalise a money value from the legacy Sheets data. Accepts:
 *   - number (assumed pounds)
 *   - "12.34", "£12.34", "1,234.56"
 *   - empty / null → 0
 * Returns integer pence. Throws on non-numeric junk.
 */
function parseMoneyToPence(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return poundsToPence(v);
  let s = String(v).trim();
  if (!s) return 0;
  s = s.replace(/[£$,\s]/g, '');
  if (s === '' || s === '-') return 0;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) {
    throw new Error(`Cannot parse money value: ${JSON.stringify(v)}`);
  }
  return poundsToPence(n);
}

/**
 * Best-effort ISO-date extraction from the legacy Sheets data.
 *   - "2024-03-12T..."        → "2024-03-12"
 *   - "2024-03-12"            → "2024-03-12"
 *   - "12/03/2024"            → "2024-03-12"  (UK day-first)
 *   - 45378  (Excel serial)   → date by serial
 * Returns null if unparseable.
 */
function parseDate(v) {
  if (!v && v !== 0) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Excel epoch starts 1899-12-30 (taking into account Lotus' 1900 leap bug).
    const ms = (v - 25569) * 86400000;
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
  }
  const s = String(v).trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  // UK dd/mm/yyyy
  const uk = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (uk) {
    const [, dd, mm, yyyyRaw] = uk;
    const yyyy = yyyyRaw.length === 2 ? `20${yyyyRaw}` : yyyyRaw;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  // Last-resort Date parse
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

/**
 * Normalise a paid-status string from legacy data. Anything that looks
 * affirmative ("paid", "yes", "y", true, 1) returns true.
 */
function isInvoicePaid(invoice) {
  const v = invoice.paidStatus ?? invoice.paid ?? invoice.status;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === 'paid' || s === 'yes' || s === 'y' || s === 'true' || s === '1';
  }
  return false;
}

/**
 * Build the planned ledger ops for a single invoice. Returns 1 or 2 ops.
 * Pure function — no DB calls — so the dry-run path is identical to the
 * commit path up to this point.
 */
function planInvoice(invoice) {
  const id = invoice.id || invoice.invoiceId || invoice.invoiceNumber;
  if (!id) {
    return { ops: [], skipped: 'no-id', invoice };
  }
  const date = parseDate(invoice.date || invoice.issueDate || invoice.invoiceDate);
  if (!date) return { ops: [], skipped: 'no-date', invoice };

  const amountPence = parseMoneyToPence(
    invoice.total ?? invoice.amount ?? invoice.totalAmount ?? invoice.gross
  );
  if (amountPence <= 0) return { ops: [], skipped: 'zero-amount', invoice };

  const ops = [
    {
      kind: 'sale',
      sourceType: 'invoice',
      sourceId: String(id),
      date,
      amountPence,
      customerName: invoice.customerName || invoice.client || invoice.customer || null,
      description: `[backfill] Invoice ${id}`,
    },
  ];

  if (isInvoicePaid(invoice)) {
    const paidDate =
      parseDate(invoice.paidDate || invoice.datePaid || invoice.paymentDate) || date;
    ops.push({
      kind: 'payment',
      sourceType: 'invoice',
      sourceId: String(id),
      date: paidDate,
      amountPence,
      customerName: invoice.customerName || invoice.client || invoice.customer || null,
      description: `[backfill] Payment for invoice ${id}`,
    });
  }
  return { ops, skipped: null, invoice };
}

/**
 * Look up which (sourceType, sourceId) pairs already have a backfill
 * journal so we don't double-post. Returns a Set of "type:id" keys.
 */
async function findExistingBackfillKeys(entityId, plannedOps, tx) {
  const writer = tx || getDb();
  const { journals } = getSchema();
  const ids = [...new Set(plannedOps.map((op) => op.sourceId))];
  if (ids.length === 0) return new Set();
  const rows = await writer
    .select({
      sourceType: journals.sourceType,
      sourceId: journals.sourceId,
      kind: journals.source,
      sourceKind: journals.source,
    })
    .from(journals)
    .where(
      and(
        eq(journals.entityId, entityId),
        eq(journals.source, 'backfill_v1'),
        inArray(journals.sourceId, ids)
      )
    );
  // The dedupe key includes the legacy invoice id AND the leg (sale vs
  // payment). We encode the leg in sourceType: 'invoice' = sale leg,
  // 'invoice_payment' = payment leg.
  const keys = new Set();
  for (const r of rows) {
    keys.add(`${r.sourceType}:${r.sourceId}`);
  }
  return keys;
}

function planKey(op) {
  return op.kind === 'sale'
    ? `invoice:${op.sourceId}`
    : `invoice_payment:${op.sourceId}`;
}

/**
 * Backfill an entity's invoices. See the file header for semantics.
 *
 * @param {object} input
 * @param {string} input.entityId
 * @param {Array}  input.invoices    legacy invoice rows (parsed from Sheets)
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=true]   default: dry-run (no writes)
 * @param {object}  [opts.actor]         audit metadata for executed posts
 * @param {number}  [opts.limit]         cap on number of invoices to process
 *
 * @returns {Promise<{
 *   dryRun: boolean,
 *   entityId: string,
 *   summary: {
 *     totalInvoices: number, eligible: number, alreadyBackfilled: number,
 *     skipped: number, planned: number, posted: number, failed: number,
 *     totalPence: number,
 *   },
 *   skippedReasons: Record<string, number>,
 *   sample: Array<{kind:string, sourceId:string, date:string, amountPence:number}>,
 *   failures: Array<{sourceId:string, kind:string, error:string}>,
 * }>}
 */
async function backfillInvoices(input, opts = {}) {
  const { entityId, invoices } = input;
  if (!entityId) throw new Error('backfillInvoices: entityId required');
  if (!Array.isArray(invoices)) throw new Error('backfillInvoices: invoices array required');

  const dryRun = opts.dryRun !== false; // default to dry-run for safety
  const limit = typeof opts.limit === 'number' ? opts.limit : invoices.length;

  // Phase 1: build the plan from parsed invoices.
  const plans = invoices.slice(0, limit).map(planInvoice);
  const allOps = [];
  const skippedReasons = {};
  for (const p of plans) {
    if (p.skipped) {
      skippedReasons[p.skipped] = (skippedReasons[p.skipped] || 0) + 1;
      continue;
    }
    allOps.push(...p.ops);
  }

  // Phase 2: filter out anything we've already backfilled.
  const existingKeys = await findExistingBackfillKeys(entityId, allOps);
  const planned = allOps.filter((op) => !existingKeys.has(planKey(op)));
  const alreadyBackfilledOps = allOps.length - planned.length;
  const totalPence = planned
    .filter((op) => op.kind === 'sale')
    .reduce((a, op) => a + op.amountPence, 0);

  const sample = planned.slice(0, 10).map((op) => ({
    kind: op.kind,
    sourceId: op.sourceId,
    date: op.date,
    amountPence: op.amountPence,
  }));

  if (dryRun) {
    return {
      dryRun: true,
      entityId,
      summary: {
        totalInvoices: invoices.length,
        eligible: allOps.length,
        alreadyBackfilled: alreadyBackfilledOps,
        skipped: Object.values(skippedReasons).reduce((a, b) => a + b, 0),
        planned: planned.length,
        posted: 0,
        failed: 0,
        totalPence,
      },
      skippedReasons,
      sample,
      failures: [],
    };
  }

  // Phase 3: execute. We post each leg in its OWN transaction (rather than
  // one big transaction for the whole entity) so a single bad row doesn't
  // roll back the entire backfill. Per-leg failures are collected and
  // reported. The admin can re-run; idempotency makes it safe.
  let posted = 0;
  const failures = [];
  for (const op of planned) {
    try {
      if (op.kind === 'sale') {
        await postSale(
          {
            entityId,
            date: op.date,
            amountPence: op.amountPence,
            invoiceId: op.sourceId,
            customerName: op.customerName,
            description: op.description,
            createdBy: opts.actor?.userId || null,
          },
          { actor: { ...opts.actor, source: 'backfill' } }
        );
      } else if (op.kind === 'payment') {
        await postPaymentReceived(
          {
            entityId,
            date: op.date,
            amountPence: op.amountPence,
            invoiceId: op.sourceId,
            customerName: op.customerName,
            description: op.description,
            createdBy: opts.actor?.userId || null,
          },
          { actor: { ...opts.actor, source: 'backfill' } }
        );
      }
      posted++;
    } catch (err) {
      failures.push({
        kind: op.kind,
        sourceId: op.sourceId,
        date: op.date,
        amountPence: op.amountPence,
        error: err.message,
      });
    }
  }

  // We need to mark backfill journals with source='backfill_v1' for the
  // reversibility property. postSale/postPaymentReceived hardcode source
  // to 'invoice' / 'invoice_payment' — so we update them after the fact
  // for backfill runs. This is intentional: the named helpers stay
  // simple, and the backfill module owns the marker rewrite.
  if (posted > 0) {
    await tagBackfillJournals(entityId, planned);
  }

  return {
    dryRun: false,
    entityId,
    summary: {
      totalInvoices: invoices.length,
      eligible: allOps.length,
      alreadyBackfilled: alreadyBackfilledOps,
      skipped: Object.values(skippedReasons).reduce((a, b) => a + b, 0),
      planned: planned.length,
      posted,
      failed: failures.length,
      totalPence,
    },
    skippedReasons,
    sample,
    failures,
  };
}

/**
 * Re-tag journals we just posted as `source='backfill_v1'` so the
 * reversibility query (`DELETE WHERE source='backfill_v1'`) works.
 *
 * We identify them by (entityId, sourceType, sourceId) — set when posting.
 * Only tag rows still flagged as the live source ('invoice' or
 * 'invoice_payment') so re-running doesn't accidentally re-tag user
 * journals.
 */
async function tagBackfillJournals(entityId, ops) {
  const db = getDb();
  const { journals } = getSchema();
  const saleIds = ops.filter((o) => o.kind === 'sale').map((o) => o.sourceId);
  const payIds = ops.filter((o) => o.kind === 'payment').map((o) => o.sourceId);
  if (saleIds.length > 0) {
    await db
      .update(journals)
      .set({ source: 'backfill_v1' })
      .where(
        and(
          eq(journals.entityId, entityId),
          eq(journals.source, 'invoice'),
          eq(journals.sourceType, 'invoice'),
          inArray(journals.sourceId, saleIds)
        )
      );
  }
  if (payIds.length > 0) {
    await db
      .update(journals)
      .set({ source: 'backfill_v1' })
      .where(
        and(
          eq(journals.entityId, entityId),
          eq(journals.source, 'invoice_payment'),
          eq(journals.sourceType, 'invoice_payment'),
          inArray(journals.sourceId, payIds)
        )
      );
  }
}

/**
 * Reversal — delete every backfill_v1 journal for an entity. Used when the
 * v1 backfill is wrong and we want to re-run from scratch. The
 * journal_lines cascade with the journals.
 */
async function reverseBackfill(entityId) {
  if (!entityId) throw new Error('reverseBackfill: entityId required');
  const db = getDb();
  const { journals } = getSchema();
  const result = await db
    .delete(journals)
    .where(
      and(eq(journals.entityId, entityId), eq(journals.source, 'backfill_v1'))
    )
    .returning({ id: journals.id });
  return { deleted: result.length };
}

/**
 * IAccountant-only ATOMIC rebuild of one entity's derived read-model.
 *
 * Unlike backfillInvoices() — which is append-only, posts each leg in its
 * OWN transaction (bad-row tolerance for the admin's one-shot import of
 * dirty legacy data), and tags backfill_v1 AFTER the loop — this runs the
 * WHOLE rebuild for a single entity inside ONE transaction:
 *
 *   1. pg_advisory_xact_lock(entityId) — serializes concurrent refreshes
 *      for the same entity. Without it, two refreshes could both reverse
 *      then both re-post, doubling the ledger.
 *   2. DELETE the entity's source='backfill_v1' journals (the reverse).
 *   3. Re-post every eligible invoice leg AND tag them 'backfill_v1' — in
 *      the SAME transaction. There is therefore NO post-before-tag window:
 *      a crash, or a single bad row, rolls the whole rebuild back, leaving
 *      the previous good read-model intact. Re-running is fully self-healing.
 *
 * Because the read-model is always re-derivable from Sheets (the source of
 * truth), failing the entire entity rebuild on one bad row — rather than
 * silently committing partial figures — is the correct trade-off here.
 *
 * @param {object} input
 * @param {string} input.entityId
 * @param {Array}  input.invoices   invoice rows already parsed from Sheets
 * @param {object} [opts]
 * @param {object} [opts.actor]     audit metadata (e.g. { userId })
 * @returns {Promise<{entityId:string, reversed:number, eligible:number,
 *   posted:number, skipped:number, skippedReasons:Record<string,number>,
 *   incomePostedPence:number}>}
 */
async function rebuildEntityInvoices(input, opts = {}) {
  const { entityId, invoices } = input;
  if (!entityId) throw new Error('rebuildEntityInvoices: entityId required');
  if (!Array.isArray(invoices)) {
    throw new Error('rebuildEntityInvoices: invoices array required');
  }

  // Plan is pure (no DB) — identical to the backfill path.
  const plans = invoices.map(planInvoice);
  const allOps = [];
  const skippedReasons = {};
  for (const p of plans) {
    if (p.skipped) {
      skippedReasons[p.skipped] = (skippedReasons[p.skipped] || 0) + 1;
      continue;
    }
    allOps.push(...p.ops);
  }

  const db = getDb();
  const { journals } = getSchema();

  return db.transaction(async (tx) => {
    // (1) Serialize per entity. Transaction-scoped → auto-released on
    // commit/rollback. hashtext()->int4, cast to int8 for the lock key.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${entityId})::int8)`);

    // (2) Reverse: drop this entity's prior derived journals (lines cascade).
    const del = await tx
      .delete(journals)
      .where(and(eq(journals.entityId, entityId), eq(journals.source, 'backfill_v1')))
      .returning({ id: journals.id });

    // (3) Rebuild: post every leg in THIS tx. We deliberately do NOT catch
    // per-leg errors — any failure must abort the whole rebuild so we never
    // commit a partial read-model. We capture the journal id each post
    // returns so we can tag EXACTLY those rows below — tagging by sourceId
    // would be fragile because invoice numbers repeat across practices.
    let posted = 0;
    let incomePostedPence = 0;
    const postedIds = [];
    for (const op of allOps) {
      const args = {
        entityId,
        date: op.date,
        amountPence: op.amountPence,
        invoiceId: op.sourceId,
        customerName: op.customerName,
        description: op.description,
        createdBy: opts.actor?.userId || null,
      };
      const txOpts = { tx, actor: { ...opts.actor, source: 'backfill' } };
      if (op.kind === 'sale') {
        const j = await postSale(args, txOpts);
        postedIds.push(j.id);
        incomePostedPence += op.amountPence;
        posted++;
      } else if (op.kind === 'payment') {
        const j = await postPaymentReceived(args, txOpts);
        postedIds.push(j.id);
        posted++;
      }
    }

    // Tag exactly the journals we just posted as backfill_v1 — same tx, so
    // atomic with the posts (no post-before-tag crash window), and scoped to
    // our own journal ids so it can never touch any other entity rows.
    if (postedIds.length > 0) {
      await tx
        .update(journals)
        .set({ source: 'backfill_v1' })
        .where(and(eq(journals.entityId, entityId), inArray(journals.id, postedIds)));
    }

    return {
      entityId,
      reversed: del.length,
      eligible: allOps.length,
      posted,
      skipped: Object.values(skippedReasons).reduce((a, b) => a + b, 0),
      skippedReasons,
      incomePostedPence,
    };
  });
}

module.exports = {
  parseMoneyToPence,
  parseDate,
  isInvoicePaid,
  planInvoice,
  backfillInvoices,
  reverseBackfill,
  rebuildEntityInvoices,
};
