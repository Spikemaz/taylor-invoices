/**
 * Stage 9 — Recurring invoices.
 *
 * Templates carry the line items, frequency and next-run date. A
 * scheduled job (out of scope for this slice — see follow-up) calls
 * `generateDueRecurring(asOfDate)` periodically; the lib creates one
 * invoice per due template, advances `nextRunDate` and bumps
 * `generatedCount`. If `endDate` is passed, the template is set to
 * `ended`.
 *
 * Frequency advance uses calendar arithmetic, not 30-day fixed
 * windows, so monthly + day-31 correctly clamps to the last day of
 * the next month.
 */

const cryptoNode = require('crypto');
const { and, eq, lte } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { audit } = require('../audit-log');
const { createInvoice } = require('./invoices');

function newRecurringId() {
  return `rec_${cryptoNode.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function toDateString(d) {
  if (!d) throw new Error('date required');
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  throw new Error(`Invalid date: ${d}`);
}

const FREQUENCIES = new Set(['weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly']);

/**
 * Advance an ISO date by one occurrence of the given frequency.
 * Returns a new ISO date string (UTC).
 */
function advanceFrequency(dateStr, frequency) {
  if (!FREQUENCIES.has(frequency)) {
    throw new Error(`advanceFrequency: bad frequency ${frequency}`);
  }
  const [y, m, d] = toDateString(dateStr).split('-').map(Number);
  if (frequency === 'weekly' || frequency === 'fortnightly') {
    const days = frequency === 'weekly' ? 7 : 14;
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }
  // For monthly/quarterly/yearly, advance the (year, month) tuple and
  // clamp the day to the last day of the target month so e.g. Jan 31
  // → Feb 28/29 (not March 3, which is what naïve setUTCMonth gives).
  let monthsToAdd;
  if (frequency === 'monthly') monthsToAdd = 1;
  else if (frequency === 'quarterly') monthsToAdd = 3;
  else if (frequency === 'yearly') monthsToAdd = 12;
  else throw new Error(`unreachable: ${frequency}`);
  const totalMonths = (y * 12 + (m - 1)) + monthsToAdd;
  const ny = Math.floor(totalMonths / 12);
  const nm = (totalMonths % 12) + 1; // 1..12
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate(); // day 0 of next month
  const nd = Math.min(d, lastDay);
  const dt = new Date(Date.UTC(ny, nm - 1, nd));
  return dt.toISOString().slice(0, 10);
}

async function createTemplate(input, opts = {}) {
  const {
    entityId,
    contactId,
    frequency,
    startDate,
    endDate,
    paymentTermsDays = 30,
    currency = 'GBP',
    totalPence,
    lineItems = [],
    notes,
    actor,
  } = input;
  if (!entityId) throw new Error('createTemplate: entityId required');
  if (!contactId) throw new Error('createTemplate: contactId required');
  if (!FREQUENCIES.has(frequency)) {
    throw new Error(`createTemplate: bad frequency ${frequency}`);
  }
  if (!Number.isInteger(totalPence) || totalPence <= 0) {
    throw new Error('createTemplate: totalPence must be positive integer pence');
  }
  const start = toDateString(startDate);
  const end = endDate ? toDateString(endDate) : null;
  if (end && end < start) throw new Error('createTemplate: endDate before startDate');

  const db = opts.tx || getDb();
  const { recurringInvoices } = getSchema();
  const id = newRecurringId();
  await db.insert(recurringInvoices).values({
    id,
    entityId,
    contactId,
    frequency,
    status: 'active',
    startDate: start,
    endDate: end,
    nextRunDate: start, // first run is the start date itself
    paymentTermsDays,
    currency,
    totalPence,
    lineItems,
    notes: notes || null,
    createdBy: actor?.userId || null,
  });
  await audit(
    {
      action: 'recurring_invoice.create',
      actorUserId: actor?.userId,
      actorRole: actor?.role,
      resourceType: 'recurring_invoice',
      resourceId: id,
      entityId,
      after: { contactId, frequency, startDate: start, endDate: end, totalPence },
    },
    { tx: opts.tx }
  );
  return { id };
}

async function pauseTemplate(id, opts = {}) {
  const db = opts.tx || getDb();
  const { recurringInvoices } = getSchema();
  await db
    .update(recurringInvoices)
    .set({ status: 'paused', updatedAt: new Date() })
    .where(eq(recurringInvoices.id, id));
}

async function resumeTemplate(id, opts = {}) {
  const db = opts.tx || getDb();
  const { recurringInvoices } = getSchema();
  await db
    .update(recurringInvoices)
    .set({ status: 'active', updatedAt: new Date() })
    .where(eq(recurringInvoices.id, id));
}

/**
 * For every active template whose nextRunDate is on/before asOfDate,
 * generate one invoice and advance nextRunDate. Stops scheduling once
 * nextRunDate would exceed endDate (template set to `ended`).
 *
 * Returns a list of `{ templateId, invoiceId, issueDate }` for what
 * was generated.
 */
async function generateDueRecurring({ asOfDate, entityId, actor }, opts = {}) {
  const today = toDateString(asOfDate);
  const { recurringInvoices } = getSchema();

  const conds = [eq(recurringInvoices.status, 'active'), lte(recurringInvoices.nextRunDate, today)];
  if (entityId) conds.push(eq(recurringInvoices.entityId, entityId));

  const outerDb = opts.tx || getDb();
  const due = await outerDb
    .select()
    .from(recurringInvoices)
    .where(and(...conds));

  const results = [];
  for (const tpl of due) {
    // Each template is generated atomically: invoice creation +
    // template advance + audit happen in the same tx, so a failure
    // mid-flow rolls back together (no orphan invoice / non-advanced
    // template that would re-issue duplicates next run).
    const runner = opts.tx ? (cb) => cb(opts.tx) : (cb) => getDb().transaction(cb);
    const r = await runner(async (tx) => {
      const issueDate = tpl.nextRunDate;
      const number = `REC-${tpl.id.slice(4, 10)}-${tpl.generatedCount + 1}`;

      const invoice = await createInvoice(
        {
          entityId: tpl.entityId,
          invoiceNumber: number,
          contactId: tpl.contactId,
          issueDate,
          paymentTermsDays: tpl.paymentTermsDays,
          currency: tpl.currency,
          fxRateToBase: 1, // recurring + multi-currency interaction is a follow-up
          totalPence: Number(tpl.totalPence),
          lineItems: tpl.lineItems,
          recurringId: tpl.id,
          notes: tpl.notes,
          actor,
        },
        { tx }
      );

      const advanced = advanceFrequency(issueDate, tpl.frequency);
      const exhausted = tpl.endDate && advanced > tpl.endDate;

      await tx
        .update(recurringInvoices)
        .set({
          nextRunDate: exhausted ? tpl.endDate : advanced,
          status: exhausted ? 'ended' : 'active',
          lastGeneratedAt: new Date(),
          generatedCount: tpl.generatedCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(recurringInvoices.id, tpl.id));

      await audit(
        {
          action: 'recurring_invoice.generate',
          actorUserId: actor?.userId,
          actorRole: actor?.role || 'system',
          resourceType: 'recurring_invoice',
          resourceId: tpl.id,
          entityId: tpl.entityId,
          after: {
            invoiceId: invoice.id,
            issueDate,
            newNextRunDate: exhausted ? null : advanced,
            ended: !!exhausted,
          },
        },
        { tx }
      );

      return { templateId: tpl.id, invoiceId: invoice.id, issueDate, ended: !!exhausted };
    });
    results.push(r);
  }

  return results;
}

async function getTemplate(id, opts = {}) {
  const db = opts.tx || getDb();
  const { recurringInvoices } = getSchema();
  const rows = await db.select().from(recurringInvoices).where(eq(recurringInvoices.id, id)).limit(1);
  return rows[0] || null;
}

module.exports = {
  createTemplate,
  pauseTemplate,
  resumeTemplate,
  generateDueRecurring,
  advanceFrequency,
  getTemplate,
};
