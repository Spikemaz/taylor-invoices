/**
 * BooksIQ Postgres schema — Stage 0 foundations.
 *
 * This file defines the tables that exist BEFORE the Xero-clone ledger lands
 * (Stage 1 adds: chart_of_accounts, transactions, transaction_lines, etc).
 *
 * For Stage 0 we only ship the bedrock: users, entities, auth (magic_links,
 * sessions, rate_limits), audit_log, and jobs. Existing per-user data still
 * lives in Google Sheets and will be ETL'd once the cutover plan is signed off.
 */

import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  bigserial,
  boolean,
  date,
  jsonb,
  numeric,
  index,
  uniqueIndex,
  pgEnum,
  check,
  foreignKey,
  unique,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// =====================================================================
// Enums
// =====================================================================

export const userRoleEnum = pgEnum('user_role', ['user', 'admin']);
export const userStatusEnum = pgEnum('user_status', [
  'pending',
  'active',
  'suspended',
  'deleted',
]);
export const entityTypeEnum = pgEnum('entity_type', [
  'sole_trader',
  'limited',
  'partnership',
  'other',
]);
export const vatSchemeEnum = pgEnum('vat_scheme', [
  'none',
  'standard',
  'flat_rate',
  'cash',
]);
export const jobStateEnum = pgEnum('job_state', [
  'pending',
  'running',
  'done',
  'failed',
  'dead',
]);

// Stage 1 — Chart of Accounts + Double-Entry Ledger
//
// `accountTypeEnum` follows UK CoA conventions (asset/liability/equity/income/
// expense). The "normal side" of each type (debit-normal for asset+expense,
// credit-normal for liability+equity+income) is derived in code rather than
// stored on every row — see api/_lib/ledger/accounts.js.
export const accountTypeEnum = pgEnum('account_type', [
  'asset',
  'liability',
  'equity',
  'income',
  'expense',
]);

// Where the journal came from. Used for drill-down ("show me the source
// document") and for backfill reversibility ("delete every journal whose
// source = 'backfill_v1'").
// Stage 2 — Bank feeds.
export const bankConnectionProviderEnum = pgEnum('bank_connection_provider', [
  'csv',         // user-uploaded CSV (no live connection)
  'pdf',         // PDF statement upload (parsed)
  'gocardless',  // GoCardless Bank Account Data (Open Banking AISP, free)
  'truelayer',
  'plaid',
  'manual',      // hand-keyed
]);
export const bankConnectionStatusEnum = pgEnum('bank_connection_status', [
  'active',
  'disconnected',
  'expired',     // OAuth consent expired (90d for AISP) — re-auth required
  'error',
]);
export const bankTxStatusEnum = pgEnum('bank_tx_status', [
  'unmatched',   // in inbox, no journal yet
  'matched',     // matched to an existing journal (e.g. invoice payment)
  'posted',      // categorise+create posted a fresh journal
  'ignored',     // user marked not-business / transfer / split
]);

export const journalSourceEnum = pgEnum('journal_source', [
  'manual',         // human-posted via the manual-journal UI
  'invoice',        // auto-posted when an invoice is created
  'invoice_payment',// auto-posted when an invoice is marked paid
  'entry',          // auto-posted from a daily timesheet entry
  'expense',        // auto-posted from an expense (Stage 4)
  'bank',           // auto-posted from a bank-feed reconciliation (Stage 2)
  'reversal',       // generated to reverse another journal
  'opening_balance',// posted by the seed script to set day-0 balances
  'backfill_v1',    // synthesised from existing Sheets data during cutover
  'payroll',        // auto-posted by Stage 6 runPayroll
  'dividend',       // auto-posted by Stage 6 declareDividend
]);

// =====================================================================
// users
// =====================================================================

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(), // e.g. "user_abc123"
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: userRoleEnum('role').notNull().default('user'),
    status: userStatusEnum('status').notNull().default('pending'),

    // Legacy Google Sheets back-references — kept during dual-write window so
    // we can fall back to Sheets and so the ETL has a reconciliation key.
    sheetId: text('sheet_id'),
    driveFolderId: text('drive_folder_id'),
    backupSheetId: text('backup_sheet_id'),
    backupFolderId: text('backup_folder_id'),

    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    emailUq: uniqueIndex('users_email_uq').on(sql`lower(${t.email})`),
    statusIdx: index('users_status_idx').on(t.status),
  })
);

// =====================================================================
// entities — a user can own multiple (sole trader + Ltd is the canonical case)
// =====================================================================

export const entities = pgTable(
  'entities',
  {
    id: text('id').primaryKey(), // e.g. "ent_abc123"
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: entityTypeEnum('type').notNull(),
    tradingName: text('trading_name'),
    companyNumber: text('company_number'), // Ltd only
    utr: text('utr'), // Self Assessment / CT UTR
    vatNumber: text('vat_number'),
    vatScheme: vatSchemeEnum('vat_scheme').notNull().default('none'),
    defaultCurrency: text('default_currency').notNull().default('GBP'),
    fiscalYearEnd: text('fiscal_year_end'), // "MM-DD"
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index('entities_user_idx').on(t.userId),
  })
);

// =====================================================================
// magic_links — replaces the MagicLinks tab in each user's sheet
// =====================================================================

export const magicLinks = pgTable(
  'magic_links',
  {
    id: text('id').primaryKey(), // hash of token
    email: text('email').notNull(),
    code: text('code').notNull(), // 6-digit code (also delivered via email)
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    emailIdx: index('magic_links_email_idx').on(t.email, t.expiresAt),
  })
);

// =====================================================================
// sessions — replaces Sessions tab; we keep server-side records so we can
// revoke instantly without waiting for token expiry.
// =====================================================================

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(), // jti
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    issuedAt: timestamp('issued_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId),
    expiresIdx: index('sessions_expires_idx').on(t.expiresAt),
  })
);

// =====================================================================
// rate_limits — replaces in-process map; survives serverless cold starts.
// =====================================================================

export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull().default(0),
    windowStart: timestamp('window_start', { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiresIdx: index('rate_limits_expires_idx').on(t.expiresAt),
  })
);

// =====================================================================
// audit_log — every mutation. Required for HMRC defensibility.
// =====================================================================

export const auditLog = pgTable(
  'audit_log',
  {
    // mode:'number' so Drizzle returns JS Number (safe up to 2^53 ≈ 9e15;
    // at 100 audit rows/user/day for 10k users that's ~270 years before we
    // hit the limit). Avoids the BigInt-not-JSON-serializable footgun in
    // admin endpoints.
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),

    // "Who" — null actor means SYSTEM (cron, ETL, etc.)
    actorUserId: text('actor_user_id'),
    actorEmail: text('actor_email'),
    actorRole: text('actor_role'),

    // When an admin uses master-override to act AS another user.
    onBehalfOfUserId: text('on_behalf_of_user_id'),

    // "What"
    action: text('action').notNull(), // e.g. "invoice.create", "auth.login"
    resourceType: text('resource_type'), // "invoice" | "entry" | "user" | ...
    resourceId: text('resource_id'),
    entityId: text('entity_id'),

    // "How / where"
    ip: text('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),

    // "What changed"
    before: jsonb('before'),
    after: jsonb('after'),
    diff: jsonb('diff'),
    metadata: jsonb('metadata'),
  },
  (t) => ({
    actorTsIdx: index('audit_log_actor_ts_idx').on(t.actorUserId, t.ts),
    resourceTsIdx: index('audit_log_resource_ts_idx').on(
      t.resourceType,
      t.resourceId,
      t.ts
    ),
    entityTsIdx: index('audit_log_entity_ts_idx').on(t.entityId, t.ts),
    actionTsIdx: index('audit_log_action_ts_idx').on(t.action, t.ts),
  })
);

// =====================================================================
// jobs — durable queue for cron / async work
// (sheet_export, bank_fetch, mtd_submit, ocr_extract, …)
// =====================================================================

export const jobs = pgTable(
  'jobs',
  {
    // mode:'number' — see audit_log.id rationale.
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull().default({}),
    state: jobStateEnum('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    lastError: text('last_error'),
    result: jsonb('result'),
    userId: text('user_id'),
    entityId: text('entity_id'),
    dedupeKey: text('dedupe_key'), // optional — prevents duplicate scheduling
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pickIdx: index('jobs_pick_idx').on(t.state, t.scheduledFor),
    kindStateIdx: index('jobs_kind_state_idx').on(t.kind, t.state),
    userIdx: index('jobs_user_idx').on(t.userId),
    dedupeUq: uniqueIndex('jobs_dedupe_uq')
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
  })
);

// =====================================================================
// job_locks — prevents two workers running the same kind concurrently
// =====================================================================

export const jobLocks = pgTable('job_locks', {
  kind: text('kind').primaryKey(),
  lockedAt: timestamp('locked_at', { withTimezone: true }).notNull(),
  lockedBy: text('locked_by').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// =====================================================================
// Stage 1 — accounts (Chart of Accounts)
// =====================================================================
// Money is integer pence (bigint mode:'number' across the ledger). `code`
// is the UK-conventional 3-4 digit code, unique per entity. The (id,
// entity_id) unique constraint is the FK target used by journal_lines
// to enforce — at the DB level — that lines reference accounts of their
// own entity (no cross-tenant leakage).

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: accountTypeEnum('type').notNull(),
    parentId: text('parent_id'),
    description: text('description'),
    isSystem: boolean('is_system').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    // Stage 5 — UK tax engine. NULL means "default for the account type"
    // (income → taxable, expense → allowable). Set 'disallowable' to
    // add the account back when computing taxable trading profit, etc.
    // 'allowable' | 'disallowable' | 'capital' | 'private_addback'
    taxTreatment: text('tax_treatment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityCodeUq: uniqueIndex('accounts_entity_code_uq').on(t.entityId, t.code),
    entityTypeIdx: index('accounts_entity_type_idx').on(t.entityId, t.type),
    parentIdx: index('accounts_parent_idx').on(t.parentId),
    // FK target for journal_lines composite FK (cross-entity guard).
    idEntityUq: unique('accounts_id_entity_uq').on(t.id, t.entityId),
  })
);

// =====================================================================
// Stage 1 — periods (closed/locked accounting periods)
// =====================================================================
// `lockedAt` set ⇒ no journal_lines may be inserted/updated/deleted with
// a date inside [startDate, endDate]. Enforced by the posting library and
// the journal_lines_period_lock_trg trigger.

export const periods = pgTable(
  'periods',
  {
    id: text('id').primaryKey(), // "per_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    label: text('label').notNull(), // e.g. "FY2025-04 to 2026-03", "Apr 2025"
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'), // userId of the admin/accountant who locked
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    entityRangeUq: uniqueIndex('periods_entity_range_uq').on(
      t.entityId,
      t.startDate,
      t.endDate
    ),
    entityEndIdx: index('periods_entity_end_idx').on(t.entityId, t.endDate),
    // Sanity: a period must have a positive length.
    rangeChk: check('periods_range_chk', sql`${t.endDate} >= ${t.startDate}`),
  })
);

// =====================================================================
// Stage 1 — journals (double-entry transactions)
// =====================================================================
// A journal is one accounting event. Must contain ≥2 lines with
// SUM(debit)=SUM(credit) — enforced application-side and by the deferred
// `journal_lines_balanced_trg` constraint trigger. `source`+`sourceType`+
// `sourceId` enable drill-down to the originating document. `reversesId`
// links a corrective reversal journal to the one it cancels.

export const journals = pgTable(
  'journals',
  {
    id: text('id').primaryKey(), // "jrn_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    description: text('description').notNull(),
    source: journalSourceEnum('source').notNull(),
    sourceType: text('source_type'), // free-text refinement (e.g. 'invoice', 'entry')
    sourceId: text('source_id'),     // FK-ish (kept loose; soft-references the source row)
    currency: text('currency').notNull().default('GBP'),
    createdBy: text('created_by'),   // userId, null = SYSTEM
    reversesId: text('reverses_id'), // self-FK (the journal this one reverses)
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // The two indexes called for in the task spec — every report scans by
    // (entity_id, date) and every account drill-down scans by (account_id,
    // date) (the latter is on journal_lines, see below).
    entityDateIdx: index('journals_entity_date_idx').on(t.entityId, t.date),
    sourceIdx: index('journals_source_idx').on(
      t.entityId,
      t.source,
      t.sourceId
    ),
    reversesIdx: index('journals_reverses_idx').on(t.reversesId),
  })
);

// =====================================================================
// Stage 1 — journal_lines (individual debit / credit postings)
// =====================================================================
// Each line debits OR credits exactly one account; non-negative; exactly
// one of debit/credit > 0. `entityId` and `date` are denormalised from
// the parent journal for fast report queries. The composite FK
// (account_id, entity_id) → accounts(id, entity_id) makes cross-tenant
// account references impossible at the DB level.

export const journalLines = pgTable(
  'journal_lines',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    journalId: text('journal_id')
      .notNull()
      .references(() => journals.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    entityId: text('entity_id').notNull(),
    date: date('date').notNull(),
    debitPence: bigint('debit_pence', { mode: 'number' }).notNull().default(0),
    creditPence: bigint('credit_pence', { mode: 'number' }).notNull().default(0),
    memo: text('memo'),
    lineNumber: integer('line_number').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    journalIdx: index('journal_lines_journal_idx').on(t.journalId),
    accountDateIdx: index('journal_lines_account_date_idx').on(t.accountId, t.date),
    entityDateIdx: index('journal_lines_entity_date_idx').on(t.entityId, t.date),
    accountFk: foreignKey({
      name: 'journal_lines_account_entity_fk',
      columns: [t.accountId, t.entityId],
      foreignColumns: [accounts.id, accounts.entityId],
    }).onDelete('restrict'),
    nonNeg: check(
      'journal_lines_non_negative_chk',
      sql`${t.debitPence} >= 0 AND ${t.creditPence} >= 0`
    ),
    sideExclusive: check(
      'journal_lines_side_exclusive_chk',
      sql`NOT (${t.debitPence} > 0 AND ${t.creditPence} > 0)`
    ),
    nonZero: check(
      'journal_lines_non_zero_chk',
      sql`${t.debitPence} > 0 OR ${t.creditPence} > 0`
    ),
  })
);

// =====================================================================
// Type exports for application code
// =====================================================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type MagicLink = typeof magicLinks.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLog = typeof auditLog.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Journal = typeof journals.$inferSelect;
export type NewJournal = typeof journals.$inferInsert;
export type JournalLine = typeof journalLines.$inferSelect;
export type NewJournalLine = typeof journalLines.$inferInsert;
export type Period = typeof periods.$inferSelect;
export type NewPeriod = typeof periods.$inferInsert;

// =====================================================================
// Stage 2 — bank_connections (one row per linked bank / CSV upload source)
// =====================================================================
// `csv` and `pdf` rows are sentinel "containers" so a CSV-imported account
// has a connection to attach lastSyncAt timestamps and audit history to.
// Online providers (gocardless etc.) store their refresh-token blob
// encrypted in `credentialsCiphertext` (caller is responsible for the
// encryption — we never log this column).

export const bankConnections = pgTable(
  'bank_connections',
  {
    id: text('id').primaryKey(), // "bcn_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    provider: bankConnectionProviderEnum('provider').notNull(),
    institutionId: text('institution_id'),       // GoCardless/Plaid institution id
    institutionName: text('institution_name'),   // human-readable bank name
    status: bankConnectionStatusEnum('status').notNull().default('active'),
    credentialsCiphertext: text('credentials_ciphertext'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastSyncError: text('last_sync_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index('bank_connections_entity_idx').on(t.entityId),
    statusIdx: index('bank_connections_status_idx').on(t.status),
  })
);

// =====================================================================
// Stage 2 — bank_accounts (one row per bank account inside a connection)
// =====================================================================
// Each bank account is pinned to a CoA "bank/cash" account (assets, code
// 0800 by default). Posting a matched bank transaction debits/credits
// THIS ledger account; the dashboard reconciles the bank balance against
// SUM(journal_lines for ledgerAccountId).

export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: text('id').primaryKey(), // "bka_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id'),         // soft-FK; null after disconnect
    ledgerAccountId: text('ledger_account_id').notNull(),
    name: text('name').notNull(),                // "Starling Personal", "HSBC Business"
    accountNumberLast4: text('account_number_last4'),
    sortCode: text('sort_code'),
    currency: text('currency').notNull().default('GBP'),
    openingBalancePence: bigint('opening_balance_pence', { mode: 'number' })
      .notNull()
      .default(0),
    openingBalanceDate: date('opening_balance_date'),
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index('bank_accounts_entity_idx').on(t.entityId),
    connectionIdx: index('bank_accounts_connection_idx').on(t.connectionId),
    // Cross-entity guard — the bank account's ledger account MUST belong
    // to the same entity as the bank account itself.
    ledgerAccountFk: foreignKey({
      name: 'bank_accounts_ledger_account_fk',
      columns: [t.ledgerAccountId, t.entityId],
      foreignColumns: [accounts.id, accounts.entityId],
    }).onDelete('restrict'),
    // FK target for bank_transactions (cross-entity guard).
    idEntityUq: unique('bank_accounts_id_entity_uq').on(t.id, t.entityId),
  })
);

// =====================================================================
// Stage 2 — bank_transactions (the inbox)
// =====================================================================
// One row per imported bank line. Amount is signed pence (positive = money
// IN, negative = money OUT). `dedupeHash` is SHA-256 over a canonicalised
// (date|amount|description|reference) — uniqueness is per bank_account so
// re-uploading the same statement adds zero rows. `matchedJournalId` is
// a SOFT reference to journals.id (no FK so reversing journals doesn't
// cascade-delete bank lines from the inbox).

export const bankTransactions = pgTable(
  'bank_transactions',
  {
    id: text('id').primaryKey(), // "btx_..."
    entityId: text('entity_id').notNull(),
    bankAccountId: text('bank_account_id').notNull(),
    date: date('date').notNull(),
    amountPence: bigint('amount_pence', { mode: 'number' }).notNull(),
    description: text('description').notNull(),
    counterparty: text('counterparty'),
    reference: text('reference'),
    rawPayload: jsonb('raw_payload'),
    dedupeHash: text('dedupe_hash').notNull(),
    status: bankTxStatusEnum('status').notNull().default('unmatched'),
    matchedJournalId: text('matched_journal_id'),
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    matchedBy: text('matched_by'),
    ignoredReason: text('ignored_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityDateIdx: index('bank_transactions_entity_date_idx').on(t.entityId, t.date),
    bankAccountDateIdx: index('bank_transactions_bank_account_date_idx').on(
      t.bankAccountId,
      t.date
    ),
    statusIdx: index('bank_transactions_status_idx').on(t.bankAccountId, t.status),
    dedupeUq: uniqueIndex('bank_transactions_dedupe_uq').on(
      t.bankAccountId,
      t.dedupeHash
    ),
    bankAccountFk: foreignKey({
      name: 'bank_transactions_bank_account_entity_fk',
      columns: [t.bankAccountId, t.entityId],
      foreignColumns: [bankAccounts.id, bankAccounts.entityId],
    }).onDelete('cascade'),
    amountNonZero: check(
      'bank_transactions_amount_nonzero_chk',
      sql`${t.amountPence} <> 0`
    ),
  })
);

export type BankConnection = typeof bankConnections.$inferSelect;
export type NewBankConnection = typeof bankConnections.$inferInsert;
export type BankAccount = typeof bankAccounts.$inferSelect;
export type NewBankAccount = typeof bankAccounts.$inferInsert;
export type BankTransaction = typeof bankTransactions.$inferSelect;
export type NewBankTransaction = typeof bankTransactions.$inferInsert;

// =====================================================================
// Stage 3 — auto-categorisation engine
// =====================================================================
// Two surfaces:
//   * `bank_rules`     — explicit IF/THEN rules ordered by priority.
//                        `source='system'` is the seeded UK default
//                        library; `source='user'` is a hand-written rule.
//                        `source='learned'` is auto-promoted from
//                        merchant memory (Stage 3 slice 2 territory).
//   * `merchant_memory`— per-(entity, normalised-merchant-signature)
//                        memory of "this user always categorises this
//                        merchant as X". Updated every time the user
//                        accepts an AI/rule suggestion or categorises
//                        a line manually.
//
// Conditions and actions live in JSONB so the engine can grow without a
// schema change. Shapes are documented in api/_lib/bank/rules.js.

export const bankRuleSourceEnum = pgEnum('bank_rule_source', [
  'system',
  'user',
  'learned',
]);

export const bankRules = pgTable(
  'bank_rules',
  {
    id: text('id').primaryKey(), // "br_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    source: bankRuleSourceEnum('source').notNull().default('user'),
    priority: integer('priority').notNull().default(100), // lower = matched first
    conditions: jsonb('conditions').notNull(),
    action: jsonb('action').notNull(),
    active: boolean('active').notNull().default(true),
    timesApplied: integer('times_applied').notNull().default(0),
    lastAppliedAt: timestamp('last_applied_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityActiveIdx: index('bank_rules_entity_active_idx').on(
      t.entityId,
      t.active,
      t.priority
    ),
  })
);

export const merchantMemory = pgTable(
  'merchant_memory',
  {
    id: text('id').primaryKey(), // "mm_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    merchantSignature: text('merchant_signature').notNull(), // normalised
    accountId: text('account_id').notNull(),
    hitsCount: integer('hits_count').notNull().default(1),
    confidence: integer('confidence').notNull().default(60), // 0–100, slice 1 baseline
    lastUsed: timestamp('last_used', { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entitySigUq: uniqueIndex('merchant_memory_entity_sig_uq').on(
      t.entityId,
      t.merchantSignature
    ),
    // Cross-tenant guard: account_id MUST belong to the same entity.
    accountFk: foreignKey({
      name: 'merchant_memory_account_fk',
      columns: [t.accountId, t.entityId],
      foreignColumns: [accounts.id, accounts.entityId],
    }).onDelete('cascade'),
  })
);

export type BankRule = typeof bankRules.$inferSelect;
export type NewBankRule = typeof bankRules.$inferInsert;
export type MerchantMemory = typeof merchantMemory.$inferSelect;
export type NewMerchantMemory = typeof merchantMemory.$inferInsert;

// =====================================================================
// Stage 4 — Expenses & Receipts
// =====================================================================
// `receipts` carry both the raw OCR payload (JSONB, vendor-agnostic) and
// the structured fields the user confirmed at approval time. Once a
// receipt is approved we post a journal and (best-effort) link a bank
// transaction whose amount + date match.
//
// `mileage_logs` are AMAP claims at the HMRC rate prevailing at journey
// time. The rate is snapshotted onto the row so future rate changes
// don't retroactively rewrite history.
//
// `expense_claims` (+ `expense_claim_items`) bundle 1+ receipts into a
// single director's-loan-account credit (for Ltds) or drawings credit
// (for sole traders). For Stage 4 slice 1 a claim posts ONE combined
// journal at approval; multi-employee approvals are out of scope.

export const receiptStatusEnum = pgEnum('receipt_status', [
  'pending',     // uploaded, no OCR yet
  'ocr_done',    // OCR returned; awaiting user confirmation
  'approved',    // user confirmed; ledger journal posted
  'rejected',    // user discarded
  'matched',     // approved + auto-linked to a bank transaction
]);

export const paymentMethodEnum = pgEnum('payment_method', [
  'bank',         // paid from business bank → CR 0800
  'cash',         // paid from business petty cash → CR 0810
  'director',     // director paid out-of-pocket → CR 2500 (Ltd) or 3100 (ST)
]);

export const vehicleTypeEnum = pgEnum('vehicle_type', [
  'car',
  'motorbike',
  'bike',
]);

export const journeyTypeEnum = pgEnum('journey_type', [
  'business',
  'commute',
  'personal',
]);

export const expenseClaimStatusEnum = pgEnum('expense_claim_status', [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'paid',
]);

export const receipts = pgTable(
  'receipts',
  {
    id: text('id').primaryKey(), // "rcp_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    // Opaque reference to the file in the Drive folder structure.
    // Slice 1 just stores the id/url; the upload pipeline (Drive client
    // + signed URLs) is wired up by a Stage 4 follow-up.
    fileId: text('file_id'),
    fileUrl: text('file_url'),
    fileName: text('file_name'),
    mimeType: text('mime_type'),
    // Structured fields. `vendor` etc. are populated either from OCR
    // or directly by the user at approval time.
    vendor: text('vendor'),
    receiptDate: date('receipt_date'),
    currency: text('currency').notNull().default('GBP'),
    totalPence: bigint('total_pence', { mode: 'number' }),
    vatPence: bigint('vat_pence', { mode: 'number' }),
    netPence: bigint('net_pence', { mode: 'number' }), // total - vat
    paymentMethod: paymentMethodEnum('payment_method').notNull().default('bank'),
    expenseAccountCode: text('expense_account_code'), // e.g. '7100'
    // OCR plumbing. `ocr_payload` is the raw model output (whatever the
    // OCR pipeline produces — kept verbatim for audit). `ocr_confidence`
    // is 0–100, NULL until the OCR step runs.
    ocrPayload: jsonb('ocr_payload'),
    ocrConfidence: integer('ocr_confidence'),
    ocrModel: text('ocr_model'),
    status: receiptStatusEnum('status').notNull().default('pending'),
    postedJournalId: text('posted_journal_id'),
    matchedBankTxId: text('matched_bank_tx_id'),
    notes: text('notes'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityStatusIdx: index('receipts_entity_status_idx').on(t.entityId, t.status),
    entityDateIdx: index('receipts_entity_date_idx').on(t.entityId, t.receiptDate),
    matchedBankIdx: index('receipts_matched_bank_idx').on(t.matchedBankTxId),
  })
);

export const mileageLogs = pgTable(
  'mileage_logs',
  {
    id: text('id').primaryKey(), // "mil_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    journeyDate: date('journey_date').notNull(),
    // Tax year stored as the starting calendar year — UK tax year runs
    // 6 Apr → 5 Apr, so the year part of "2025-04-06 → 2026-04-05" is 2025.
    // This lets the YTD taper query stay an integer comparison.
    taxYear: integer('tax_year').notNull(),
    fromAddress: text('from_address').notNull(),
    toAddress: text('to_address').notNull(),
    // Distance stored as hundredths-of-a-mile (so 12.34 mi → 1234) to
    // mirror the pence/integer convention used elsewhere in the schema.
    distanceMilesX100: integer('distance_miles_x100').notNull(),
    vehicleType: vehicleTypeEnum('vehicle_type').notNull(),
    journeyType: journeyTypeEnum('journey_type').notNull().default('business'),
    // Snapshot the prevailing AMAP rate (pence per mile) so future
    // rate changes don't rewrite history. Total = round(miles*rate).
    ratePencePerMile: integer('rate_pence_per_mile').notNull(),
    // For cars, the 45p rate tapers to 25p after 10 000 mi YTD; we
    // capture both portions so the journal narration is auditable.
    portionAtFullRateMilesX100: integer('portion_at_full_rate_miles_x100').notNull().default(0),
    portionAtTaperRateMilesX100: integer('portion_at_taper_rate_miles_x100').notNull().default(0),
    fullRatePencePerMile: integer('full_rate_pence_per_mile'),
    taperRatePencePerMile: integer('taper_rate_pence_per_mile'),
    amountPence: bigint('amount_pence', { mode: 'number' }).notNull(),
    notes: text('notes'),
    postedJournalId: text('posted_journal_id'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityYearIdx: index('mileage_logs_entity_year_idx').on(t.entityId, t.taxYear),
    entityDateIdx: index('mileage_logs_entity_date_idx').on(t.entityId, t.journeyDate),
  })
);

export const expenseClaims = pgTable(
  'expense_claims',
  {
    id: text('id').primaryKey(), // "ecl_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    claimantUserId: text('claimant_user_id'),
    title: text('title').notNull(),
    claimDate: date('claim_date').notNull(),
    totalPence: bigint('total_pence', { mode: 'number' }).notNull().default(0),
    status: expenseClaimStatusEnum('status').notNull().default('draft'),
    postedJournalId: text('posted_journal_id'),
    notes: text('notes'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityStatusIdx: index('expense_claims_entity_status_idx').on(t.entityId, t.status),
  })
);

export const expenseClaimItems = pgTable(
  'expense_claim_items',
  {
    id: text('id').primaryKey(), // "eci_..."
    claimId: text('claim_id')
      .notNull()
      .references(() => expenseClaims.id, { onDelete: 'cascade' }),
    receiptId: text('receipt_id'), // nullable: a free-text item without a receipt
    description: text('description').notNull(),
    amountPence: bigint('amount_pence', { mode: 'number' }).notNull(),
    expenseAccountCode: text('expense_account_code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    claimIdx: index('expense_claim_items_claim_idx').on(t.claimId),
  })
);

export type Receipt = typeof receipts.$inferSelect;
export type NewReceipt = typeof receipts.$inferInsert;
export type MileageLog = typeof mileageLogs.$inferSelect;
export type NewMileageLog = typeof mileageLogs.$inferInsert;
export type ExpenseClaim = typeof expenseClaims.$inferSelect;
export type NewExpenseClaim = typeof expenseClaims.$inferInsert;
export type ExpenseClaimItem = typeof expenseClaimItems.$inferSelect;
export type NewExpenseClaimItem = typeof expenseClaimItems.$inferInsert;

// =====================================================================
// Stage 5 — UK Tax Engine (Self-Employed)
// =====================================================================
// Three new pieces of state:
//
//   `tax_rules`  — system-wide, versioned-by-tax-year ruleset (rates,
//                  thresholds, allowances) stored as JSONB so the rules
//                  for a given year can be tweaked without code edits.
//                  Two regions: 'rUK' (England/Wales/NI) and 'scotland'
//                  (different income-tax bands).
//
//   `tax_years`  — per-entity record marking the user's intent for a
//                  given UK tax year (open / locked). Locking a tax
//                  year freezes its computed SA103 figures for audit;
//                  the year-end / accountant-access flow lives in
//                  Stage 8 but the table is introduced here.
//
//   `capital_allowance_pools` + `capital_allowance_assets`
//                — UK capital allowances. AIA pool exists per-year
//                  (used and gone), main/special pools roll forward
//                  WDV at 18% / 6% per year. Each pool's row stores
//                  opening WDV, additions, disposals, claim, closing
//                  WDV — the engine recomputes it from the assets
//                  on demand and persists the snapshot.

export const taxYearStatusEnum = pgEnum('tax_year_status', ['open', 'locked']);

export const capitalAllowancePoolEnum = pgEnum('capital_allowance_pool', [
  'aia',     // Annual Investment Allowance — 100% in-year on qualifying assets
  'main',    // Main pool — 18% WDA per year
  'special', // Special-rate pool — 6% WDA per year
  'sba',     // Structures & Buildings Allowance — 3% straight-line
]);

export const taxRules = pgTable(
  'tax_rules',
  {
    // System-level: no entity FK. Two rows per tax year (rUK, scotland).
    taxYear: integer('tax_year').notNull(),     // e.g. 2025 = TY2025-26 (6 Apr 25 → 5 Apr 26)
    region: text('region').notNull(),           // 'rUK' | 'scotland'
    ruleSet: jsonb('rule_set').notNull(),       // shape: see api/_lib/tax/rules.js
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taxYear, t.region], name: 'tax_rules_pk' }),
  })
);

export const taxYears = pgTable(
  'tax_years',
  {
    id: text('id').primaryKey(), // "tyr_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    taxYear: integer('tax_year').notNull(),
    region: text('region').notNull().default('rUK'), // entity-level default; SA can override per-call
    status: taxYearStatusEnum('status').notNull().default('open'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityYearUq: uniqueIndex('tax_years_entity_year_uq').on(t.entityId, t.taxYear),
  })
);

export const capitalAllowanceAssets = pgTable(
  'capital_allowance_assets',
  {
    id: text('id').primaryKey(), // "caa_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    taxYear: integer('tax_year').notNull(), // year of acquisition
    poolType: capitalAllowancePoolEnum('pool_type').notNull(),
    description: text('description').notNull(),
    acquiredDate: date('acquired_date').notNull(),
    costPence: bigint('cost_pence', { mode: 'number' }).notNull(),
    // If true, this asset's cost is offset by AIA in `taxYear` and
    // does NOT enter the main/special pool the next year. If false,
    // its cost is added to `poolType` (main / special) for WDA.
    claimAia: boolean('claim_aia').notNull().default(true),
    disposedDate: date('disposed_date'),
    disposalProceedsPence: bigint('disposal_proceeds_pence', { mode: 'number' }),
    notes: text('notes'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityYearIdx: index('capital_allowance_assets_entity_year_idx').on(t.entityId, t.taxYear),
    entityPoolIdx: index('capital_allowance_assets_entity_pool_idx').on(t.entityId, t.poolType),
  })
);

export const capitalAllowancePools = pgTable(
  'capital_allowance_pools',
  {
    id: text('id').primaryKey(), // "cap_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    taxYear: integer('tax_year').notNull(),
    poolType: capitalAllowancePoolEnum('pool_type').notNull(),
    openingWdvPence: bigint('opening_wdv_pence', { mode: 'number' }).notNull().default(0),
    additionsPence: bigint('additions_pence', { mode: 'number' }).notNull().default(0),
    disposalsPence: bigint('disposals_pence', { mode: 'number' }).notNull().default(0),
    aiaClaimedPence: bigint('aia_claimed_pence', { mode: 'number' }).notNull().default(0),
    wdaClaimedPence: bigint('wda_claimed_pence', { mode: 'number' }).notNull().default(0),
    closingWdvPence: bigint('closing_wdv_pence', { mode: 'number' }).notNull().default(0),
    computedAt: timestamp('computed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityYearPoolUq: uniqueIndex('capital_allowance_pools_entity_year_pool_uq').on(
      t.entityId,
      t.taxYear,
      t.poolType
    ),
  })
);

export type TaxRule = typeof taxRules.$inferSelect;
export type NewTaxRule = typeof taxRules.$inferInsert;
export type TaxYear = typeof taxYears.$inferSelect;
export type NewTaxYear = typeof taxYears.$inferInsert;
export type CapitalAllowanceAsset = typeof capitalAllowanceAssets.$inferSelect;
export type NewCapitalAllowanceAsset = typeof capitalAllowanceAssets.$inferInsert;
export type CapitalAllowancePool = typeof capitalAllowancePools.$inferSelect;
export type NewCapitalAllowancePool = typeof capitalAllowancePools.$inferInsert;

// =====================================================================
// Stage 6 — UK Tax Engine (Limited Company)
// =====================================================================
// Adds: payroll (employees + runs), dividends register, accounting
// periods (Ltd Co's CT period is per-AP, not per-tax-year),
// Companies House filing reminders.

export const payFrequencyEnum = pgEnum('pay_frequency', ['monthly', 'weekly', 'fortnightly', 'four_weekly']);
export const payrollRunStatusEnum = pgEnum('payroll_run_status', ['draft', 'posted', 'reversed']);
export const dividendStatusEnum = pgEnum('dividend_status', ['declared', 'paid', 'cancelled']);
export const accountingPeriodStatusEnum = pgEnum('accounting_period_status', ['open', 'locked']);
export const companiesHouseKindEnum = pgEnum('companies_house_kind', ['cs01', 'accounts', 'ct600']);
export const companiesHouseStatusEnum = pgEnum('companies_house_status', ['upcoming', 'overdue', 'filed']);

export const payrollEmployees = pgTable(
  'payroll_employees',
  {
    id: text('id').primaryKey(), // "emp_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    niNumber: text('ni_number'),
    taxCode: text('tax_code').notNull().default('1257L'),
    payFrequency: payFrequencyEnum('pay_frequency').notNull().default('monthly'),
    annualSalaryPence: bigint('annual_salary_pence', { mode: 'number' }).notNull().default(0),
    isDirector: boolean('is_director').notNull().default(false),
    startDate: date('start_date').notNull(),
    leaveDate: date('leave_date'),
    archived: boolean('archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index('payroll_employees_entity_idx').on(t.entityId),
  })
);

export const payrollRuns = pgTable(
  'payroll_runs',
  {
    id: text('id').primaryKey(), // "pay_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    employeeId: text('employee_id')
      .notNull()
      .references(() => payrollEmployees.id, { onDelete: 'restrict' }),
    taxYear: integer('tax_year').notNull(),
    periodNumber: integer('period_number').notNull(), // 1..12 for monthly
    payDate: date('pay_date').notNull(),
    grossPence: bigint('gross_pence', { mode: 'number' }).notNull(),
    payePence: bigint('paye_pence', { mode: 'number' }).notNull().default(0),
    eeNiPence: bigint('ee_ni_pence', { mode: 'number' }).notNull().default(0),
    erNiPence: bigint('er_ni_pence', { mode: 'number' }).notNull().default(0),
    netPence: bigint('net_pence', { mode: 'number' }).notNull(),
    ytdGrossPence: bigint('ytd_gross_pence', { mode: 'number' }).notNull(),
    ytdPayePence: bigint('ytd_paye_pence', { mode: 'number' }).notNull(),
    ytdEeNiPence: bigint('ytd_ee_ni_pence', { mode: 'number' }).notNull(),
    fpsPayload: jsonb('fps_payload'),
    status: payrollRunStatusEnum('status').notNull().default('draft'),
    journalId: text('journal_id'), // soft FK to journals when posted
    notes: text('notes'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityYearIdx: index('payroll_runs_entity_year_idx').on(t.entityId, t.taxYear),
    employeePeriodUq: uniqueIndex('payroll_runs_employee_period_uq').on(
      t.employeeId,
      t.taxYear,
      t.periodNumber
    ),
  })
);

export const dividends = pgTable(
  'dividends',
  {
    id: text('id').primaryKey(), // "div_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    declaredDate: date('declared_date').notNull(),
    paymentDate: date('payment_date'),
    voucherNumber: text('voucher_number').notNull(),
    sharesIssued: integer('shares_issued').notNull().default(1),
    perShareAmountPence: bigint('per_share_amount_pence', { mode: 'number' }).notNull(),
    totalAmountPence: bigint('total_amount_pence', { mode: 'number' }).notNull(),
    status: dividendStatusEnum('status').notNull().default('declared'),
    journalId: text('journal_id'),
    notes: text('notes'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityDateIdx: index('dividends_entity_date_idx').on(t.entityId, t.declaredDate),
    entityVoucherUq: uniqueIndex('dividends_entity_voucher_uq').on(t.entityId, t.voucherNumber),
  })
);

export const accountingPeriods = pgTable(
  'accounting_periods',
  {
    id: text('id').primaryKey(), // "ap_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: accountingPeriodStatusEnum('status').notNull().default('open'),
    ctComputedPence: bigint('ct_computed_pence', { mode: 'number' }),
    ctComputedAt: timestamp('ct_computed_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityRangeUq: uniqueIndex('accounting_periods_entity_range_uq').on(
      t.entityId,
      t.startDate,
      t.endDate
    ),
  })
);

export const companiesHouseFilings = pgTable(
  'companies_house_filings',
  {
    id: text('id').primaryKey(), // "chf_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    kind: companiesHouseKindEnum('kind').notNull(),
    dueDate: date('due_date').notNull(),
    status: companiesHouseStatusEnum('status').notNull().default('upcoming'),
    feePence: bigint('fee_pence', { mode: 'number' }),
    completedDate: date('completed_date'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityKindIdx: index('companies_house_filings_entity_kind_idx').on(t.entityId, t.kind),
    entityDueIdx: index('companies_house_filings_entity_due_idx').on(t.entityId, t.dueDate),
  })
);

export type PayrollEmployee = typeof payrollEmployees.$inferSelect;
export type NewPayrollEmployee = typeof payrollEmployees.$inferInsert;
export type PayrollRun = typeof payrollRuns.$inferSelect;
export type NewPayrollRun = typeof payrollRuns.$inferInsert;
export type Dividend = typeof dividends.$inferSelect;
export type NewDividend = typeof dividends.$inferInsert;
export type AccountingPeriod = typeof accountingPeriods.$inferSelect;
export type NewAccountingPeriod = typeof accountingPeriods.$inferInsert;
export type CompaniesHouseFiling = typeof companiesHouseFilings.$inferSelect;
export type NewCompaniesHouseFiling = typeof companiesHouseFilings.$inferInsert;

// =====================================================================
// Stage 7 — VAT + Making Tax Digital
// =====================================================================
// Adds: VAT registrations, returns, obligations (synced from HMRC),
// and a per-journal-line VAT capture table that records the VAT rate,
// VAT amount, and which side (output / input / EU) each ledger line
// belongs to. Existing journal_lines are untouched — VAT is opt-in
// metadata so backfill is a no-op.

// vatSchemeEnum is declared at the top of this file (Stage 0) with
// values ['none','standard','flat_rate','cash'] — Stage-7 reuses it.
export const vatReturnStatusEnum = pgEnum('vat_return_status', ['draft', 'submitted', 'locked']);
export const vatObligationStatusEnum = pgEnum('vat_obligation_status', ['open', 'fulfilled']);
// Conceptual side a VAT-bearing journal line falls on. Drives box
// allocation in computeReturn:
//   output         → boxes 1 + 6     (UK sales, output VAT)
//   input          → boxes 4 + 7     (UK purchases, input VAT)
//   eu_acquisition → boxes 2 + 9     (EU goods in)
//   eu_dispatch    → box 8           (EU goods out, no VAT)
export const vatBoxSideEnum = pgEnum('vat_box_side', [
  'output',
  'input',
  'eu_acquisition',
  'eu_dispatch',
]);

export const vatRegistrations = pgTable(
  'vat_registrations',
  {
    id: text('id').primaryKey(), // "vatreg_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    vatNumber: text('vat_number').notNull(),
    scheme: vatSchemeEnum('scheme').notNull().default('standard'),
    cashAccounting: boolean('cash_accounting').notNull().default(false),
    flatRateScheme: jsonb('flat_rate_scheme'), // { ratePct, sectorCode, firstYearDiscountActive, firstYearDiscountEnds }
    registrationDate: date('registration_date').notNull(),
    deregistrationDate: date('deregistration_date'),
    archived: boolean('archived').notNull().default(false),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityIdx: index('vat_registrations_entity_idx').on(t.entityId),
    entityVrnUq: uniqueIndex('vat_registrations_entity_vrn_uq').on(t.entityId, t.vatNumber),
  })
);

export const vatReturns = pgTable(
  'vat_returns',
  {
    id: text('id').primaryKey(), // "vatret_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    vatRegistrationId: text('vat_registration_id')
      .notNull()
      .references(() => vatRegistrations.id, { onDelete: 'restrict' }),
    periodKey: text('period_key').notNull(), // HMRC's id, e.g. "24A1"
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    schemeAtSubmit: vatSchemeEnum('scheme_at_submit').notNull(),
    cashBasis: boolean('cash_basis').notNull().default(false),
    boxes: jsonb('boxes').notNull(), // {box1..box9, allInPence, signed where applicable}
    status: vatReturnStatusEnum('status').notNull().default('draft'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    hmrcReceipt: jsonb('hmrc_receipt'), // { formBundleNumber, processingDate, paymentIndicator, chargeRefNumber }
    signedByUserId: text('signed_by_user_id'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityPeriodUq: uniqueIndex('vat_returns_entity_period_uq').on(t.entityId, t.periodKey),
    entityRangeIdx: index('vat_returns_entity_range_idx').on(
      t.entityId,
      t.periodStart,
      t.periodEnd
    ),
  })
);

export const vatObligations = pgTable(
  'vat_obligations',
  {
    id: text('id').primaryKey(), // "vatob_..."
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    periodKey: text('period_key').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    dueDate: date('due_date').notNull(),
    status: vatObligationStatusEnum('status').notNull().default('open'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityPeriodUq: uniqueIndex('vat_obligations_entity_period_uq').on(
      t.entityId,
      t.periodKey
    ),
    entityDueIdx: index('vat_obligations_entity_due_idx').on(t.entityId, t.dueDate),
  })
);

// Per-line VAT metadata. We do NOT alter journal_lines (keeps the
// hot-path table narrow and the migration backfill-free); this side
// table is queried during VAT-return computation only.
export const journalLineVat = pgTable(
  'journal_line_vat',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    journalLineId: bigint('journal_line_id', { mode: 'number' })
      .notNull()
      .references(() => journalLines.id, { onDelete: 'cascade' }),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    side: vatBoxSideEnum('side').notNull(),
    vatRatePct: numeric('vat_rate_pct', { precision: 5, scale: 2 }).notNull(),
    netPence: bigint('net_pence', { mode: 'number' }).notNull(),
    vatPence: bigint('vat_pence', { mode: 'number' }).notNull(),
    grossPence: bigint('gross_pence', { mode: 'number' }).notNull(),
    // When status flips to 'locked' the line is read-only — set when
    // a return covering this date is submitted.
    lockedByReturnId: text('locked_by_return_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    lineUq: uniqueIndex('journal_line_vat_line_uq').on(t.journalLineId),
    entityIdx: index('journal_line_vat_entity_idx').on(t.entityId),
    lockedIdx: index('journal_line_vat_locked_idx').on(t.lockedByReturnId),
  })
);

export type VatRegistration = typeof vatRegistrations.$inferSelect;
export type NewVatRegistration = typeof vatRegistrations.$inferInsert;
export type VatReturn = typeof vatReturns.$inferSelect;
export type NewVatReturn = typeof vatReturns.$inferInsert;
export type VatObligation = typeof vatObligations.$inferSelect;
export type NewVatObligation = typeof vatObligations.$inferInsert;
export type JournalLineVat = typeof journalLineVat.$inferSelect;

// =====================================================================
// Stage 8 — Reports, year-end, accountant access
// =====================================================================
// Three concerns, three tables:
//   * accountant_access — links a client user to an accountant (by email,
//     pending → accepted → revoked) with a scope (read_only / full).
//   * year_end_checklists — per-entity, per-fiscal-year checklist of
//     close-the-books steps; locking a year-end is the ceremony that
//     closes the underlying period and snapshots all reports.
//   * report_snapshots — immutable JSON payloads of computed reports,
//     captured at year-end so the figures filed with HMRC can always be
//     reproduced exactly.

export const accountantAccessScopeEnum = pgEnum('accountant_access_scope', [
  'read_only',
  'full',
]);
export const accountantAccessStatusEnum = pgEnum('accountant_access_status', [
  'pending',
  'accepted',
  'revoked',
]);
export const reportSnapshotKindEnum = pgEnum('report_snapshot_kind', [
  'profit_and_loss',
  'balance_sheet',
  'trial_balance',
  'cash_flow',
  'aged_debtors',
  'aged_creditors',
  'vat_detail',
  'directors_report',
]);

export const accountantAccess = pgTable(
  'accountant_access',
  {
    id: text('id').primaryKey(),
    clientUserId: text('client_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountantEmail: text('accountant_email').notNull(),
    accountantUserId: text('accountant_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    scope: accountantAccessScopeEnum('scope').notNull().default('read_only'),
    status: accountantAccessStatusEnum('status').notNull().default('pending'),
    inviteTokenHash: text('invite_token_hash'),
    inviteExpiresAt: timestamp('invite_expires_at', { withTimezone: true }),
    invitedAt: timestamp('invited_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    clientEmailUq: uniqueIndex('accountant_access_client_email_uq').on(
      t.clientUserId,
      t.accountantEmail
    ),
    clientIdx: index('accountant_access_client_idx').on(t.clientUserId),
    accountantIdx: index('accountant_access_accountant_idx').on(t.accountantUserId),
    tokenHashIdx: index('accountant_access_token_hash_idx').on(t.inviteTokenHash),
  })
);

export const yearEndChecklists = pgTable(
  'year_end_checklists',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    fiscalYear: integer('fiscal_year').notNull(),
    periodId: text('period_id').references(() => periods.id, {
      onDelete: 'set null',
    }),
    steps: jsonb('steps').notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    entityYearUq: uniqueIndex('year_end_checklists_entity_year_uq').on(
      t.entityId,
      t.fiscalYear
    ),
  })
);

export const reportSnapshots = pgTable(
  'report_snapshots',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    kind: reportSnapshotKindEnum('kind').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    fiscalYear: integer('fiscal_year'),
    generatedAt: timestamp('generated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    generatedBy: text('generated_by'),
    payload: jsonb('payload').notNull(),
  },
  (t) => ({
    entityKindEndIdx: index('report_snapshots_entity_kind_end_idx').on(
      t.entityId,
      t.kind,
      t.periodEnd
    ),
  })
);

export type AccountantAccess = typeof accountantAccess.$inferSelect;
export type NewAccountantAccess = typeof accountantAccess.$inferInsert;
export type YearEndChecklist = typeof yearEndChecklists.$inferSelect;
export type NewYearEndChecklist = typeof yearEndChecklists.$inferInsert;
export type ReportSnapshot = typeof reportSnapshots.$inferSelect;
export type NewReportSnapshot = typeof reportSnapshots.$inferInsert;
export type NewJournalLineVat = typeof journalLineVat.$inferInsert;

// =====================================================================
// Stage 9 — Invoicing polish: contacts, invoices, quotes, recurring,
// payment links, reminders, multi-currency.
// =====================================================================

export const contactTypeEnum = pgEnum('contact_type', ['customer', 'supplier', 'both']);

export const contacts = pgTable(
  'contacts',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
    type: contactTypeEnum('type').notNull().default('customer'),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    addressLine1: text('address_line_1'),
    addressLine2: text('address_line_2'),
    city: text('city'),
    postcode: text('postcode'),
    country: text('country').notNull().default('GB'),
    defaultCurrency: text('default_currency').notNull().default('GBP'),
    paymentTermsDays: integer('payment_terms_days').notNull().default(30),
    notes: text('notes'),
    archived: boolean('archived').notNull().default(false),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityNameIdx: index('contacts_entity_name_idx').on(t.entityId, t.name),
    entityTypeIdx: index('contacts_entity_type_idx').on(t.entityId, t.type),
  })
);

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'draft',
  'sent',
  'partially_paid',
  'paid',
  'void',
]);

export const invoices = pgTable(
  'invoices',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    invoiceNumber: text('invoice_number').notNull(),
    status: invoiceStatusEnum('status').notNull().default('draft'),
    issueDate: date('issue_date').notNull(),
    dueDate: date('due_date').notNull(),
    currency: text('currency').notNull().default('GBP'),
    fxRateToBase: numeric('fx_rate_to_base', { precision: 18, scale: 8 }).notNull().default('1'),
    subtotalPence: bigint('subtotal_pence', { mode: 'number' }).notNull(),
    totalPence: bigint('total_pence', { mode: 'number' }).notNull(),
    totalBasePence: bigint('total_base_pence', { mode: 'number' }).notNull(),
    paidPence: bigint('paid_pence', { mode: 'number' }).notNull().default(0),
    lineItems: jsonb('line_items').notNull().default(sql`'[]'::jsonb`),
    notes: text('notes'),
    journalId: text('journal_id'),
    quoteId: text('quote_id'),
    recurringId: text('recurring_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityNumberUq: uniqueIndex('invoices_entity_number_uq').on(t.entityId, t.invoiceNumber),
    entityStatusIdx: index('invoices_entity_status_idx').on(t.entityId, t.status),
    contactIdx: index('invoices_contact_idx').on(t.contactId),
    entityDueIdx: index('invoices_entity_due_idx').on(t.entityId, t.dueDate),
  })
);

export const quoteStatusEnum = pgEnum('quote_status', [
  'draft',
  'sent',
  'accepted',
  'declined',
  'expired',
  'converted',
]);

export const quotes = pgTable(
  'quotes',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    quoteNumber: text('quote_number').notNull(),
    status: quoteStatusEnum('status').notNull().default('draft'),
    issueDate: date('issue_date').notNull(),
    expiryDate: date('expiry_date'),
    currency: text('currency').notNull().default('GBP'),
    fxRateToBase: numeric('fx_rate_to_base', { precision: 18, scale: 8 }).notNull().default('1'),
    totalPence: bigint('total_pence', { mode: 'number' }).notNull(),
    lineItems: jsonb('line_items').notNull().default(sql`'[]'::jsonb`),
    notes: text('notes'),
    acceptTokenHash: text('accept_token_hash'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    convertedInvoiceId: text('converted_invoice_id'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityNumberUq: uniqueIndex('quotes_entity_number_uq').on(t.entityId, t.quoteNumber),
    entityStatusIdx: index('quotes_entity_status_idx').on(t.entityId, t.status),
    acceptTokenIdx: index('quotes_accept_token_idx').on(t.acceptTokenHash),
  })
);

export const recurringFrequencyEnum = pgEnum('recurring_frequency', [
  'weekly',
  'fortnightly',
  'monthly',
  'quarterly',
  'yearly',
]);
export const recurringStatusEnum = pgEnum('recurring_status', [
  'active',
  'paused',
  'ended',
]);

export const recurringInvoices = pgTable(
  'recurring_invoices',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'restrict' }),
    frequency: recurringFrequencyEnum('frequency').notNull(),
    status: recurringStatusEnum('status').notNull().default('active'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date'),
    nextRunDate: date('next_run_date').notNull(),
    paymentTermsDays: integer('payment_terms_days').notNull().default(30),
    currency: text('currency').notNull().default('GBP'),
    totalPence: bigint('total_pence', { mode: 'number' }).notNull(),
    lineItems: jsonb('line_items').notNull().default(sql`'[]'::jsonb`),
    notes: text('notes'),
    lastGeneratedAt: timestamp('last_generated_at', { withTimezone: true }),
    generatedCount: integer('generated_count').notNull().default(0),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityStatusIdx: index('recurring_invoices_entity_status_idx').on(t.entityId, t.status),
    nextRunIdx: index('recurring_invoices_next_run_idx').on(t.status, t.nextRunDate),
  })
);

export const paymentLinkProviderEnum = pgEnum('payment_link_provider', [
  'stripe',
  'gocardless',
]);
export const paymentLinkStatusEnum = pgEnum('payment_link_status', [
  'pending',
  'processing',
  'succeeded',
  'failed',
  'refunded',
  'cancelled',
]);

export const paymentLinks = pgTable(
  'payment_links',
  {
    id: text('id').primaryKey(),
    invoiceId: text('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
    provider: paymentLinkProviderEnum('provider').notNull(),
    providerRef: text('provider_ref').notNull(),
    status: paymentLinkStatusEnum('status').notNull().default('pending'),
    amountPence: bigint('amount_pence', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('GBP'),
    succeededAt: timestamp('succeeded_at', { withTimezone: true }),
    lastEventId: text('last_event_id'),
    paymentJournalId: text('payment_journal_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    invoiceIdx: index('payment_links_invoice_idx').on(t.invoiceId),
    providerRefUq: uniqueIndex('payment_links_provider_ref_uq').on(t.provider, t.providerRef),
  })
);

export const paymentLinkEvents = pgTable(
  'payment_link_events',
  {
    id: text('id').primaryKey(),
    paymentLinkId: text('payment_link_id').notNull().references(() => paymentLinks.id, { onDelete: 'cascade' }),
    provider: paymentLinkProviderEnum('provider').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    providerEventUq: uniqueIndex('payment_link_events_provider_event_uq').on(t.provider, t.eventId),
    paymentLinkIdx: index('payment_link_events_link_idx').on(t.paymentLinkId),
  })
);

export const reminderTriggerEnum = pgEnum('reminder_trigger', [
  'before_due',
  'on_due',
  'after_due',
]);

export const reminderRules = pgTable(
  'reminder_rules',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    trigger: reminderTriggerEnum('trigger').notNull(),
    daysOffset: integer('days_offset').notNull().default(0),
    templateSubject: text('template_subject').notNull(),
    templateBody: text('template_body').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    entityActiveIdx: index('reminder_rules_entity_active_idx').on(t.entityId, t.active),
  })
);

export const reminderLog = pgTable(
  'reminder_log',
  {
    id: text('id').primaryKey(),
    invoiceId: text('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
    ruleId: text('rule_id').notNull().references(() => reminderRules.id, { onDelete: 'cascade' }),
    scheduledFor: date('scheduled_for').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    channel: text('channel').notNull().default('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    invoiceIdx: index('reminder_log_invoice_idx').on(t.invoiceId),
    ruleScheduledIdx: index('reminder_log_rule_scheduled_idx').on(t.ruleId, t.scheduledFor),
    uniqueSchedule: uniqueIndex('reminder_log_invoice_rule_sched_uq').on(
      t.invoiceId,
      t.ruleId,
      t.scheduledFor
    ),
  })
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type Quote = typeof quotes.$inferSelect;
export type NewQuote = typeof quotes.$inferInsert;
export type RecurringInvoice = typeof recurringInvoices.$inferSelect;
export type NewRecurringInvoice = typeof recurringInvoices.$inferInsert;
export type PaymentLink = typeof paymentLinks.$inferSelect;
export type NewPaymentLink = typeof paymentLinks.$inferInsert;
export type PaymentLinkEvent = typeof paymentLinkEvents.$inferSelect;
export type NewPaymentLinkEvent = typeof paymentLinkEvents.$inferInsert;
export type ReminderRule = typeof reminderRules.$inferSelect;
export type NewReminderRule = typeof reminderRules.$inferInsert;
export type ReminderLogRow = typeof reminderLog.$inferSelect;
export type NewReminderLog = typeof reminderLog.$inferInsert;
