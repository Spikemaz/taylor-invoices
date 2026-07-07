/**
 * Stage 2 — Bank-transaction inbox library.
 *
 * Provides:
 *   - `createBankConnection`, `createBankAccount` — set up a CSV/PDF/online
 *     source and pin it to a CoA bank account.
 *   - `importTransactions` — write parsed rows into bank_transactions
 *     idempotently (dedupe-hash unique per bank_account).
 *   - `suggestMatches` — for an unmatched bank line, find candidate
 *     ledger journals (open invoices for inflows, recent expenses for
 *     outflows) within a date window.
 *   - `matchTransactionToInvoice` — post a payment-received journal via
 *     the Stage 1 helpers and link the bank line to it.
 *   - `categoriseTransaction` — for unmatched lines that are NOT invoice
 *     payments, post a fresh expense (out) or generic income (in)
 *     journal to a user-specified expense/income code.
 *   - `ignoreTransaction`, `unmatchTransaction` — admin/user overrides.
 *
 * All public functions write an audit row through the same transaction
 * as the data change, so bank reconciliation is fully defensible.
 */

const crypto = require('crypto');
const { and, eq, gte, lte, isNull, desc, asc } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { audit } = require('../audit-log');
const { getAccountByCode } = require('../ledger/accounts');
const {
  postJournal,
  postPaymentReceived,
  postExpense,
  toDateString,
} = require('../ledger/posting');

// =====================================================================
// ID helpers
// =====================================================================

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Compute the dedupe hash for a (bank_account, row) pair. We canonicalise
 * the description (collapse whitespace, lowercase) so re-uploads where the
 * bank slightly reformats the memo still dedupe.
 */
function dedupeHash({ bankAccountId, date, amountPence, description, reference }) {
  const desc = String(description || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const ref = String(reference || '').trim();
  const buf = `${bankAccountId}|${toDateString(date)}|${amountPence}|${desc}|${ref}`;
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// =====================================================================
// Connections + accounts
// =====================================================================

async function createBankConnection(input, opts = {}) {
  const {
    entityId,
    provider,
    institutionId,
    institutionName,
    credentialsCiphertext,
    expiresAt,
  } = input;
  if (!entityId) throw new Error('entityId required');
  if (!provider) throw new Error('provider required');
  const id = newId('bcn');
  const writer = opts.tx || getDb();
  const { bankConnections } = getSchema();
  await writer.insert(bankConnections).values({
    id,
    entityId,
    provider,
    institutionId: institutionId || null,
    institutionName: institutionName || null,
    credentialsCiphertext: credentialsCiphertext || null,
    expiresAt: expiresAt ? new Date(expiresAt) : null,
    status: 'active',
  });
  await audit(
    {
      action: 'bank.connection.create',
      actorUserId: opts.actor?.userId || null,
      actorEmail: opts.actor?.email,
      actorRole: opts.actor?.role,
      ip: opts.actor?.ip,
      userAgent: opts.actor?.userAgent,
      requestId: opts.actor?.requestId,
      resourceType: 'bank_connection',
      resourceId: id,
      entityId,
      after: { provider, institutionName: institutionName || null },
    },
    { tx: opts.tx }
  );
  return { id };
}

async function createBankAccount(input, opts = {}) {
  const {
    entityId,
    connectionId,
    ledgerAccountCode,
    ledgerAccountId,
    name,
    accountNumberLast4,
    sortCode,
    currency = 'GBP',
    openingBalancePence = 0,
    openingBalanceDate,
  } = input;
  if (!entityId) throw new Error('entityId required');
  if (!name) throw new Error('name required');
  // Resolve the CoA account either by id (if caller supplied it) or by
  // code (default 0800 for the bank account).
  let resolvedLedgerId = ledgerAccountId;
  if (!resolvedLedgerId) {
    const acc = await getAccountByCode(entityId, ledgerAccountCode || '0800', { tx: opts.tx });
    resolvedLedgerId = acc.id;
  }
  const id = newId('bka');
  const writer = opts.tx || getDb();
  const { bankAccounts } = getSchema();
  await writer.insert(bankAccounts).values({
    id,
    entityId,
    connectionId: connectionId || null,
    ledgerAccountId: resolvedLedgerId,
    name,
    accountNumberLast4: accountNumberLast4 || null,
    sortCode: sortCode || null,
    currency,
    openingBalancePence: Number(openingBalancePence) || 0,
    openingBalanceDate: openingBalanceDate ? toDateString(openingBalanceDate) : null,
  });
  await audit(
    {
      action: 'bank.account.create',
      actorUserId: opts.actor?.userId || null,
      actorEmail: opts.actor?.email,
      actorRole: opts.actor?.role,
      resourceType: 'bank_account',
      resourceId: id,
      entityId,
      after: { name, ledgerAccountId: resolvedLedgerId, currency },
    },
    { tx: opts.tx }
  );
  return { id, ledgerAccountId: resolvedLedgerId };
}

// =====================================================================
// Import
// =====================================================================

/**
 * Insert parsed bank rows into bank_transactions. Idempotent — rows with
 * a duplicate (bank_account_id, dedupe_hash) are skipped via ON CONFLICT.
 *
 * @param {object} input
 * @param {string} input.bankAccountId
 * @param {string} input.entityId
 * @param {Array<{date, amountPence, description, counterparty?, reference?, rawRow?}>} input.rows
 * @returns {Promise<{ inserted: number, skipped: number, ids: string[] }>}
 */
async function importTransactions(input, opts = {}) {
  const { bankAccountId, entityId, rows } = input;
  if (!bankAccountId) throw new Error('bankAccountId required');
  if (!entityId) throw new Error('entityId required');
  if (!Array.isArray(rows)) throw new Error('rows must be an array');
  if (rows.length === 0) return { inserted: 0, skipped: 0, ids: [] };

  const { bankTransactions } = getSchema();
  const writer = opts.tx || getDb();

  const valuesAll = rows.map((r) => {
    const dateStr = toDateString(r.date);
    const amountPence = Number(r.amountPence);
    if (!Number.isInteger(amountPence) || amountPence === 0) {
      throw new Error(`importTransactions: row has invalid amountPence: ${r.amountPence}`);
    }
    const description = (r.description || '').trim() || 'Bank transaction';
    const reference = r.reference || null;
    const hash = dedupeHash({
      bankAccountId,
      date: dateStr,
      amountPence,
      description,
      reference: reference || '',
    });
    return {
      id: newId('btx'),
      entityId,
      bankAccountId,
      date: dateStr,
      amountPence,
      description,
      counterparty: r.counterparty || null,
      reference,
      rawPayload: r.rawRow || null,
      dedupeHash: hash,
      status: 'unmatched',
    };
  });

  // ON CONFLICT (bank_account_id, dedupe_hash) DO NOTHING — drizzle's
  // onConflictDoNothing targets the unique index by columns.
  const inserted = await writer
    .insert(bankTransactions)
    .values(valuesAll)
    .onConflictDoNothing({ target: [bankTransactions.bankAccountId, bankTransactions.dedupeHash] })
    .returning({ id: bankTransactions.id });

  await audit(
    {
      action: 'bank.transactions.import',
      actorUserId: opts.actor?.userId || null,
      actorEmail: opts.actor?.email,
      actorRole: opts.actor?.role,
      resourceType: 'bank_account',
      resourceId: bankAccountId,
      entityId,
      after: { presented: rows.length, inserted: inserted.length, skipped: rows.length - inserted.length },
    },
    { tx: opts.tx }
  );

  return {
    inserted: inserted.length,
    skipped: rows.length - inserted.length,
    ids: inserted.map((r) => r.id),
  };
}

// =====================================================================
// Match suggestions (auto-reconciliation heuristic)
// =====================================================================

/**
 * Suggest invoice payments / expense matches for an unmatched bank line.
 *
 * Heuristic for inflows (amount > 0):
 *   - Find open invoices on `journals` whose source='invoice', UNPAID
 *     (i.e. no settling payment_received against the same sourceId yet),
 *     same entity, total === amount, dated within ±windowDays.
 *
 * For outflows we don't suggest anything yet — Stage 3's rules engine
 * will own that. Caller can still use `categoriseTransaction` to post a
 * manual expense.
 *
 * @returns {Promise<Array<{ kind: 'invoice_payment', invoiceId, journalId, score, reason, journalDate }>>}
 */
async function suggestMatches(bankTxId, opts = {}) {
  const db = opts.tx || getDb();
  const { bankTransactions, journals, journalLines } = getSchema();
  const rows = await db
    .select()
    .from(bankTransactions)
    .where(eq(bankTransactions.id, bankTxId))
    .limit(1);
  const tx = rows[0];
  if (!tx) throw new Error(`bank transaction ${bankTxId} not found`);
  if (tx.status !== 'unmatched') return [];

  if (tx.amountPence <= 0) return []; // outflows handled in Stage 3

  const windowDays = opts.windowDays || 14;
  const { from, to } = dateWindow(tx.date, windowDays);

  // Find sale-source journals in the window for this entity, same total.
  // We approximate "open" by checking that there's no invoice_payment
  // journal with the same sourceId yet.
  const sales = await db
    .select({ id: journals.id, sourceId: journals.sourceId, date: journals.date })
    .from(journals)
    .where(
      and(
        eq(journals.entityId, tx.entityId),
        eq(journals.source, 'invoice'),
        gte(journals.date, from),
        lte(journals.date, to)
      )
    );

  // For each candidate, check the totalPence on its lines == tx.amountPence
  // and that no invoice_payment exists yet for the same invoice id.
  const out = [];
  for (const sale of sales) {
    const lines = await db
      .select({ debit: journalLines.debitPence, credit: journalLines.creditPence })
      .from(journalLines)
      .where(eq(journalLines.journalId, sale.id));
    const totalPence = lines.reduce((a, l) => a + Number(l.debit || 0), 0);
    if (totalPence !== tx.amountPence) continue;
    if (!sale.sourceId) continue;
    const settled = await db
      .select({ id: journals.id })
      .from(journals)
      .where(
        and(
          eq(journals.entityId, tx.entityId),
          eq(journals.source, 'invoice_payment'),
          eq(journals.sourceId, sale.sourceId)
        )
      )
      .limit(1);
    if (settled[0]) continue;
    const dayDiff = Math.abs(Math.round((new Date(tx.date) - new Date(sale.date)) / 86400000));
    out.push({
      kind: 'invoice_payment',
      invoiceId: sale.sourceId,
      journalId: sale.id,
      score: 1 / (1 + dayDiff),
      reason: `exact-amount match within ${dayDiff} day(s)`,
      journalDate: sale.date,
    });
  }
  // Best matches first.
  out.sort((a, b) => b.score - a.score);
  return out;
}

function dateWindow(centerIsoDate, days) {
  const d = new Date(centerIsoDate);
  const f = new Date(d);
  f.setUTCDate(f.getUTCDate() - days);
  const t = new Date(d);
  t.setUTCDate(t.getUTCDate() + days);
  return { from: f.toISOString().slice(0, 10), to: t.toISOString().slice(0, 10) };
}

// =====================================================================
// Match / categorise / ignore
// =====================================================================

async function loadBankTx(id, tx) {
  const db = tx || getDb();
  const { bankTransactions } = getSchema();
  const rows = await db
    .select()
    .from(bankTransactions)
    .where(eq(bankTransactions.id, id))
    .limit(1);
  if (!rows[0]) throw new Error(`bank transaction ${id} not found`);
  return rows[0];
}

async function loadBankAccount(id, tx) {
  const db = tx || getDb();
  const { bankAccounts } = getSchema();
  const rows = await db.select().from(bankAccounts).where(eq(bankAccounts.id, id)).limit(1);
  if (!rows[0]) throw new Error(`bank account ${id} not found`);
  return rows[0];
}

/**
 * Match an unmatched (positive) bank line to an outstanding invoice.
 * Posts an `invoice_payment` journal via the Stage 1 helper, then sets
 * the bank line's status to 'matched' and links matchedJournalId.
 */
async function matchTransactionToInvoice(args, opts = {}) {
  const { bankTxId, invoiceId, customerName, debtorsCode = '1100' } = args;
  if (!bankTxId) throw new Error('bankTxId required');
  if (!invoiceId) throw new Error('invoiceId required');

  const db = getDb();
  return db.transaction(async (tx) => {
    const btx = await loadBankTx(bankTxId, tx);
    if (btx.status !== 'unmatched') {
      throw new Error(`bank transaction ${bankTxId} is already ${btx.status}`);
    }
    if (btx.amountPence <= 0) {
      throw new Error('matchTransactionToInvoice: only inflows can be matched to invoices');
    }
    const ba = await loadBankAccount(btx.bankAccountId, tx);
    // Post the invoice-payment journal directly so we can use the bank
    // account's PINNED ledger account (which may not be 0800 — e.g. a
    // user with two bank accounts will pin one to 0800 and a second to a
    // user-created '0801' or similar).
    const debtors = await getAccountByCode(btx.entityId, debtorsCode, { tx });
    const j = await postJournal(
      {
        entityId: btx.entityId,
        date: btx.date,
        description: `Payment received for invoice ${invoiceId}${customerName ? ' — ' + customerName : ''}`,
        source: 'invoice_payment',
        sourceType: 'invoice_payment',
        sourceId: invoiceId,
        currency: ba.currency || 'GBP',
        createdBy: opts.actor?.userId || null,
        lines: [
          { accountId: ba.ledgerAccountId, debit: btx.amountPence, credit: 0, memo: customerName || btx.counterparty || null },
          { accountId: debtors.id, debit: 0, credit: btx.amountPence, memo: customerName || btx.counterparty || null },
        ],
      },
      { tx, actor: opts.actor }
    );
    // Update bank tx status.
    const { bankTransactions } = getSchema();
    await tx
      .update(bankTransactions)
      .set({
        status: 'matched',
        matchedJournalId: j.id,
        matchedAt: new Date(),
        matchedBy: opts.actor?.userId || null,
        updatedAt: new Date(),
      })
      .where(eq(bankTransactions.id, bankTxId));
    await audit(
      {
        action: 'bank.transaction.match_invoice',
        actorUserId: opts.actor?.userId || null,
        actorEmail: opts.actor?.email,
        actorRole: opts.actor?.role,
        resourceType: 'bank_transaction',
        resourceId: bankTxId,
        entityId: btx.entityId,
        after: { invoiceId, journalId: j.id, amountPence: btx.amountPence },
      },
      { tx }
    );
    return { journalId: j.id };
  });
}

/**
 * For lines that aren't an invoice payment: post a fresh expense (out) or
 * generic income (in) journal against a user-specified CoA account, and
 * mark the bank line `posted`.
 *
 * Inflows post:   DR <bank-ledger-account>   CR <income code>
 * Outflows post:  DR <expense code>          CR <bank-ledger-account>
 */
async function categoriseTransaction(args, opts = {}) {
  const { bankTxId, accountCode, vendorOrPayer } = args;
  if (!bankTxId) throw new Error('bankTxId required');
  if (!accountCode) throw new Error('accountCode required');
  const db = getDb();
  return db.transaction(async (tx) => {
    const btx = await loadBankTx(bankTxId, tx);
    if (btx.status !== 'unmatched') {
      throw new Error(`bank transaction ${bankTxId} is already ${btx.status}`);
    }
    const ba = await loadBankAccount(btx.bankAccountId, tx);
    const otherSide = await getAccountByCode(btx.entityId, accountCode, { tx });
    const amount = Math.abs(btx.amountPence);
    const isInflow = btx.amountPence > 0;
    const lines = isInflow
      ? [
          { accountId: ba.ledgerAccountId, debit: amount, credit: 0, memo: vendorOrPayer || btx.counterparty || null },
          { accountId: otherSide.id, debit: 0, credit: amount, memo: btx.description },
        ]
      : [
          { accountId: otherSide.id, debit: amount, credit: 0, memo: btx.description },
          { accountId: ba.ledgerAccountId, debit: 0, credit: amount, memo: vendorOrPayer || btx.counterparty || null },
        ];
    const j = await postJournal(
      {
        entityId: btx.entityId,
        date: btx.date,
        description: btx.description || (isInflow ? 'Bank receipt' : 'Bank payment'),
        source: 'bank',
        sourceType: isInflow ? 'bank_receipt' : 'bank_payment',
        sourceId: btx.id,
        currency: ba.currency || 'GBP',
        createdBy: opts.actor?.userId || null,
        lines,
      },
      { tx, actor: opts.actor }
    );
    const { bankTransactions } = getSchema();
    await tx
      .update(bankTransactions)
      .set({
        status: 'posted',
        matchedJournalId: j.id,
        matchedAt: new Date(),
        matchedBy: opts.actor?.userId || null,
        updatedAt: new Date(),
      })
      .where(eq(bankTransactions.id, bankTxId));
    // Stage 3 — every accepted categorisation feeds merchant memory so
    // the next sighting of "AMAZON UK" auto-suggests the same code.
    // Lazy-required to avoid a require-cycle with rules.js.
    try {
      const { recordMerchantMemory } = require('./rules');
      await recordMerchantMemory(btx.entityId, btx, otherSide.id, { tx });
    } catch (memErr) {
      // Memory write is best-effort — never block the categorisation.
      // The audit row below still captures the user's intent.
      if (opts.logger) opts.logger.warn({ err: memErr.message }, 'merchant memory write failed');
    }
    await audit(
      {
        action: 'bank.transaction.categorise',
        actorUserId: opts.actor?.userId || null,
        actorEmail: opts.actor?.email,
        actorRole: opts.actor?.role,
        resourceType: 'bank_transaction',
        resourceId: bankTxId,
        entityId: btx.entityId,
        after: { accountCode, journalId: j.id, amountPence: btx.amountPence },
      },
      { tx }
    );
    return { journalId: j.id };
  });
}

async function ignoreTransaction(bankTxId, reason, opts = {}) {
  const db = getDb();
  const { bankTransactions } = getSchema();
  return db.transaction(async (tx) => {
    const btx = await loadBankTx(bankTxId, tx);
    if (btx.status !== 'unmatched') {
      throw new Error(`bank transaction ${bankTxId} is already ${btx.status}`);
    }
    await tx
      .update(bankTransactions)
      .set({ status: 'ignored', ignoredReason: reason || null, updatedAt: new Date() })
      .where(eq(bankTransactions.id, bankTxId));
    await audit(
      {
        action: 'bank.transaction.ignore',
        actorUserId: opts.actor?.userId || null,
        resourceType: 'bank_transaction',
        resourceId: bankTxId,
        entityId: btx.entityId,
        after: { reason: reason || null },
      },
      { tx }
    );
    return { ok: true };
  });
}

/**
 * List bank transactions for a bank account, optionally filtered by status.
 * Useful for the (future) reconciliation UI; ordered by date desc.
 */
async function listTransactions(args, opts = {}) {
  const { bankAccountId, status, limit = 100, offset = 0 } = args;
  if (!bankAccountId) throw new Error('bankAccountId required');
  const db = opts.tx || getDb();
  const { bankTransactions } = getSchema();
  const where = status
    ? and(eq(bankTransactions.bankAccountId, bankAccountId), eq(bankTransactions.status, status))
    : eq(bankTransactions.bankAccountId, bankAccountId);
  const rows = await db
    .select()
    .from(bankTransactions)
    .where(where)
    .orderBy(desc(bankTransactions.date), asc(bankTransactions.id))
    .limit(limit)
    .offset(offset);
  return rows;
}

module.exports = {
  dedupeHash,
  createBankConnection,
  createBankAccount,
  importTransactions,
  suggestMatches,
  matchTransactionToInvoice,
  categoriseTransaction,
  ignoreTransaction,
  listTransactions,
};
