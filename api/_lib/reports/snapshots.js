/**
 * Stage 8 — Report snapshots.
 *
 * `saveSnapshot` writes an immutable JSON capture of a computed report
 * to `report_snapshots`. Year-end lock takes a snapshot of every
 * standard report so the figures can be reproduced exactly even if the
 * underlying journals change later.
 *
 * Snapshots are append-only: there's no update / delete API. The
 * (entity_id, kind, period_end) index lets the UI list "all P&L
 * snapshots for entityX" cheaply.
 */

const cryptoNode = require('crypto');
const { getDb, getSchema } = require('../db');
const { eq, and, desc } = require('drizzle-orm');

function newSnapshotId() {
  return `snap_${cryptoNode.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

async function saveSnapshot(input, opts = {}) {
  const { entityId, kind, periodStart, periodEnd, fiscalYear, payload, generatedBy } = input;
  if (!entityId || !kind || !periodStart || !periodEnd || !payload) {
    throw new Error('saveSnapshot: entityId/kind/periodStart/periodEnd/payload required');
  }
  const db = opts.tx || getDb();
  const { reportSnapshots } = getSchema();
  const id = newSnapshotId();
  await db.insert(reportSnapshots).values({
    id,
    entityId,
    kind,
    periodStart,
    periodEnd,
    fiscalYear: fiscalYear ?? null,
    generatedAt: new Date(),
    generatedBy: generatedBy ?? null,
    payload,
  });
  return { id };
}

async function listSnapshots(entityId, opts = {}) {
  if (!entityId) throw new Error('listSnapshots: entityId required');
  const db = opts.tx || getDb();
  const { reportSnapshots } = getSchema();
  const conds = [eq(reportSnapshots.entityId, entityId)];
  if (opts.kind) conds.push(eq(reportSnapshots.kind, opts.kind));
  return db
    .select()
    .from(reportSnapshots)
    .where(and(...conds))
    .orderBy(desc(reportSnapshots.periodEnd), desc(reportSnapshots.generatedAt));
}

module.exports = { saveSnapshot, listSnapshots };
