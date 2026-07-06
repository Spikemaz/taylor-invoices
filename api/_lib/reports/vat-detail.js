/**
 * Stage 8 — VAT Detail report.
 *
 * Companion to Stage 7's `computeReturn`: instead of returning the 9
 * boxes only, this returns the underlying journal lines that fed each
 * box, grouped by side. Used by the UI's VAT-return preview drill-down
 * and by the year-end snapshot bundle.
 */

const { getDb, getSchema } = require('../db');
const { and, eq, gte, lte, isNull, asc } = require('drizzle-orm');

async function vatDetail({ entityId, periodStart, periodEnd, lockedFilter }) {
  if (!entityId || !periodStart || !periodEnd) {
    throw new Error('vatDetail: entityId/periodStart/periodEnd required');
  }
  const db = getDb();
  const { journalLineVat, journalLines, journals, accounts } = getSchema();
  const conds = [
    eq(journalLineVat.entityId, entityId),
    gte(journalLines.date, periodStart),
    lte(journalLines.date, periodEnd),
  ];
  if (lockedFilter === 'unlocked') conds.push(isNull(journalLineVat.lockedByReturnId));

  const rows = await db
    .select({
      lineId: journalLineVat.journalLineId,
      side: journalLineVat.side,
      ratePct: journalLineVat.ratePct,
      netPence: journalLineVat.netPence,
      vatPence: journalLineVat.vatPence,
      grossPence: journalLineVat.grossPence,
      lockedByReturnId: journalLineVat.lockedByReturnId,
      date: journalLines.date,
      memo: journalLines.memo,
      accountCode: accounts.code,
      accountName: accounts.name,
      journalDescription: journals.description,
      sourceId: journals.sourceId,
    })
    .from(journalLineVat)
    .innerJoin(journalLines, eq(journalLines.id, journalLineVat.journalLineId))
    .innerJoin(journals, eq(journals.id, journalLines.journalId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(...conds))
    .orderBy(asc(journalLines.date), asc(journalLineVat.journalLineId));

  const sides = { output: [], input: [], eu_acquisition: [], eu_dispatch: [] };
  const totals = { output: 0, input: 0, eu_acquisition: 0, eu_dispatch: 0 };
  for (const r of rows) {
    if (!sides[r.side]) continue;
    sides[r.side].push(r);
    totals[r.side] += Number(r.vatPence) || 0;
  }
  return { entityId, periodStart, periodEnd, sides, totals };
}

module.exports = { vatDetail };
