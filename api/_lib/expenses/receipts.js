/**
 * Stage 4 — Receipts library.
 *
 * Slice 1 ships the metadata + approval flow. The OCR pipeline itself
 * (GPT-4o-mini vision call → structured JSON) is a Stage 4 follow-up;
 * this library accepts an OCR payload as input via `recordOcrResult`,
 * but it doesn't issue the model call.
 *
 * Lifecycle:
 *
 *   pending  → ocr_done  → approved  → matched   (auto-link to bank tx)
 *      \      \             ↓
 *       \      \________→ rejected
 *        \____________________→ rejected
 *
 * Approved receipts post a journal:
 *
 *   paymentMethod='bank'      DR <expenseCode>   CR 0800 Bank
 *   paymentMethod='cash'      DR <expenseCode>   CR 0810 Cash
 *   paymentMethod='director'  DR <expenseCode>   CR 2500 Director's Loan (Ltd)
 *                                                CR 3100 Drawings        (sole trader)
 *
 * After posting, we attempt to auto-link to a bank_transaction with the
 * same absolute amount and a date within ±2 days. If exactly one
 * unmatched candidate exists, both rows are linked and the bank line's
 * status moves to 'matched'.
 */

const crypto = require('crypto');
const { and, eq, gte, lte, isNull } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { getAccountByCode } = require('../ledger/accounts');
const { postJournal } = require('../ledger/posting');
const { audit } = require('../audit-log');

function newReceiptId() {
  return `rcp_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// =====================================================================
// Internal helpers
// =====================================================================

async function loadReceipt(id, tx) {
  const db = tx || getDb();
  const { receipts } = getSchema();
  const rows = await db.select().from(receipts).where(eq(receipts.id, id)).limit(1);
  if (!rows[0]) throw new Error(`receipt ${id} not found`);
  return rows[0];
}

async function entityType(entityId, tx) {
  const db = tx || getDb();
  const { entities } = getSchema();
  const rows = await db.select({ type: entities.type }).from(entities).where(eq(entities.id, entityId)).limit(1);
  if (!rows[0]) throw new Error(`entity ${entityId} not found`);
  return rows[0].type;
}

async function creditAccountFor(entityId, paymentMethod, tx) {
  if (paymentMethod === 'bank') return getAccountByCode(entityId, '0800', { tx });
  if (paymentMethod === 'cash') return getAccountByCode(entityId, '0810', { tx });
  if (paymentMethod === 'director') {
    const t = await entityType(entityId, tx);
    return t === 'sole_trader'
      ? getAccountByCode(entityId, '3100', { tx })
      : getAccountByCode(entityId, '2500', { tx });
  }
  throw new Error(`unknown paymentMethod ${paymentMethod}`);
}

function dateNDaysAway(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// =====================================================================
// Create / OCR / approve / reject
// =====================================================================

async function createReceipt(input, opts = {}) {
  if (!input.entityId) throw new Error('entityId required');
  const id = newReceiptId();
  const writer = opts.tx || getDb();
  const { receipts } = getSchema();
  await writer.insert(receipts).values({
    id,
    entityId: input.entityId,
    fileId: input.fileId || null,
    fileUrl: input.fileUrl || null,
    fileName: input.fileName || null,
    mimeType: input.mimeType || null,
    vendor: input.vendor || null,
    receiptDate: input.receiptDate || null,
    currency: input.currency || 'GBP',
    totalPence: input.totalPence ?? null,
    vatPence: input.vatPence ?? null,
    netPence: input.netPence ?? (input.totalPence != null && input.vatPence != null ? input.totalPence - input.vatPence : null),
    paymentMethod: input.paymentMethod || 'bank',
    expenseAccountCode: input.expenseAccountCode || null,
    notes: input.notes || null,
    status: 'pending',
    createdBy: opts.actor?.userId || null,
  });
  await audit(
    {
      action: 'receipt.create',
      actorUserId: opts.actor?.userId || null,
      actorEmail: opts.actor?.email,
      actorRole: opts.actor?.role,
      resourceType: 'receipt',
      resourceId: id,
      entityId: input.entityId,
      after: { vendor: input.vendor, totalPence: input.totalPence, status: 'pending' },
    },
    { tx: opts.tx }
  );
  return { id };
}

/**
 * Persist OCR output. Caller (Stage 4 follow-up: OCR worker) supplies
 * the raw model output + extracted fields. Status moves to 'ocr_done'.
 */
async function recordOcrResult(id, result, opts = {}) {
  if (!id) throw new Error('id required');
  const writer = opts.tx || getDb();
  const { receipts } = getSchema();
  const total = result?.totalPence ?? null;
  const vat = result?.vatPence ?? null;
  const net = result?.netPence ?? (total != null && vat != null ? total - vat : null);
  await writer
    .update(receipts)
    .set({
      vendor: result?.vendor ?? null,
      receiptDate: result?.receiptDate ?? null,
      totalPence: total,
      vatPence: vat,
      netPence: net,
      ocrPayload: result?.payload ?? null,
      ocrConfidence: result?.confidence ?? null,
      ocrModel: result?.model ?? null,
      status: 'ocr_done',
      updatedAt: new Date(),
    })
    .where(eq(receipts.id, id));
  await audit(
    {
      action: 'receipt.ocr',
      actorUserId: opts.actor?.userId || null,
      resourceType: 'receipt',
      resourceId: id,
      after: { vendor: result?.vendor, total, vat, model: result?.model, confidence: result?.confidence },
    },
    { tx: opts.tx }
  );
  return { ok: true };
}

async function rejectReceipt(id, reason, opts = {}) {
  const writer = opts.tx || getDb();
  const { receipts } = getSchema();
  await writer
    .update(receipts)
    .set({ status: 'rejected', notes: reason || null, updatedAt: new Date() })
    .where(eq(receipts.id, id));
  await audit(
    {
      action: 'receipt.reject',
      actorUserId: opts.actor?.userId || null,
      resourceType: 'receipt',
      resourceId: id,
      after: { reason: reason || null },
    },
    { tx: opts.tx }
  );
  return { ok: true };
}

/**
 * User confirms (and optionally edits) the OCR'd fields. Posts a ledger
 * journal and (best-effort) auto-links a matching bank transaction.
 *
 *   patch — overrides for vendor/totalPence/vatPence/receiptDate/
 *           expenseAccountCode/paymentMethod, applied before posting.
 */
async function approveReceipt(id, patch = {}, opts = {}) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const r = await loadReceipt(id, tx);
    if (r.status === 'approved' || r.status === 'matched') {
      throw new Error(`receipt ${id} already ${r.status}`);
    }
    if (r.status === 'rejected') throw new Error(`receipt ${id} is rejected`);
    const merged = {
      vendor: patch.vendor ?? r.vendor,
      receiptDate: patch.receiptDate ?? r.receiptDate,
      totalPence: patch.totalPence ?? r.totalPence,
      vatPence: patch.vatPence ?? r.vatPence,
      expenseAccountCode: patch.expenseAccountCode ?? r.expenseAccountCode,
      paymentMethod: patch.paymentMethod ?? r.paymentMethod,
    };
    if (!merged.totalPence || merged.totalPence <= 0) {
      throw new Error('approveReceipt: totalPence required and must be > 0');
    }
    if (!merged.expenseAccountCode) {
      throw new Error('approveReceipt: expenseAccountCode required');
    }
    if (!merged.receiptDate) {
      throw new Error('approveReceipt: receiptDate required');
    }
    const expense = await getAccountByCode(r.entityId, merged.expenseAccountCode, { tx });
    const credit = await creditAccountFor(r.entityId, merged.paymentMethod, tx);

    // Post the journal. VAT split is deferred to Stage 7 (MTD) — for
    // now we expense the gross total to a single expense code; the
    // vatPence column is preserved so Stage 7 can reclaim it later.
    const journalDescription = `Receipt — ${merged.vendor || 'unknown vendor'}`;
    const j = await postJournal(
      {
        entityId: r.entityId,
        date: merged.receiptDate,
        description: journalDescription,
        source: 'expense',
        sourceType: 'receipt',
        sourceId: id,
        currency: r.currency || 'GBP',
        createdBy: opts.actor?.userId || null,
        lines: [
          { accountId: expense.id, debit: merged.totalPence, credit: 0,                memo: merged.vendor || null },
          { accountId: credit.id,  debit: 0,                 credit: merged.totalPence, memo: merged.vendor || null },
        ],
      },
      { tx, actor: opts.actor }
    );

    const { receipts } = getSchema();
    await tx
      .update(receipts)
      .set({
        status: 'approved',
        vendor: merged.vendor || null,
        receiptDate: merged.receiptDate,
        totalPence: merged.totalPence,
        vatPence: merged.vatPence ?? null,
        netPence: merged.vatPence != null ? merged.totalPence - merged.vatPence : merged.totalPence,
        expenseAccountCode: merged.expenseAccountCode,
        paymentMethod: merged.paymentMethod,
        postedJournalId: j.id,
        updatedAt: new Date(),
      })
      .where(eq(receipts.id, id));
    await audit(
      {
        action: 'receipt.approve',
        actorUserId: opts.actor?.userId || null,
        actorEmail: opts.actor?.email,
        actorRole: opts.actor?.role,
        resourceType: 'receipt',
        resourceId: id,
        entityId: r.entityId,
        after: {
          journalId: j.id,
          totalPence: merged.totalPence,
          expenseAccountCode: merged.expenseAccountCode,
          paymentMethod: merged.paymentMethod,
        },
      },
      { tx }
    );

    // Best-effort bank match (for paymentMethod=bank only).
    let matchInfo = { matched: false };
    if (merged.paymentMethod === 'bank') {
      matchInfo = await tryAutoMatchBankTx({
        receiptId: id,
        entityId: r.entityId,
        receiptDate: merged.receiptDate,
        totalPence: merged.totalPence,
        journalId: j.id,
      }, { tx, actor: opts.actor });
    }
    return { id, journalId: j.id, ...matchInfo };
  });
}

// =====================================================================
// Bank-transaction auto-match
// =====================================================================

async function tryAutoMatchBankTx(args, opts = {}) {
  const { receiptId, entityId, receiptDate, totalPence, journalId } = args;
  const tx = opts.tx;
  if (!tx) throw new Error('tryAutoMatchBankTx requires a tx');
  const { bankTransactions, receipts } = getSchema();
  const fromDate = dateNDaysAway(receiptDate, -2);
  const toDate = dateNDaysAway(receiptDate, 2);
  // Receipt totals are stored as positive pence; bank outflows are
  // negative. Match on absolute value.
  const candidates = await tx
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.entityId, entityId),
        eq(bankTransactions.amountPence, -totalPence),
        eq(bankTransactions.status, 'unmatched'),
        gte(bankTransactions.date, fromDate),
        lte(bankTransactions.date, toDate)
      )
    );
  if (candidates.length !== 1) {
    return { matched: false, candidateCount: candidates.length };
  }
  const btx = candidates[0];
  await tx
    .update(bankTransactions)
    .set({
      status: 'matched',
      matchedJournalId: journalId,
      matchedAt: new Date(),
      matchedBy: opts.actor?.userId || null,
      updatedAt: new Date(),
    })
    .where(eq(bankTransactions.id, btx.id));
  await tx
    .update(receipts)
    .set({ status: 'matched', matchedBankTxId: btx.id, updatedAt: new Date() })
    .where(eq(receipts.id, receiptId));
  await audit(
    {
      action: 'receipt.bank_match',
      actorUserId: opts.actor?.userId || null,
      resourceType: 'receipt',
      resourceId: receiptId,
      entityId,
      after: { bankTxId: btx.id, journalId },
    },
    { tx }
  );
  return { matched: true, bankTxId: btx.id };
}

async function listReceipts(args, opts = {}) {
  const { entityId, status, limit = 100, offset = 0 } = args;
  if (!entityId) throw new Error('entityId required');
  const db = opts.tx || getDb();
  const { receipts } = getSchema();
  const where = status
    ? and(eq(receipts.entityId, entityId), eq(receipts.status, status))
    : eq(receipts.entityId, entityId);
  return db.select().from(receipts).where(where).limit(limit).offset(offset);
}

module.exports = {
  createReceipt,
  recordOcrResult,
  approveReceipt,
  rejectReceipt,
  listReceipts,
  tryAutoMatchBankTx,
};
