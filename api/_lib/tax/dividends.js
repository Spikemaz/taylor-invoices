/**
 * Stage 6 — Dividend register.
 *
 * Slice 1: declare a dividend (DR Dividends Paid, CR Bank — assumes
 * paid same day). Voucher data structure is returned for PDF
 * rendering by a future UI; the rendering itself is out of scope.
 *
 * Cancellation reverses the journal (a future call uses postJournal
 * with negated amounts).
 */

const crypto = require('crypto');
const { and, asc, eq, sql } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { getAccountByCode } = require('../ledger/accounts');
const { postJournal } = require('../ledger/posting');

function newDivId() { return `div_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`; }

async function nextVoucherNumber(entityId, tx) {
  const reader = tx || getDb();
  const { dividends } = getSchema();
  const rows = await reader
    .select({ count: sql`count(*)`.mapWith(Number) })
    .from(dividends)
    .where(eq(dividends.entityId, entityId));
  const n = Number(rows[0]?.count || 0) + 1;
  return `DIV-${String(n).padStart(4, '0')}`;
}

async function declareDividend(input, opts = {}) {
  const required = ['entityId', 'declaredDate', 'totalAmountPence'];
  for (const k of required) if (input[k] == null) throw new Error(`declareDividend: ${k} required`);
  if (!Number.isInteger(input.totalAmountPence) || input.totalAmountPence <= 0) {
    throw new Error('declareDividend: totalAmountPence must be a positive integer');
  }
  const db = getDb();
  return db.transaction(async (tx) => {
    const { dividends } = getSchema();
    const id = newDivId();
    const voucherNumber = input.voucherNumber || (await nextVoucherNumber(input.entityId, tx));
    const sharesIssued = input.sharesIssued || 1;
    const perShareAmountPence = input.perShareAmountPence || Math.floor(input.totalAmountPence / sharesIssued);
    const paymentDate = input.paymentDate || input.declaredDate;

    // Post journal: DR 3300 Dividends Paid, CR 0800 Bank.
    const [divsAcc, bank] = await Promise.all([
      getAccountByCode(input.entityId, '3300'),
      getAccountByCode(input.entityId, '0800'),
    ]);
    if (!divsAcc || !bank) {
      throw new Error('declareDividend: missing 3300 Dividends Paid / 0800 Bank account (Ltd CoA only)');
    }
    const journal = await postJournal({
      entityId: input.entityId,
      date: paymentDate,
      description: `Dividend ${voucherNumber}`,
      source: 'dividend',
      sourceType: 'stage6',
      lines: [
        { accountId: divsAcc.id, debit: input.totalAmountPence, credit: 0 },
        { accountId: bank.id,    debit: 0,                       credit: input.totalAmountPence },
      ],
      tx,
    });

    await tx.insert(dividends).values({
      id,
      entityId: input.entityId,
      declaredDate: input.declaredDate,
      paymentDate,
      voucherNumber,
      sharesIssued,
      perShareAmountPence,
      totalAmountPence: input.totalAmountPence,
      status: 'paid', // slice 1: paid same day
      journalId: journal.id,
      notes: input.notes || null,
      createdBy: opts.actor?.userId || null,
    });
    return { id, voucherNumber, journalId: journal.id };
  });
}

async function listDividends(entityId, opts = {}) {
  const reader = opts.tx || getDb();
  const { dividends } = getSchema();
  return reader
    .select()
    .from(dividends)
    .where(eq(dividends.entityId, entityId))
    .orderBy(asc(dividends.declaredDate));
}

async function totalDividendsForTaxYear(entityId, taxYear, opts = {}) {
  const reader = opts.tx || getDb();
  const { dividends } = getSchema();
  const start = `${taxYear}-04-06`;
  const end   = `${taxYear + 1}-04-05`;
  const rows = await reader
    .select({ total: sql`COALESCE(SUM(${dividends.totalAmountPence}), 0)`.mapWith(Number) })
    .from(dividends)
    .where(
      and(
        eq(dividends.entityId, entityId),
        sql`${dividends.declaredDate} BETWEEN ${start} AND ${end}`,
        sql`${dividends.status} <> 'cancelled'`
      )
    );
  return Number(rows[0]?.total || 0);
}

function buildVoucherData(row, entity) {
  return {
    voucherNumber: row.voucherNumber,
    declaredDate: row.declaredDate,
    paymentDate: row.paymentDate,
    company: { name: entity?.name, registeredNumber: entity?.companiesHouseNumber },
    sharesIssued: row.sharesIssued,
    perShareAmountPence: row.perShareAmountPence,
    totalAmountPence: row.totalAmountPence,
    note: 'No tax has been deducted at source. Recipients should report this dividend on their Self Assessment.',
  };
}

module.exports = { declareDividend, listDividends, totalDividendsForTaxYear, buildVoucherData };
