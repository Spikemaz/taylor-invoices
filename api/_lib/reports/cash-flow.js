/**
 * Stage 8 — Cash Flow Statement (indirect method).
 *
 * Operating cash = Net profit
 *                + non-cash items (depreciation, code 8000)
 *                − Δ Trade Debtors  (1100)
 *                + Δ Trade Creditors (2100)
 *
 * Δ X = closing − opening, computed by signed-balance on the control
 * account. An increase in receivables consumes cash; an increase in
 * payables conserves cash.
 *
 * For the foundation slice we only model the operating section. The
 * "investing" and "financing" sections are returned as empty arrays so
 * the caller's report shape is stable. We also report opening / closing
 * cash (sum of all asset accounts of subtype "bank/cash") so the
 * report includes a self-consistency line:
 *
 *     openingCash + operatingCash + investingCash + financingCash
 *       === closingCash
 *
 * In the smoke we drive only operating activity, so the equality holds
 * exactly. When the engine grows real investing/financing, those
 * sections will pick up the slack.
 */

const { getDb, getSchema } = require('../db');
const { sql, and, eq, like } = require('drizzle-orm');
const { profitAndLoss } = require('../ledger/reports');
const { getAccountByCode } = require('../ledger/accounts');

// "Cash" accounts in our UK Chart of Accounts live in the 08xx block
// (0800 Bank Account, 0810 Cash in Hand, 0820 …). We resolve the set
// dynamically per entity so a user-added bank/cash account is included
// in the reconciliation automatically.
async function listCashAccounts(entityId) {
  const db = getDb();
  const { accounts } = getSchema();
  return db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(
      and(
        eq(accounts.entityId, entityId),
        eq(accounts.type, 'asset'),
        like(accounts.code, '08%')
      )
    );
}

async function accountBalanceAt(entityId, accountCode, asOfDate) {
  const acc = await getAccountByCode(entityId, accountCode).catch(() => null);
  if (!acc) return { code: accountCode, debitPence: 0, creditPence: 0, balancePence: 0 };
  const db = getDb();
  const { journalLines } = getSchema();
  const rows = await db.execute(sql`
    SELECT
      COALESCE(SUM(debit_pence), 0)::bigint AS debit_pence,
      COALESCE(SUM(credit_pence), 0)::bigint AS credit_pence
    FROM ${journalLines}
    WHERE entity_id = ${entityId}
      AND account_id = ${acc.id}
      AND date <= ${asOfDate}
  `);
  const raw = Array.isArray(rows) ? rows : rows.rows || [];
  const debit = Number(raw[0]?.debit_pence) || 0;
  const credit = Number(raw[0]?.credit_pence) || 0;
  // For asset/expense the balance is debit - credit; for liability/income
  // it's credit - debit. The caller knows which it expects.
  return { code: accountCode, accountId: acc.id, debitPence: debit, creditPence: credit, balancePence: debit - credit };
}

async function cashFlow({ entityId, from, to }) {
  if (!entityId || !from || !to) throw new Error('cashFlow: entityId/from/to required');

  const pl = await profitAndLoss(entityId, { from, to });
  const netProfit = pl.netProfitPence;

  // Non-cash add-backs
  const depExpense = await accountBalanceAt(entityId, '8000', to);
  const depExpenseOpening = await accountBalanceAt(entityId, '8000', dayBefore(from));
  const depreciationPence = depExpense.balancePence - depExpenseOpening.balancePence;

  // Working-capital deltas
  const arOpen = await accountBalanceAt(entityId, '1100', dayBefore(from));
  const arClose = await accountBalanceAt(entityId, '1100', to);
  const apOpen = await accountBalanceAt(entityId, '2100', dayBefore(from));
  const apClose = await accountBalanceAt(entityId, '2100', to);

  // AR is asset (debit - credit); AP is liability (credit - debit).
  const arDelta = arClose.balancePence - arOpen.balancePence;
  const apDelta = -1 * (apClose.balancePence - apOpen.balancePence);

  const operatingCashPence = netProfit + depreciationPence - arDelta + apDelta;

  // Cash position — sum of every bank/cash account on this entity
  // (asset accounts whose code starts with 08, the UK CoA convention).
  const cashAccounts = await listCashAccounts(entityId);
  let openingCash = 0;
  let closingCash = 0;
  for (const ca of cashAccounts) {
    const before = await accountBalanceAt(entityId, ca.code, dayBefore(from));
    const after = await accountBalanceAt(entityId, ca.code, to);
    openingCash += before.balancePence;
    closingCash += after.balancePence;
  }

  const investingCashPence = 0;
  const financingCashPence = 0;
  const reconcileExpected = openingCash + operatingCashPence + investingCashPence + financingCashPence;
  const reconciles = reconcileExpected === closingCash;

  return {
    from,
    to,
    operating: {
      netProfitPence: netProfit,
      depreciationPence,
      arDeltaPence: arDelta,
      apDeltaPence: apDelta,
      totalPence: operatingCashPence,
    },
    investing: { rows: [], totalPence: investingCashPence },
    financing: { rows: [], totalPence: financingCashPence },
    cash: {
      openingPence: openingCash,
      closingPence: closingCash,
      reconciles,
      differencePence: closingCash - reconcileExpected,
    },
  };
}

function dayBefore(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

module.exports = { cashFlow };
