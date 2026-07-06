/**
 * Stage 1 — Posting library.
 *
 * Every financial event in BooksIQ becomes a balanced double-entry journal
 * via one of these helpers. They:
 *   - validate the period isn't locked
 *   - construct a journal + ≥2 lines whose debits sum to credits
 *   - insert everything in a single transaction
 *   - write an audit row through the same `tx` handle
 *   - return the inserted journal id
 *
 * The DB-side trigger `journal_lines_balanced_trg` (deferred) is the
 * defence-in-depth backstop. The application checks here keep error
 * messages friendly and let us reject obvious bugs before round-tripping
 * to Postgres.
 *
 * All amounts are integer pence. Callers that have decimal pounds should
 * convert with `poundsToPence(12.34) === 1234` (banker's-safe — see below).
 */

const cryptoNode = require('crypto');
const { getDb, getSchema } = require('../db');
const { audit } = require('../audit-log');
const { and, eq, isNotNull, lte, gte, inArray } = require('drizzle-orm');

function inArrayList(col, values) {
  return inArray(col, values);
}
const { getAccountByCode } = require('./accounts');

// =====================================================================
// Money helpers
// =====================================================================

/**
 * Convert pounds (number or string) to pence (integer). Uses string-based
 * rounding to avoid the classic 0.1 + 0.2 = 0.30000000000000004 trap that
 * accountants spot the moment a TB is off by 1p.
 *
 *   poundsToPence(12.34)   === 1234
 *   poundsToPence("12.345") === 1235  (round-half-away-from-zero)
 *   poundsToPence(0)        === 0
 */
function poundsToPence(pounds) {
  if (pounds === null || pounds === undefined || pounds === '') return 0;
  const n = typeof pounds === 'number' ? pounds : parseFloat(pounds);
  if (!Number.isFinite(n)) {
    throw new Error(`poundsToPence: invalid amount ${pounds}`);
  }
  // Multiply with rounding (avoids float drift): take 4dp string, drop the
  // decimal, parse, then round to integer pence.
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  // Use toFixed(4) to capture sub-pence precision before rounding to pence.
  const rounded = Math.round(parseFloat(abs.toFixed(4)) * 100);
  return sign * rounded;
}

function penceToPounds(pence) {
  return (Number(pence) || 0) / 100;
}

function newJournalId() {
  return `jrn_${cryptoNode.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

// =====================================================================
// Period-lock check
// =====================================================================

/**
 * Throws if `date` falls inside a locked period for `entityId`. The DB
 * trigger `journal_lines_period_lock_trg` is the backstop; this gives a
 * better error message before we burn a transaction.
 */
async function assertPeriodOpen(entityId, date, tx) {
  const writer = tx || getDb();
  const { periods } = getSchema();
  const dateStr = toDateString(date);
  const rows = await writer
    .select({ id: periods.id, label: periods.label })
    .from(periods)
    .where(
      and(
        eq(periods.entityId, entityId),
        isNotNull(periods.lockedAt),
        lte(periods.startDate, dateStr),
        gte(periods.endDate, dateStr)
      )
    )
    .limit(1);
  if (rows[0]) {
    const err = new Error(
      `Period "${rows[0].label}" is locked — cannot post a journal dated ${dateStr}.`
    );
    err.code = 'PERIOD_LOCKED';
    throw err;
  }
}

function toDateString(d) {
  if (!d) throw new Error('date required');
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === 'string') {
    // Accept ISO datetime or already-truncated YYYY-MM-DD
    const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  throw new Error(`Invalid date: ${d}`);
}

// =====================================================================
// Core: postJournal — validates and inserts
// =====================================================================

/**
 * Insert a balanced journal + lines in a single transaction. This is the
 * lowest-level helper; the named helpers below (postSale, ...) wrap it
 * with the right account lookups.
 *
 * @param {object} input
 * @param {string} input.entityId
 * @param {string|Date} input.date
 * @param {string} input.description
 * @param {string} input.source       one of `journalSourceEnum`
 * @param {string} [input.sourceType]
 * @param {string} [input.sourceId]
 * @param {string} [input.currency='GBP']
 * @param {string} [input.createdBy]
 * @param {string} [input.notes]
 * @param {Array<{accountId:string, debit:number, credit:number, memo?:string}>} input.lines
 *        Amounts in pence. Per line: exactly one of debit/credit > 0.
 *
 * @param {object} [opts]
 * @param {object} [opts.tx]      Reuse an outer transaction (for the
 *                                backfill script which batches journals).
 * @param {object} [opts.actor]   { userId, email, role, ip, userAgent, requestId }
 * @returns {Promise<{ id: string, lineCount: number }>}
 */
async function postJournal(input, opts = {}) {
  validateJournalShape(input);
  const dateStr = toDateString(input.date);
  const journalId = newJournalId();

  const runner = opts.tx
    ? (cb) => cb(opts.tx)
    : (cb) => getDb().transaction(cb);

  return runner(async (tx) => {
    await assertPeriodOpen(input.entityId, dateStr, tx);

    const { accounts, journals, journalLines } = getSchema();

    // Cross-entity guard: every accountId on every line must belong to
    // input.entityId. The composite FK (account_id, entity_id) →
    // accounts(id, entity_id) is the DB-level backstop; this check just
    // produces a clean error before we burn a transaction.
    const distinctIds = [...new Set(input.lines.map((l) => l.accountId))];
    const found = await tx
      .select({ id: accounts.id, entityId: accounts.entityId, archived: accounts.archived })
      .from(accounts)
      .where(and(eq(accounts.entityId, input.entityId), inArrayList(accounts.id, distinctIds)));
    const foundMap = new Map(found.map((r) => [r.id, r]));
    for (const id of distinctIds) {
      const r = foundMap.get(id);
      if (!r) {
        const err = new Error(
          `Account ${id} does not belong to entity ${input.entityId}`
        );
        err.code = 'ACCOUNT_ENTITY_MISMATCH';
        throw err;
      }
      if (r.archived) {
        const err = new Error(`Account ${id} is archived — cannot post to it.`);
        err.code = 'ACCOUNT_ARCHIVED';
        throw err;
      }
    }
    await tx.insert(journals).values({
      id: journalId,
      entityId: input.entityId,
      date: dateStr,
      description: input.description,
      source: input.source,
      sourceType: input.sourceType || null,
      sourceId: input.sourceId || null,
      currency: input.currency || 'GBP',
      createdBy: input.createdBy || null,
      notes: input.notes || null,
      reversesId: input.reversesId || null,
    });

    const lineRows = input.lines.map((l, i) => ({
      journalId,
      accountId: l.accountId,
      entityId: input.entityId,
      date: dateStr,
      debitPence: Number(l.debit) || 0,
      creditPence: Number(l.credit) || 0,
      memo: l.memo || null,
      lineNumber: i + 1,
    }));
    await tx.insert(journalLines).values(lineRows);

    await audit(
      {
        action: `ledger.${input.source}.post`,
        actorUserId: opts.actor?.userId || null,
        actorEmail: opts.actor?.email,
        actorRole: opts.actor?.role,
        ip: opts.actor?.ip,
        userAgent: opts.actor?.userAgent,
        requestId: opts.actor?.requestId,
        resourceType: 'journal',
        resourceId: journalId,
        entityId: input.entityId,
        after: {
          date: dateStr,
          description: input.description,
          source: input.source,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          lineCount: lineRows.length,
          totalPence: lineRows.reduce((a, l) => a + l.debitPence, 0),
        },
      },
      { tx }
    );

    return { id: journalId, lineCount: lineRows.length };
  });
}

function validateJournalShape(input) {
  if (!input || typeof input !== 'object') throw new Error('input required');
  if (!input.entityId) throw new Error('entityId required');
  if (!input.date) throw new Error('date required');
  if (!input.description) throw new Error('description required');
  if (!input.source) throw new Error('source required');
  if (!Array.isArray(input.lines) || input.lines.length < 2) {
    throw new Error('a journal needs at least 2 lines');
  }
  let totalDebit = 0;
  let totalCredit = 0;
  for (const [i, l] of input.lines.entries()) {
    if (!l.accountId) throw new Error(`line ${i + 1}: accountId required`);
    const d = Number(l.debit) || 0;
    const c = Number(l.credit) || 0;
    if (d < 0 || c < 0) throw new Error(`line ${i + 1}: amounts must be non-negative`);
    if (d > 0 && c > 0) {
      throw new Error(`line ${i + 1}: cannot debit and credit the same line`);
    }
    if (d === 0 && c === 0) throw new Error(`line ${i + 1}: zero-amount line`);
    if (!Number.isInteger(d) || !Number.isInteger(c)) {
      throw new Error(`line ${i + 1}: pence amounts must be integers`);
    }
    totalDebit += d;
    totalCredit += c;
  }
  if (totalDebit !== totalCredit) {
    throw new Error(
      `Journal unbalanced: debits=${totalDebit}p credits=${totalCredit}p (diff ${totalDebit - totalCredit}p)`
    );
  }
}

// =====================================================================
// Named posting helpers
// =====================================================================

/**
 * Post a sale (invoice issued, not yet paid).
 *   DR  Trade Debtors (default 1100)
 *   CR  Sales         (default 4000)
 */
async function postSale(args, opts = {}) {
  const {
    entityId,
    date,
    amountPence,
    invoiceId,
    customerName,
    description,
    salesCode = '4000',
    debtorsCode = '1100',
    createdBy,
    currency = 'GBP',
  } = args;
  if (!Number.isInteger(amountPence) || amountPence <= 0) {
    throw new Error('postSale: amountPence must be a positive integer');
  }
  const tx = opts.tx;
  const debtors = await getAccountByCode(entityId, debtorsCode, { tx });
  const sales = await getAccountByCode(entityId, salesCode, { tx });
  return postJournal(
    {
      entityId,
      date,
      description: description || `Invoice${invoiceId ? ' ' + invoiceId : ''}${customerName ? ' — ' + customerName : ''}`,
      source: 'invoice',
      sourceType: 'invoice',
      sourceId: invoiceId || null,
      currency,
      createdBy,
      lines: [
        { accountId: debtors.id, debit: amountPence, credit: 0, memo: customerName || null },
        { accountId: sales.id, debit: 0, credit: amountPence, memo: customerName || null },
      ],
    },
    opts
  );
}

/**
 * Post a customer payment (invoice settled).
 *   DR  Bank             (default 0800)
 *   CR  Trade Debtors    (default 1100)
 */
async function postPaymentReceived(args, opts = {}) {
  const {
    entityId,
    date,
    amountPence,
    invoiceId,
    customerName,
    description,
    bankCode = '0800',
    debtorsCode = '1100',
    createdBy,
    currency = 'GBP',
  } = args;
  if (!Number.isInteger(amountPence) || amountPence <= 0) {
    throw new Error('postPaymentReceived: amountPence must be a positive integer');
  }
  const tx = opts.tx;
  const bank = await getAccountByCode(entityId, bankCode, { tx });
  const debtors = await getAccountByCode(entityId, debtorsCode, { tx });
  return postJournal(
    {
      entityId,
      date,
      description: description || `Payment received${invoiceId ? ' for invoice ' + invoiceId : ''}${customerName ? ' — ' + customerName : ''}`,
      source: 'invoice_payment',
      // sourceType discriminates the leg of an invoice transaction (sale
      // vs settlement) so the backfill dedupe can tell them apart even
      // after both legs are re-tagged source='backfill_v1'.
      sourceType: 'invoice_payment',
      sourceId: invoiceId || null,
      currency,
      createdBy,
      lines: [
        { accountId: bank.id, debit: amountPence, credit: 0, memo: customerName || null },
        { accountId: debtors.id, debit: 0, credit: amountPence, memo: customerName || null },
      ],
    },
    opts
  );
}

/**
 * Post a business expense paid from bank.
 *   DR  <expense account>
 *   CR  Bank (default 0800)
 */
async function postExpense(args, opts = {}) {
  const {
    entityId,
    date,
    amountPence,
    expenseCode,
    bankCode = '0800',
    vendorName,
    description,
    sourceId,
    createdBy,
    currency = 'GBP',
  } = args;
  if (!expenseCode) throw new Error('postExpense: expenseCode required');
  if (!Number.isInteger(amountPence) || amountPence <= 0) {
    throw new Error('postExpense: amountPence must be a positive integer');
  }
  const tx = opts.tx;
  const expense = await getAccountByCode(entityId, expenseCode, { tx });
  const bank = await getAccountByCode(entityId, bankCode, { tx });
  return postJournal(
    {
      entityId,
      date,
      description: description || `Expense${vendorName ? ' — ' + vendorName : ''}`,
      source: 'expense',
      sourceType: 'expense',
      sourceId: sourceId || null,
      currency,
      createdBy,
      lines: [
        { accountId: expense.id, debit: amountPence, credit: 0, memo: vendorName || null },
        { accountId: bank.id, debit: 0, credit: amountPence, memo: vendorName || null },
      ],
    },
    opts
  );
}

/**
 * Post a transfer between two of the entity's accounts (e.g. bank → cash).
 *   DR  <to account>
 *   CR  <from account>
 */
async function postTransfer(args, opts = {}) {
  const {
    entityId,
    date,
    amountPence,
    fromCode,
    toCode,
    description,
    createdBy,
    currency = 'GBP',
  } = args;
  if (!fromCode || !toCode) throw new Error('postTransfer: fromCode and toCode required');
  if (fromCode === toCode) throw new Error('postTransfer: fromCode and toCode must differ');
  if (!Number.isInteger(amountPence) || amountPence <= 0) {
    throw new Error('postTransfer: amountPence must be a positive integer');
  }
  const tx = opts.tx;
  const from = await getAccountByCode(entityId, fromCode, { tx });
  const to = await getAccountByCode(entityId, toCode, { tx });
  return postJournal(
    {
      entityId,
      date,
      description: description || `Transfer ${fromCode} → ${toCode}`,
      source: 'manual',
      sourceType: 'transfer',
      currency,
      createdBy,
      lines: [
        { accountId: to.id, debit: amountPence, credit: 0 },
        { accountId: from.id, debit: 0, credit: amountPence },
      ],
    },
    opts
  );
}

/**
 * Post an arbitrary manual journal. Caller supplies pre-resolved lines
 * (each with `accountCode` OR `accountId` plus debit/credit in pence).
 * Used by the manual-journal UI in Stage 1+ and by accountants.
 */
async function postManualJournal(args, opts = {}) {
  const {
    entityId,
    date,
    description,
    lines,
    createdBy,
    notes,
    currency = 'GBP',
  } = args;
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error('postManualJournal: at least 2 lines required');
  }
  const tx = opts.tx;
  // Resolve any code-based lines to accountIds. We keep this outside the
  // postJournal call so we can reject bad codes with a per-line error
  // before opening a transaction.
  const resolved = [];
  for (const [i, l] of lines.entries()) {
    let accountId = l.accountId;
    if (!accountId) {
      if (!l.accountCode) {
        throw new Error(`line ${i + 1}: accountId or accountCode required`);
      }
      const acc = await getAccountByCode(entityId, l.accountCode, { tx });
      accountId = acc.id;
    }
    resolved.push({
      accountId,
      debit: Number(l.debit) || 0,
      credit: Number(l.credit) || 0,
      memo: l.memo || null,
    });
  }
  return postJournal(
    {
      entityId,
      date,
      description: description || 'Manual journal',
      source: 'manual',
      sourceType: 'manual',
      currency,
      createdBy,
      notes,
      lines: resolved,
    },
    opts
  );
}

module.exports = {
  poundsToPence,
  penceToPounds,
  postJournal,
  postSale,
  postPaymentReceived,
  postExpense,
  postTransfer,
  postManualJournal,
  assertPeriodOpen,
  toDateString,
};
