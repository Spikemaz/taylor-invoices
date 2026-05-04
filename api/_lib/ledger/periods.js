/**
 * Stage 1 — Periods (close / reopen).
 *
 * A "closed period" is a date range with `lockedAt` set. Once locked,
 * no journal_lines can be inserted/updated/deleted with a date inside
 * the range — enforced by `journal_lines_period_lock_trg` (DB trigger)
 * and `assertPeriodOpen()` (application).
 *
 * Closing a period is a deliberate user action — typically by the
 * accountant after end-of-month review. Reopening is also explicit and
 * audit-logged.
 */

const cryptoNode = require('crypto');
const { getDb, getSchema } = require('../db');
const { audit } = require('../audit-log');
const { and, eq, isNull } = require('drizzle-orm');

function newPeriodId() {
  return `per_${cryptoNode.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Create or update a period. Idempotent on (entity_id, start_date, end_date).
 *
 * @returns the row.
 */
async function upsertPeriod(input, opts = {}) {
  const { entityId, label, startDate, endDate } = input;
  if (!entityId || !label || !startDate || !endDate) {
    throw new Error('upsertPeriod: entityId, label, startDate, endDate required');
  }
  if (startDate > endDate) {
    throw new Error('upsertPeriod: startDate must be <= endDate');
  }
  const writer = opts.tx || getDb();
  const { periods } = getSchema();
  const existing = await writer
    .select()
    .from(periods)
    .where(
      and(
        eq(periods.entityId, entityId),
        eq(periods.startDate, startDate),
        eq(periods.endDate, endDate)
      )
    )
    .limit(1);
  if (existing[0]) {
    if (existing[0].label !== label) {
      await writer
        .update(periods)
        .set({ label, updatedAt: new Date() })
        .where(eq(periods.id, existing[0].id));
      return { ...existing[0], label };
    }
    return existing[0];
  }
  const row = {
    id: newPeriodId(),
    entityId,
    label,
    startDate,
    endDate,
  };
  await writer.insert(periods).values(row);
  return row;
}

async function lockPeriod(entityId, periodId, opts = {}) {
  if (!entityId || !periodId) throw new Error('lockPeriod: entityId and periodId required');
  if (!opts.actor?.userId) throw new Error('lockPeriod: actor required');
  // Allow the caller to pass an existing tx so this can participate in a
  // larger ceremony (e.g. year-end lock) without committing prematurely.
  const runner = opts.tx
    ? async (fn) => fn(opts.tx)
    : async (fn) => getDb().transaction(fn);
  return runner(async (tx) => {
    const { periods } = getSchema();
    const rows = await tx
      .select()
      .from(periods)
      .where(and(eq(periods.entityId, entityId), eq(periods.id, periodId)))
      .limit(1);
    if (!rows[0]) throw new Error(`period ${periodId} not found`);
    if (rows[0].lockedAt) {
      // already locked — idempotent no-op
      return rows[0];
    }
    const now = new Date();
    await tx
      .update(periods)
      .set({ lockedAt: now, lockedBy: opts.actor.userId, updatedAt: now })
      .where(eq(periods.id, periodId));
    await audit(
      {
        action: 'ledger.period.lock',
        actorUserId: opts.actor.userId,
        actorEmail: opts.actor.email,
        actorRole: opts.actor.role,
        ip: opts.actor.ip,
        userAgent: opts.actor.userAgent,
        requestId: opts.actor.requestId,
        resourceType: 'period',
        resourceId: periodId,
        entityId,
        before: { lockedAt: null },
        after: { lockedAt: now.toISOString() },
      },
      { tx }
    );
    return { ...rows[0], lockedAt: now, lockedBy: opts.actor.userId };
  });
}

async function unlockPeriod(entityId, periodId, opts = {}) {
  if (!entityId || !periodId) throw new Error('unlockPeriod: entityId and periodId required');
  if (!opts.actor?.userId) throw new Error('unlockPeriod: actor required');
  return getDb().transaction(async (tx) => {
    const { periods } = getSchema();
    const rows = await tx
      .select()
      .from(periods)
      .where(and(eq(periods.entityId, entityId), eq(periods.id, periodId)))
      .limit(1);
    if (!rows[0]) throw new Error(`period ${periodId} not found`);
    if (!rows[0].lockedAt) return rows[0];
    const before = { lockedAt: rows[0].lockedAt, lockedBy: rows[0].lockedBy };
    await tx
      .update(periods)
      .set({ lockedAt: null, lockedBy: null, updatedAt: new Date() })
      .where(eq(periods.id, periodId));
    await audit(
      {
        action: 'ledger.period.unlock',
        actorUserId: opts.actor.userId,
        actorEmail: opts.actor.email,
        actorRole: opts.actor.role,
        ip: opts.actor.ip,
        userAgent: opts.actor.userAgent,
        requestId: opts.actor.requestId,
        resourceType: 'period',
        resourceId: periodId,
        entityId,
        before,
        after: { lockedAt: null },
      },
      { tx }
    );
    return { ...rows[0], lockedAt: null, lockedBy: null };
  });
}

async function listPeriods(entityId) {
  if (!entityId) throw new Error('listPeriods: entityId required');
  const db = getDb();
  const { periods } = getSchema();
  return db
    .select()
    .from(periods)
    .where(eq(periods.entityId, entityId))
    .orderBy(periods.startDate);
}

module.exports = {
  upsertPeriod,
  lockPeriod,
  unlockPeriod,
  listPeriods,
};
