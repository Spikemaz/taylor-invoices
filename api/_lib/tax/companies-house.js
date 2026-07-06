/**
 * Stage 6 — Companies House filing reminders.
 *
 * Slice 1 ships CRUD on the `companies_house_filings` table plus a
 * lightweight overdue/upcoming classifier that the dashboard widget
 * will surface (30 / 14 / 7 day reminders).
 *
 * No HMRC / Companies House API integration in this slice — that's
 * deferred to a follow-up alongside the MTD VAT submission work.
 */

const crypto = require('crypto');
const { and, asc, eq, sql } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');

function newFilingId() { return `chf_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`; }

async function createFiling(input, opts = {}) {
  const required = ['entityId', 'kind', 'dueDate'];
  for (const k of required) if (input[k] == null) throw new Error(`createFiling: ${k} required`);
  const id = newFilingId();
  const writer = opts.tx || getDb();
  const { companiesHouseFilings } = getSchema();
  await writer.insert(companiesHouseFilings).values({
    id,
    entityId: input.entityId,
    kind: input.kind,
    dueDate: input.dueDate,
    feePence: input.feePence ?? null,
    status: input.status || 'upcoming',
    notes: input.notes || null,
  });
  return { id };
}

async function listFilings(entityId, opts = {}) {
  const reader = opts.tx || getDb();
  const { companiesHouseFilings } = getSchema();
  return reader
    .select()
    .from(companiesHouseFilings)
    .where(eq(companiesHouseFilings.entityId, entityId))
    .orderBy(asc(companiesHouseFilings.dueDate));
}

async function markFiled(entityId, id, completedDate, opts = {}) {
  const writer = opts.tx || getDb();
  const { companiesHouseFilings } = getSchema();
  await writer
    .update(companiesHouseFilings)
    .set({ status: 'filed', completedDate, updatedAt: new Date() })
    .where(and(eq(companiesHouseFilings.entityId, entityId), eq(companiesHouseFilings.id, id)));
  return { ok: true };
}

/**
 * Returns filings grouped into reminder buckets for the dashboard.
 * Updates 'upcoming' rows to 'overdue' when their due date has passed.
 */
async function getReminderState(entityId, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const writer = opts.tx || getDb();
  const { companiesHouseFilings } = getSchema();
  // Promote past-due upcoming → overdue.
  await writer
    .update(companiesHouseFilings)
    .set({ status: 'overdue', updatedAt: new Date() })
    .where(
      and(
        eq(companiesHouseFilings.entityId, entityId),
        eq(companiesHouseFilings.status, 'upcoming'),
        sql`${companiesHouseFilings.dueDate} < ${today}`
      )
    );
  const all = await listFilings(entityId, { tx: writer });
  const todayMs = new Date(`${today}T00:00:00Z`).getTime();
  const buckets = { overdue: [], in7days: [], in14days: [], in30days: [], later: [], filed: [] };
  for (const f of all) {
    if (f.status === 'filed') { buckets.filed.push(f); continue; }
    const dueMs = new Date(`${f.dueDate}T00:00:00Z`).getTime();
    const days = Math.round((dueMs - todayMs) / (1000 * 60 * 60 * 24));
    if (days < 0) buckets.overdue.push({ ...f, daysOverdue: -days });
    else if (days <= 7)  buckets.in7days.push({ ...f, daysUntilDue: days });
    else if (days <= 14) buckets.in14days.push({ ...f, daysUntilDue: days });
    else if (days <= 30) buckets.in30days.push({ ...f, daysUntilDue: days });
    else                 buckets.later.push({ ...f, daysUntilDue: days });
  }
  return { today, buckets };
}

module.exports = { createFiling, listFilings, markFiled, getReminderState };
