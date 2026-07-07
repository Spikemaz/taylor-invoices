/**
 * Stage 4 — Expense claims (single-claimant, slice 1).
 *
 * A claim bundles 1+ items (each optionally tied to a receipt) into a
 * single director's-loan-account / drawings credit, so the books show
 * "the entity owes the director £X for these expenses".
 *
 * Slice 1: one claimant per claim (the director / sole trader).
 * Multi-employee approval workflows are out of scope.
 *
 * Posting (at approval time): one journal with multiple debit lines
 * (one per item) and a single credit line:
 *
 *   DR  <expense code A>     itemA.amount
 *   DR  <expense code B>     itemB.amount
 *   CR  2500 / 3100          SUM(items)
 */

const crypto = require('crypto');
const { and, eq } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { getAccountByCode } = require('../ledger/accounts');
const { postJournal } = require('../ledger/posting');
const { audit } = require('../audit-log');

function newClaimId() { return `ecl_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`; }
function newItemId()  { return `eci_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`; }

async function loadClaim(id, tx) {
  const db = tx || getDb();
  const { expenseClaims } = getSchema();
  const rows = await db.select().from(expenseClaims).where(eq(expenseClaims.id, id)).limit(1);
  if (!rows[0]) throw new Error(`expense claim ${id} not found`);
  return rows[0];
}

async function loadItems(claimId, tx) {
  const db = tx || getDb();
  const { expenseClaimItems } = getSchema();
  return db.select().from(expenseClaimItems).where(eq(expenseClaimItems.claimId, claimId));
}

async function entityType(entityId, tx) {
  const db = tx || getDb();
  const { entities } = getSchema();
  const rows = await db.select({ type: entities.type }).from(entities).where(eq(entities.id, entityId)).limit(1);
  if (!rows[0]) throw new Error(`entity ${entityId} not found`);
  return rows[0].type;
}

async function reimbursementCreditAccount(entityId, tx) {
  const t = await entityType(entityId, tx);
  return t === 'sole_trader'
    ? getAccountByCode(entityId, '3100', { tx })
    : getAccountByCode(entityId, '2500', { tx });
}

async function createClaim(input, opts = {}) {
  if (!input.entityId) throw new Error('entityId required');
  if (!input.title) throw new Error('title required');
  if (!input.claimDate) throw new Error('claimDate required');
  const id = newClaimId();
  const writer = opts.tx || getDb();
  const { expenseClaims } = getSchema();
  await writer.insert(expenseClaims).values({
    id,
    entityId: input.entityId,
    claimantUserId: input.claimantUserId || opts.actor?.userId || null,
    title: input.title,
    claimDate: input.claimDate,
    totalPence: 0,
    status: 'draft',
    notes: input.notes || null,
    createdBy: opts.actor?.userId || null,
  });
  await audit(
    {
      action: 'expense_claim.create',
      actorUserId: opts.actor?.userId || null,
      resourceType: 'expense_claim',
      resourceId: id,
      entityId: input.entityId,
      after: { title: input.title, claimDate: input.claimDate },
    },
    { tx: opts.tx }
  );
  return { id };
}

async function addItem(claimId, item, opts = {}) {
  if (!item || !item.description || !item.expenseAccountCode) {
    throw new Error('addItem: description + expenseAccountCode required');
  }
  if (!Number.isInteger(item.amountPence) || item.amountPence <= 0) {
    throw new Error('addItem: amountPence must be a positive integer');
  }
  const db = getDb();
  return db.transaction(async (tx) => {
    const claim = await loadClaim(claimId, tx);
    if (claim.status !== 'draft') {
      throw new Error(`addItem: claim ${claimId} is ${claim.status}, not draft`);
    }
    // Sanity: the expense code must exist for this entity.
    await getAccountByCode(claim.entityId, item.expenseAccountCode, { tx });
    const id = newItemId();
    const { expenseClaimItems, expenseClaims } = getSchema();
    await tx.insert(expenseClaimItems).values({
      id,
      claimId,
      receiptId: item.receiptId || null,
      description: item.description,
      amountPence: item.amountPence,
      expenseAccountCode: item.expenseAccountCode,
    });
    await tx
      .update(expenseClaims)
      .set({ totalPence: claim.totalPence + item.amountPence, updatedAt: new Date() })
      .where(eq(expenseClaims.id, claimId));
    return { id };
  });
}

async function approveClaim(claimId, opts = {}) {
  const db = getDb();
  return db.transaction(async (tx) => {
    const claim = await loadClaim(claimId, tx);
    if (claim.status === 'approved' || claim.status === 'paid') {
      throw new Error(`claim ${claimId} already ${claim.status}`);
    }
    const items = await loadItems(claimId, tx);
    if (items.length === 0) throw new Error('claim has no items');
    const total = items.reduce((s, i) => s + Number(i.amountPence), 0);
    if (total <= 0) throw new Error('claim total must be > 0');

    // Build journal lines: one DR per item (grouped by code) + one CR.
    const byCode = new Map();
    for (const it of items) {
      const acct = await getAccountByCode(claim.entityId, it.expenseAccountCode, { tx });
      byCode.set(acct.id, (byCode.get(acct.id) || 0) + Number(it.amountPence));
    }
    const credit = await reimbursementCreditAccount(claim.entityId, tx);
    const lines = [];
    for (const [accountId, amt] of byCode) {
      lines.push({ accountId, debit: amt, credit: 0, memo: claim.title });
    }
    lines.push({ accountId: credit.id, debit: 0, credit: total, memo: `Owed to claimant — ${claim.title}` });

    const j = await postJournal(
      {
        entityId: claim.entityId,
        date: claim.claimDate,
        description: `Expense claim — ${claim.title}`,
        source: 'expense',
        sourceType: 'expense_claim',
        sourceId: claimId,
        currency: 'GBP',
        createdBy: opts.actor?.userId || null,
        lines,
      },
      { tx, actor: opts.actor }
    );
    const { expenseClaims } = getSchema();
    await tx
      .update(expenseClaims)
      .set({ status: 'approved', postedJournalId: j.id, totalPence: total, updatedAt: new Date() })
      .where(eq(expenseClaims.id, claimId));
    await audit(
      {
        action: 'expense_claim.approve',
        actorUserId: opts.actor?.userId || null,
        resourceType: 'expense_claim',
        resourceId: claimId,
        entityId: claim.entityId,
        after: { journalId: j.id, totalPence: total, items: items.length },
      },
      { tx }
    );
    return { id: claimId, journalId: j.id, totalPence: total };
  });
}

async function listClaims(args, opts = {}) {
  const { entityId, status, limit = 100, offset = 0 } = args;
  if (!entityId) throw new Error('entityId required');
  const db = opts.tx || getDb();
  const { expenseClaims } = getSchema();
  const where = status
    ? and(eq(expenseClaims.entityId, entityId), eq(expenseClaims.status, status))
    : eq(expenseClaims.entityId, entityId);
  return db.select().from(expenseClaims).where(where).limit(limit).offset(offset);
}

/**
 * "Owed to director" running balance (Ltd) or "Owed to owner"
 * (sole trader) — sum of approved-but-unpaid claims.
 */
async function owedToClaimant(entityId, opts = {}) {
  if (!entityId) throw new Error('entityId required');
  const db = opts.tx || getDb();
  const { expenseClaims } = getSchema();
  const rows = await db
    .select()
    .from(expenseClaims)
    .where(and(eq(expenseClaims.entityId, entityId), eq(expenseClaims.status, 'approved')));
  return {
    totalPence: rows.reduce((s, r) => s + Number(r.totalPence), 0),
    claims: rows,
  };
}

module.exports = {
  createClaim,
  addItem,
  approveClaim,
  listClaims,
  owedToClaimant,
};
