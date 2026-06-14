/**
 * Stage 8 — Year-end checklist + lock ceremony.
 *
 * A checklist is a list of `{ id, label, done, doneAt, doneBy }` rows
 * stored as JSON on `year_end_checklists.steps`. The default set is
 * config-driven and shared across entities; tickStep mutates the JSON
 * in place. lockYearEnd is the ceremony that:
 *
 *   1. Validates every step is ticked (configurable allowSkipped flag).
 *   2. Locks the underlying period via `lockPeriod`.
 *   3. Snapshots all standard reports for the period.
 *   4. Updates the checklist row with lockedAt / lockedBy.
 *   5. Audit-logs `year_end.lock`.
 *
 * Reopening is via the existing `unlockPeriod` plus an admin-only
 * checklist update — same audit trail.
 */

const cryptoNode = require('crypto');
const { getDb, getSchema } = require('../db');
const { and, eq } = require('drizzle-orm');
const { audit } = require('../audit-log');
const { lockPeriod, upsertPeriod } = require('../ledger/periods');
const { saveSnapshot } = require('../reports/snapshots');
const {
  trialBalance,
  profitAndLoss,
  balanceSheet,
} = require('../ledger/reports');
const { agedDebtors, agedCreditors } = require('../reports/aged');
const { cashFlow } = require('../reports/cash-flow');
const { directorsReport } = require('../reports/directors-report');

function newChecklistId() {
  return `yec_${cryptoNode.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

const DEFAULT_STEPS = [
  { id: 'reconcile_all_banks', label: 'All bank accounts reconciled' },
  { id: 'review_accruals', label: 'Accruals & prepayments reviewed' },
  { id: 'post_depreciation', label: 'Depreciation posted' },
  { id: 'close_stock', label: 'Closing stock counted (if applicable)' },
  { id: 'review_aged_debtors', label: 'Aged debtors reviewed; bad debts written off' },
  { id: 'review_aged_creditors', label: 'Aged creditors reviewed' },
  { id: 'finalise_tax_figures', label: 'CT / SA tax figures finalised' },
  { id: 'lock_period', label: 'Period locked' },
];

function defaultSteps() {
  return DEFAULT_STEPS.map((s) => ({ ...s, done: false, doneAt: null, doneBy: null }));
}

async function createChecklist(input, opts = {}) {
  const { entityId, fiscalYear, periodId } = input;
  if (!entityId || !fiscalYear) throw new Error('createChecklist: entityId/fiscalYear required');
  const db = opts.tx || getDb();
  const { yearEndChecklists } = getSchema();
  const existing = await db
    .select()
    .from(yearEndChecklists)
    .where(and(eq(yearEndChecklists.entityId, entityId), eq(yearEndChecklists.fiscalYear, fiscalYear)))
    .limit(1);
  if (existing[0]) return existing[0];
  const row = {
    id: newChecklistId(),
    entityId,
    fiscalYear,
    periodId: periodId || null,
    steps: defaultSteps(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.insert(yearEndChecklists).values(row);
  return row;
}

async function getChecklist(entityId, fiscalYear, opts = {}) {
  const db = opts.tx || getDb();
  const { yearEndChecklists } = getSchema();
  const rows = await db
    .select()
    .from(yearEndChecklists)
    .where(and(eq(yearEndChecklists.entityId, entityId), eq(yearEndChecklists.fiscalYear, fiscalYear)))
    .limit(1);
  return rows[0] || null;
}

async function tickStep(input, opts = {}) {
  const { entityId, fiscalYear, stepId, done = true, actor } = input;
  if (!actor?.userId) throw new Error('tickStep: actor required');
  const db = opts.tx || getDb();
  const { yearEndChecklists } = getSchema();
  const row = await getChecklist(entityId, fiscalYear, { tx: db });
  if (!row) throw new Error(`checklist for ${entityId}/${fiscalYear} not found`);
  if (row.lockedAt) throw new Error('checklist already locked — cannot edit');
  const steps = row.steps.map((s) =>
    s.id === stepId
      ? { ...s, done, doneAt: done ? new Date().toISOString() : null, doneBy: done ? actor.userId : null }
      : s
  );
  if (!steps.some((s) => s.id === stepId)) throw new Error(`step ${stepId} not in checklist`);
  await db
    .update(yearEndChecklists)
    .set({ steps, updatedAt: new Date() })
    .where(eq(yearEndChecklists.id, row.id));
  await audit({
    action: 'year_end.step.tick',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    actorRole: actor.role,
    resourceType: 'year_end_checklist',
    resourceId: row.id,
    entityId,
    after: { stepId, done },
  });
  return { ...row, steps };
}

async function snapshotAllReports({ entityId, periodStart, periodEnd, fiscalYear, generatedBy }, opts = {}) { // eslint-disable-line no-unused-vars
  const tasks = [
    ['trial_balance', () => trialBalance(entityId, periodEnd)],
    ['profit_and_loss', () => profitAndLoss(entityId, { from: periodStart, to: periodEnd })],
    ['balance_sheet', () => balanceSheet(entityId, periodEnd)],
    ['cash_flow', () => cashFlow({ entityId, from: periodStart, to: periodEnd })],
    ['aged_debtors', () => agedDebtors({ entityId, asOfDate: periodEnd })],
    ['aged_creditors', () => agedCreditors({ entityId, asOfDate: periodEnd })],
    ['directors_report', () => directorsReport({ entityId, from: periodStart, to: periodEnd })],
  ];
  const results = [];
  for (const [kind, fn] of tasks) {
    const payload = await fn();
    const { id } = await saveSnapshot(
      { entityId, kind, periodStart, periodEnd, fiscalYear, payload, generatedBy },
      opts
    );
    results.push({ kind, snapshotId: id });
  }
  return results;
}

async function lockYearEnd(input, opts = {}) { // eslint-disable-line no-unused-vars
  const { entityId, fiscalYear, periodLabel, periodStart, periodEnd, actor, allowSkipped = false } = input;
  if (!actor?.userId) throw new Error('lockYearEnd: actor required');
  if (!entityId || !fiscalYear || !periodStart || !periodEnd) {
    throw new Error('lockYearEnd: entityId/fiscalYear/periodStart/periodEnd required');
  }
  const checklist = await getChecklist(entityId, fiscalYear);
  if (!checklist) throw new Error('lockYearEnd: checklist not found — call createChecklist first');
  if (checklist.lockedAt) return checklist;
  if (!allowSkipped) {
    const undone = checklist.steps.filter((s) => s.id !== 'lock_period' && !s.done);
    if (undone.length > 0) {
      throw new Error(
        `lockYearEnd: ${undone.length} step(s) not done — pass allowSkipped:true to override`
      );
    }
  }

  // Compute the report payloads OUTSIDE the lock transaction. These are
  // pure reads against the open ledger; doing them up-front means the
  // transaction below only runs cheap writes, and a failed `cashFlow()`
  // (e.g. missing cash account) doesn't leave a half-locked period.
  const periodLabelFinal = periodLabel || `FY${fiscalYear}`;
  const reportPayloads = await Promise.all([
    trialBalance(entityId, periodEnd).then((p) => ['trial_balance', p]),
    profitAndLoss(entityId, { from: periodStart, to: periodEnd }).then((p) => ['profit_and_loss', p]),
    balanceSheet(entityId, periodEnd).then((p) => ['balance_sheet', p]),
    cashFlow({ entityId, from: periodStart, to: periodEnd }).then((p) => ['cash_flow', p]),
    agedDebtors({ entityId, asOfDate: periodEnd }).then((p) => ['aged_debtors', p]),
    agedCreditors({ entityId, asOfDate: periodEnd }).then((p) => ['aged_creditors', p]),
    directorsReport({ entityId, from: periodStart, to: periodEnd }).then((p) => ['directors_report', p]),
  ]);

  // Atomic ceremony: upsert+lock period, persist snapshots, update
  // checklist, audit — all-or-nothing. lockPeriod / saveSnapshot / audit
  // all accept a `tx` handle and pipe writes through it.
  return getDb().transaction(async (tx) => {
    const period = await upsertPeriod(
      { entityId, label: periodLabelFinal, startDate: periodStart, endDate: periodEnd },
      { tx }
    );
    await lockPeriod(entityId, period.id, { actor, tx });
    const snapshots = [];
    for (const [kind, payload] of reportPayloads) {
      const { id } = await saveSnapshot(
        { entityId, kind, periodStart, periodEnd, fiscalYear, payload, generatedBy: actor.userId },
        { tx }
      );
      snapshots.push({ kind, snapshotId: id });
    }
    const { yearEndChecklists } = getSchema();
    const now = new Date();
    const lockStep = checklist.steps.map((s) =>
      s.id === 'lock_period'
        ? { ...s, done: true, doneAt: now.toISOString(), doneBy: actor.userId }
        : s
    );
    await tx
      .update(yearEndChecklists)
      .set({ steps: lockStep, periodId: period.id, lockedAt: now, lockedBy: actor.userId, updatedAt: now })
      .where(eq(yearEndChecklists.id, checklist.id));
    await audit(
      {
        action: 'year_end.lock',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        actorRole: actor.role,
        resourceType: 'year_end_checklist',
        resourceId: checklist.id,
        entityId,
        after: { fiscalYear, periodId: period.id, snapshotCount: snapshots.length },
      },
      { tx }
    );
    return { ...checklist, steps: lockStep, periodId: period.id, lockedAt: now, lockedBy: actor.userId, snapshots };
  });
}

module.exports = {
  defaultSteps,
  createChecklist,
  getChecklist,
  tickStep,
  lockYearEnd,
  snapshotAllReports,
};
