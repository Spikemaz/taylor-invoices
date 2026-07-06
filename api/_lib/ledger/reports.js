/**
 * Stage 1 — Reports library.
 *
 * Three reports, all served from the journal_lines table:
 *
 *   - trialBalance(entityId, asOfDate?)
 *       For each account: sum of debits, sum of credits, signed balance.
 *       The Trial Balance MUST balance — total debits === total credits.
 *
 *   - profitAndLoss(entityId, { from, to })
 *       Sums income and expense accounts over the period.
 *       Returns { income, expenses, netProfit } in pence.
 *
 *   - balanceSheet(entityId, asOfDate)
 *       Sums asset / liability / equity accounts at a point in time.
 *       Includes "Net profit (current period)" in equity so the sheet
 *       balances even if no period has been closed yet.
 *
 * All amounts returned in pence (integers). Callers format for display.
 */

const { getDb, getSchema } = require('../db');
const { sql, and, eq, lte, gte } = require('drizzle-orm');
const { signedBalance } = require('./accounts');

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Trial Balance.
 *
 * @param {string} entityId
 * @param {string} [asOfDate]  ISO date (YYYY-MM-DD); defaults to today.
 * @returns {Promise<{
 *   asOfDate: string,
 *   rows: Array<{
 *     accountId: string, code: string, name: string, type: string,
 *     debitPence: number, creditPence: number, balancePence: number,
 *     normalSide: 'debit' | 'credit',
 *   }>,
 *   totals: { debitPence: number, creditPence: number, isBalanced: boolean },
 * }>}
 */
async function trialBalance(entityId, asOfDate) {
  if (!entityId) throw new Error('entityId required');
  const asOf = asOfDate || todayDateString();
  const db = getDb();
  const { accounts, journalLines } = getSchema();

  // One query: left-join accounts with summed lines up to asOf.
  // Drizzle's groupBy doesn't compose great with optional filters, so we
  // hand-build the SQL with template literals.
  const rows = await db.execute(sql`
    SELECT
      a.id            AS account_id,
      a.code          AS code,
      a.name          AS name,
      a.type          AS type,
      a.archived      AS archived,
      COALESCE(SUM(jl.debit_pence), 0)::bigint  AS debit_pence,
      COALESCE(SUM(jl.credit_pence), 0)::bigint AS credit_pence
    FROM ${accounts} a
    LEFT JOIN ${journalLines} jl
      ON jl.account_id = a.id
     AND jl.date <= ${asOf}
    WHERE a.entity_id = ${entityId}
    GROUP BY a.id, a.code, a.name, a.type, a.archived
    ORDER BY a.code
  `);

  // node-postgres returns rows on .rows, neon-http returns the array directly.
  const raw = Array.isArray(rows) ? rows : rows.rows || [];

  const out = raw.map((r) => {
    const debit = Number(r.debit_pence) || 0;
    const credit = Number(r.credit_pence) || 0;
    return {
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      type: r.type,
      archived: !!r.archived,
      debitPence: debit,
      creditPence: credit,
      balancePence: signedBalance(r.type, debit, credit),
      normalSide:
        r.type === 'asset' || r.type === 'expense' ? 'debit' : 'credit',
    };
  });

  const totalDebit = out.reduce((a, r) => a + r.debitPence, 0);
  const totalCredit = out.reduce((a, r) => a + r.creditPence, 0);

  return {
    asOfDate: asOf,
    rows: out,
    totals: {
      debitPence: totalDebit,
      creditPence: totalCredit,
      isBalanced: totalDebit === totalCredit,
    },
  };
}

/**
 * Profit & Loss.
 *
 *  - income accounts (credit-normal):  balance shown as positive
 *  - expense accounts (debit-normal):  balance shown as positive
 *  - netProfitPence = income − expenses
 *
 * @param {string} entityId
 * @param {{from?: string, to?: string}} range  ISO YYYY-MM-DD; defaults: this calendar year
 * @returns {Promise<{from:string,to:string,income:..., expenses:..., netProfitPence:number}>}
 */
async function profitAndLoss(entityId, range = {}) {
  if (!entityId) throw new Error('entityId required');
  const today = todayDateString();
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const from = range.from || yearStart;
  const to = range.to || today;

  const db = getDb();
  const { accounts, journalLines } = getSchema();

  const rows = await db.execute(sql`
    SELECT
      a.id   AS account_id,
      a.code AS code,
      a.name AS name,
      a.type AS type,
      COALESCE(SUM(jl.debit_pence), 0)::bigint  AS debit_pence,
      COALESCE(SUM(jl.credit_pence), 0)::bigint AS credit_pence
    FROM ${accounts} a
    LEFT JOIN ${journalLines} jl
      ON jl.account_id = a.id
     AND jl.date BETWEEN ${from} AND ${to}
    WHERE a.entity_id = ${entityId}
      AND a.type IN ('income', 'expense')
    GROUP BY a.id, a.code, a.name, a.type
    ORDER BY a.code
  `);
  const raw = Array.isArray(rows) ? rows : rows.rows || [];

  const incomeRows = [];
  const expenseRows = [];
  for (const r of raw) {
    const debit = Number(r.debit_pence) || 0;
    const credit = Number(r.credit_pence) || 0;
    const balance = signedBalance(r.type, debit, credit);
    // Skip accounts with zero activity AND zero balance — keeps the report tidy.
    if (debit === 0 && credit === 0) continue;
    const row = {
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      balancePence: balance,
    };
    if (r.type === 'income') incomeRows.push(row);
    else expenseRows.push(row);
  }

  const totalIncomePence = incomeRows.reduce((a, r) => a + r.balancePence, 0);
  const totalExpensePence = expenseRows.reduce((a, r) => a + r.balancePence, 0);

  return {
    from,
    to,
    income: { rows: incomeRows, totalPence: totalIncomePence },
    expenses: { rows: expenseRows, totalPence: totalExpensePence },
    netProfitPence: totalIncomePence - totalExpensePence,
  };
}

/**
 * Balance Sheet.
 *
 * Sums asset / liability / equity at `asOfDate`. To make the sheet
 * balance even when the user hasn't closed a period, we include the
 * net profit since the start of the calendar year as a synthetic
 * "Profit & Loss (period to date)" equity row.
 */
async function balanceSheet(entityId, asOfDate) {
  if (!entityId) throw new Error('entityId required');
  const asOf = asOfDate || todayDateString();
  const db = getDb();
  const { accounts, journalLines } = getSchema();

  const rows = await db.execute(sql`
    SELECT
      a.id   AS account_id,
      a.code AS code,
      a.name AS name,
      a.type AS type,
      COALESCE(SUM(jl.debit_pence), 0)::bigint  AS debit_pence,
      COALESCE(SUM(jl.credit_pence), 0)::bigint AS credit_pence
    FROM ${accounts} a
    LEFT JOIN ${journalLines} jl
      ON jl.account_id = a.id
     AND jl.date <= ${asOf}
    WHERE a.entity_id = ${entityId}
      AND a.type IN ('asset', 'liability', 'equity')
    GROUP BY a.id, a.code, a.name, a.type
    ORDER BY a.code
  `);
  const raw = Array.isArray(rows) ? rows : rows.rows || [];

  const assets = [];
  const liabilities = [];
  const equity = [];
  for (const r of raw) {
    const debit = Number(r.debit_pence) || 0;
    const credit = Number(r.credit_pence) || 0;
    if (debit === 0 && credit === 0) continue;
    const balance = signedBalance(r.type, debit, credit);
    const row = { accountId: r.account_id, code: r.code, name: r.name, balancePence: balance };
    if (r.type === 'asset') assets.push(row);
    else if (r.type === 'liability') liabilities.push(row);
    else equity.push(row);
  }

  // Synthetic retained earnings: net profit over ALL TIME up to asOf.
  // Using all-time profit (not just calendar year) makes the Balance
  // Sheet balance at any historical date — including across year
  // boundaries before periods have been closed. Once the user closes a
  // year and posts a "transfer P&L → retained earnings" closing journal,
  // the prior-year portion shows up in real equity accounts and this
  // synthetic row drops to just the current period's contribution.
  const allTimePL = await profitAndLoss(entityId, { from: '1900-01-01', to: asOf });
  if (allTimePL.netProfitPence !== 0) {
    equity.push({
      accountId: null,
      code: '~PL',
      name: 'Net profit (all time, unclosed)',
      balancePence: allTimePL.netProfitPence,
      synthetic: true,
    });
  }

  const sum = (rs) => rs.reduce((a, r) => a + r.balancePence, 0);
  const assetsTotal = sum(assets);
  const liabilitiesTotal = sum(liabilities);
  const equityTotal = sum(equity);

  return {
    asOfDate: asOf,
    assets: { rows: assets, totalPence: assetsTotal },
    liabilities: { rows: liabilities, totalPence: liabilitiesTotal },
    equity: { rows: equity, totalPence: equityTotal },
    isBalanced: assetsTotal === liabilitiesTotal + equityTotal,
    differencePence: assetsTotal - (liabilitiesTotal + equityTotal),
  };
}

/**
 * Paged journal listing for the admin "journals" tab. Sorted by date desc
 * then created_at desc. Returns headers only (no lines) for performance;
 * `getJournalDetail(id)` fetches the lines on demand.
 */
async function listJournals(entityId, { limit = 50, offset = 0, source } = {}) {
  if (!entityId) throw new Error('entityId required');
  const db = getDb();
  const { journals } = getSchema();
  const conds = [eq(journals.entityId, entityId)];
  if (source) conds.push(eq(journals.source, source));
  const rows = await db
    .select()
    .from(journals)
    .where(and(...conds))
    .orderBy(sql`${journals.date} DESC, ${journals.createdAt} DESC`)
    .limit(Math.min(Number(limit) || 50, 500))
    .offset(Math.max(Number(offset) || 0, 0));
  return rows;
}

async function getJournalDetail(entityId, journalId) {
  if (!entityId) throw new Error('entityId required');
  if (!journalId) throw new Error('journalId required');
  const db = getDb();
  const { journals, journalLines, accounts } = getSchema();
  const headerRows = await db
    .select()
    .from(journals)
    .where(and(eq(journals.entityId, entityId), eq(journals.id, journalId)))
    .limit(1);
  if (!headerRows[0]) return null;
  const lines = await db
    .select({
      id: journalLines.id,
      lineNumber: journalLines.lineNumber,
      accountId: journalLines.accountId,
      accountCode: accounts.code,
      accountName: accounts.name,
      accountType: accounts.type,
      debitPence: journalLines.debitPence,
      creditPence: journalLines.creditPence,
      memo: journalLines.memo,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(eq(journalLines.journalId, journalId))
    .orderBy(journalLines.lineNumber);
  return { ...headerRows[0], lines };
}

module.exports = {
  trialBalance,
  profitAndLoss,
  balanceSheet,
  listJournals,
  getJournalDetail,
};
