/**
 * Stage 1 — Chart of Accounts library.
 *
 * Provides:
 *   - The UK-conventional default Chart of Accounts for sole traders and
 *     Ltd companies (`UK_COA_SOLE_TRADER`, `UK_COA_LIMITED`).
 *   - Helpers to determine the "normal side" of an account (asset+expense
 *     are debit-normal, liability+equity+income are credit-normal).
 *   - `seedAccountsForEntity(entityId, template, { tx })` — idempotent
 *     insert of the template's accounts. Re-running is a no-op (uniqueness
 *     is enforced by the (entity_id, code) unique index).
 *
 * The codes follow the UK SME convention you'll see in Xero / Sage / FreeAgent
 * (8xx assets, 1xxx debtors, 2xxx liabilities, 3xxx equity, 4xxx income,
 * 5xxx-8xxx expenses). External accountants expect this layout, so we keep
 * the codes stable even if users rename the labels.
 */

const crypto = require('crypto');
const { getDb, getSchema } = require('../db');
const { eq, and, inArray } = require('drizzle-orm');

// =====================================================================
// Account-type metadata
// =====================================================================

/**
 * The "normal balance side" of each account type.
 *  - debit-normal: balance increases when debited (assets, expenses).
 *  - credit-normal: balance increases when credited (liabilities, equity, income).
 *
 * Used by reports to flip the sign correctly when summing journal_lines.
 */
const NORMAL_SIDE = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  income: 'credit',
};

function normalSideFor(type) {
  const side = NORMAL_SIDE[type];
  if (!side) throw new Error(`Unknown account type: ${type}`);
  return side;
}

/**
 * Compute an account's signed balance from raw debit/credit totals.
 * Always returns "balance in pence, positive = normal-side balance".
 *
 *   asset/expense:        debits - credits
 *   liability/equity/inc: credits - debits
 */
function signedBalance(type, debitPence, creditPence) {
  const d = Number(debitPence) || 0;
  const c = Number(creditPence) || 0;
  return normalSideFor(type) === 'debit' ? d - c : c - d;
}

// =====================================================================
// UK Chart of Accounts — sole trader template
// =====================================================================
//
// Codes follow the UK SME convention. Every account marked `isSystem:true`
// can be archived but not deleted (preserved for reports), and is the
// default target for the auto-posting library (e.g. invoice → 4000 Sales).

const UK_COA_SOLE_TRADER = [
  // 0xxx — Fixed Assets (kept minimal; user can add specifics)
  { code: '0010', name: 'Office Equipment',          type: 'asset' },
  { code: '0020', name: 'Computer Equipment',        type: 'asset' },
  { code: '0030', name: 'Motor Vehicles',            type: 'asset' },
  { code: '0050', name: 'Accumulated Depreciation',  type: 'asset' },

  // 1xxx — Current Assets
  { code: '1100', name: 'Trade Debtors',             type: 'asset' },
  { code: '1200', name: 'Other Debtors / Prepayments', type: 'asset' },

  // 8xx — Bank & Cash (UK convention puts these in the 800 block)
  { code: '0800', name: 'Bank Account',              type: 'asset' },
  { code: '0810', name: 'Cash in Hand',              type: 'asset' },

  // 2xxx — Current Liabilities
  { code: '2100', name: 'Trade Creditors',           type: 'liability' },
  { code: '2200', name: 'VAT Liability',             type: 'liability' },
  { code: '2300', name: 'Other Creditors / Accruals', type: 'liability' },
  { code: '2900', name: 'Suspense (Unallocated)',    type: 'liability' },

  // 3xxx — Equity
  { code: '3000', name: 'Capital Account',           type: 'equity' },
  { code: '3100', name: 'Drawings',                  type: 'equity' },
  { code: '3900', name: 'Retained Profit',           type: 'equity' },

  // 4xxx — Income
  { code: '4000', name: 'Sales',                     type: 'income' },
  { code: '4100', name: 'Other Income',              type: 'income' },
  { code: '4200', name: 'Interest Received',         type: 'income' },

  // 5xxx — Direct costs
  { code: '5000', name: 'Cost of Sales',             type: 'expense' },
  { code: '5100', name: 'Subcontractor Costs',       type: 'expense' },
  { code: '5200', name: 'Materials / Consumables',   type: 'expense' },

  // 7xxx — Overheads
  { code: '7000', name: 'Office Costs',              type: 'expense' },
  { code: '7100', name: 'Travel & Subsistence',      type: 'expense' },
  { code: '7200', name: 'Motor Expenses',            type: 'expense' },
  { code: '7300', name: 'Use of Home',               type: 'expense' },
  { code: '7400', name: 'Telephone & Internet',      type: 'expense' },
  { code: '7500', name: 'Software & Subscriptions',  type: 'expense' },
  { code: '7600', name: 'Professional Fees',         type: 'expense' },
  { code: '7700', name: 'Bank Charges',              type: 'expense' },
  { code: '7800', name: 'Insurance',                 type: 'expense' },
  { code: '7900', name: 'Bad Debts',                 type: 'expense' },
  { code: '8000', name: 'Depreciation',              type: 'expense' },
  { code: '8100', name: 'Sundry Expenses',           type: 'expense' },
];

// =====================================================================
// UK Chart of Accounts — limited company template
// =====================================================================
//
// Inherits the sole-trader chart, swaps the equity section for the Ltd-Co
// shape (share capital, retained earnings, dividends, director loan), and
// adds payroll/CT liability + director-cost expense lines.

const UK_COA_LIMITED = [
  // Fixed assets — same as sole trader
  { code: '0010', name: 'Office Equipment',          type: 'asset' },
  { code: '0020', name: 'Computer Equipment',        type: 'asset' },
  { code: '0030', name: 'Motor Vehicles',            type: 'asset' },
  { code: '0050', name: 'Accumulated Depreciation',  type: 'asset' },

  // Current assets
  { code: '1100', name: 'Trade Debtors',             type: 'asset' },
  { code: '1200', name: 'Other Debtors / Prepayments', type: 'asset' },

  // Bank
  { code: '0800', name: 'Bank Account',              type: 'asset' },
  { code: '0810', name: 'Cash in Hand',              type: 'asset' },

  // Current liabilities (adds CT, PAYE, DLA)
  { code: '2100', name: 'Trade Creditors',           type: 'liability' },
  { code: '2200', name: 'VAT Liability',             type: 'liability' },
  { code: '2210', name: 'PAYE / NI Liability',       type: 'liability' },
  { code: '2300', name: 'Other Creditors / Accruals', type: 'liability' },
  { code: '2400', name: 'Corporation Tax Liability', type: 'liability' },
  { code: '2500', name: "Director's Loan Account",   type: 'liability' },
  { code: '2900', name: 'Suspense (Unallocated)',    type: 'liability' },

  // Equity (Ltd shape: shares, retained, dividends)
  { code: '3000', name: 'Share Capital',             type: 'equity' },
  { code: '3200', name: 'Retained Earnings',         type: 'equity' },
  { code: '3300', name: 'Dividends Paid',            type: 'equity' },
  { code: '3900', name: 'Profit & Loss (Current Year)', type: 'equity' },

  // Income (same)
  { code: '4000', name: 'Sales',                     type: 'income' },
  { code: '4100', name: 'Other Income',              type: 'income' },
  { code: '4200', name: 'Interest Received',         type: 'income' },

  // Direct costs
  { code: '5000', name: 'Cost of Sales',             type: 'expense' },
  { code: '5100', name: 'Subcontractor Costs',       type: 'expense' },
  { code: '5200', name: 'Materials / Consumables',   type: 'expense' },

  // Overheads (adds director salary + employer NI)
  { code: '7000', name: 'Office Costs',              type: 'expense' },
  { code: '7100', name: 'Travel & Subsistence',      type: 'expense' },
  { code: '7110', name: "Director's Salary",         type: 'expense' },
  { code: '7150', name: "Employer's NI",             type: 'expense' },
  { code: '7200', name: 'Motor Expenses',            type: 'expense' },
  { code: '7400', name: 'Telephone & Internet',      type: 'expense' },
  { code: '7500', name: 'Software & Subscriptions',  type: 'expense' },
  { code: '7600', name: 'Professional Fees',         type: 'expense' },
  { code: '7700', name: 'Bank Charges',              type: 'expense' },
  { code: '7800', name: 'Insurance',                 type: 'expense' },
  { code: '7900', name: 'Bad Debts',                 type: 'expense' },
  { code: '8000', name: 'Depreciation',              type: 'expense' },
  { code: '8100', name: 'Sundry Expenses',           type: 'expense' },
];

const TEMPLATES = {
  sole_trader: UK_COA_SOLE_TRADER,
  limited: UK_COA_LIMITED,
};

function templateFor(entityType) {
  if (TEMPLATES[entityType]) return TEMPLATES[entityType];
  // Partnership / other → fall back to sole trader chart (closest match).
  // Users with bespoke needs (LLPs, charities) can add accounts manually.
  return UK_COA_SOLE_TRADER;
}

// =====================================================================
// Seed runner
// =====================================================================

function newAccountId() {
  return `acc_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Seed the accounts table for an entity using the appropriate UK CoA
 * template. Idempotent: re-running inserts only the codes that don't yet
 * exist for this entity. Returns { inserted, skipped, accounts }.
 *
 *   const { db } = require('../db');
 *   await seedAccountsForEntity(entityId, 'sole_trader');
 *
 * Or transactionally:
 *   await db.transaction(async (tx) =>
 *     seedAccountsForEntity(entityId, 'sole_trader', { tx }));
 *
 * Designed to be called from:
 *   - the onboarding flow (after entity creation) — Stage 1+ wiring
 *   - the admin "seed missing accounts" endpoint
 *   - the backfill script (always idempotent)
 */
async function seedAccountsForEntity(entityId, entityType, opts = {}) {
  if (!entityId) throw new Error('entityId required');
  const template = templateFor(entityType);
  const writer = opts.tx || getDb();
  const { accounts } = getSchema();

  const codes = template.map((a) => a.code);
  const existing = await writer
    .select({ code: accounts.code })
    .from(accounts)
    .where(and(eq(accounts.entityId, entityId), inArray(accounts.code, codes)));
  const existingSet = new Set(existing.map((r) => r.code));

  const toInsert = template
    .filter((a) => !existingSet.has(a.code))
    .map((a) => ({
      id: newAccountId(),
      entityId,
      code: a.code,
      name: a.name,
      type: a.type,
      isSystem: true,
      archived: false,
    }));

  if (toInsert.length > 0) {
    await writer.insert(accounts).values(toInsert);
  }

  return {
    inserted: toInsert.length,
    skipped: existingSet.size,
    template: entityType,
  };
}

/**
 * Resolve an account by (entityId, code). Throws a descriptive error if
 * the account doesn't exist, because that's almost always a programmer
 * mistake (CoA not seeded, or wrong code) and silent fallthrough produces
 * unbalanced ledgers downstream.
 */
async function getAccountByCode(entityId, code, opts = {}) {
  if (!entityId) throw new Error('entityId required');
  if (!code) throw new Error('account code required');
  const writer = opts.tx || getDb();
  const { accounts } = getSchema();
  const rows = await writer
    .select()
    .from(accounts)
    .where(and(eq(accounts.entityId, entityId), eq(accounts.code, code)))
    .limit(1);
  if (!rows[0]) {
    throw new Error(
      `Account ${code} not found for entity ${entityId}. ` +
        `Has the chart of accounts been seeded?`
    );
  }
  return rows[0];
}

/**
 * Create a custom account. `code` must be unique per entity. `isSystem`
 * is forced to false (system accounts can only be added by the seed).
 */
async function createAccount(input, opts = {}) {
  const { entityId, code, name, type, parentId, description } = input;
  if (!entityId) throw new Error('entityId required');
  if (!code) throw new Error('code required');
  if (!name) throw new Error('name required');
  if (!NORMAL_SIDE[type]) throw new Error(`Invalid account type: ${type}`);
  const writer = opts.tx || getDb();
  const { accounts } = getSchema();
  const existing = await writer
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.entityId, entityId), eq(accounts.code, code)))
    .limit(1);
  if (existing[0]) {
    const err = new Error(`Account code ${code} already exists for this entity.`);
    err.code = 'ACCOUNT_CODE_DUPLICATE';
    throw err;
  }
  const row = {
    id: newAccountId(),
    entityId,
    code,
    name,
    type,
    parentId: parentId || null,
    description: description || null,
    isSystem: false,
    archived: false,
  };
  await writer.insert(accounts).values(row);
  return row;
}

/**
 * Update mutable fields on an account: name, description, archived flag.
 * `code` and `type` are intentionally immutable post-creation — changing
 * either would invalidate historical reports.
 */
async function updateAccount(input, opts = {}) {
  const { entityId, accountId, name, description, archived } = input;
  if (!entityId) throw new Error('entityId required');
  if (!accountId) throw new Error('accountId required');
  const writer = opts.tx || getDb();
  const { accounts } = getSchema();
  const patch = { updatedAt: new Date() };
  if (typeof name === 'string') patch.name = name;
  if (typeof description === 'string') patch.description = description;
  if (typeof archived === 'boolean') {
    patch.archived = archived;
    patch.archivedAt = archived ? new Date() : null;
  }
  const result = await writer
    .update(accounts)
    .set(patch)
    .where(and(eq(accounts.entityId, entityId), eq(accounts.id, accountId)))
    .returning();
  if (!result[0]) {
    const err = new Error(`Account ${accountId} not found for entity ${entityId}`);
    err.code = 'ACCOUNT_NOT_FOUND';
    throw err;
  }
  return result[0];
}

module.exports = {
  NORMAL_SIDE,
  normalSideFor,
  signedBalance,
  UK_COA_SOLE_TRADER,
  UK_COA_LIMITED,
  templateFor,
  seedAccountsForEntity,
  getAccountByCode,
  createAccount,
  updateAccount,
};
