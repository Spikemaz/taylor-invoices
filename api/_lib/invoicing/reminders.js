/**
 * Stage 9 — Reminder rules + scheduling.
 *
 * `createRule` defines a template ("7 days before due", "3 days
 * overdue", etc.) at the entity level.
 *
 * `computeDueReminders({ entityId, asOfDate })` walks every active
 * rule × every unpaid invoice for the entity, computes the scheduled
 * date (`dueDate ± offset`), and writes a `reminder_log` row when
 * `scheduledFor <= asOfDate` and one doesn't already exist for that
 * (invoice, rule, scheduledFor) tuple. The unique index on
 * `(invoice_id, rule_id, scheduled_for)` is what makes this safe to
 * re-run idempotently.
 *
 * Email transport is a follow-up — `sentAt` stays NULL until the
 * delivery worker (also a follow-up) flips it once SMTP/Resend has
 * acknowledged.
 */

const cryptoNode = require('crypto');
const { and, eq, inArray, ne } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { audit } = require('../audit-log');

function newRuleId() {
  return `rrl_${cryptoNode.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
function newLogId() {
  return `rlg_${cryptoNode.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

const VALID_TRIGGERS = new Set(['before_due', 'on_due', 'after_due']);

function toDateString(d) {
  if (!d) throw new Error('date required');
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  throw new Error(`Invalid date: ${d}`);
}

function shiftISO(dateStr, days) {
  const d = new Date(`${toDateString(dateStr)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function createRule(input, opts = {}) {
  const {
    entityId,
    name,
    trigger,
    daysOffset = 0,
    templateSubject,
    templateBody,
    actor,
  } = input;
  if (!entityId) throw new Error('createRule: entityId required');
  if (!name) throw new Error('createRule: name required');
  if (!VALID_TRIGGERS.has(trigger)) throw new Error(`createRule: bad trigger ${trigger}`);
  if (!Number.isInteger(daysOffset) || daysOffset < 0) {
    throw new Error('createRule: daysOffset must be non-negative integer');
  }
  if (!templateSubject) throw new Error('createRule: templateSubject required');
  if (!templateBody) throw new Error('createRule: templateBody required');

  const db = opts.tx || getDb();
  const { reminderRules } = getSchema();
  const id = newRuleId();
  await db.insert(reminderRules).values({
    id,
    entityId,
    name,
    trigger,
    daysOffset,
    templateSubject,
    templateBody,
    active: true,
  });
  await audit(
    {
      action: 'reminder_rule.create',
      actorUserId: actor?.userId,
      resourceType: 'reminder_rule',
      resourceId: id,
      entityId,
      after: { name, trigger, daysOffset },
    },
    { tx: opts.tx }
  );
  return { id };
}

/**
 * Resolve the scheduled date for a rule applied to an invoice.
 * trigger=before_due: dueDate - offset
 * trigger=on_due:     dueDate
 * trigger=after_due:  dueDate + offset
 */
function scheduledDateFor(rule, dueDate) {
  switch (rule.trigger) {
    case 'before_due':
      return shiftISO(dueDate, -rule.daysOffset);
    case 'on_due':
      return toDateString(dueDate);
    case 'after_due':
      return shiftISO(dueDate, rule.daysOffset);
    default:
      throw new Error(`scheduledDateFor: bad trigger ${rule.trigger}`);
  }
}

/**
 * For every active rule × every unpaid invoice, write a reminder_log
 * row when scheduledFor <= asOfDate. The unique index keeps this
 * idempotent on retry. Returns the rows that were newly inserted on
 * THIS call.
 */
async function computeDueReminders({ entityId, asOfDate, actor }, opts = {}) {
  const today = toDateString(asOfDate);
  const db = opts.tx || getDb();
  const { reminderRules, invoices, reminderLog } = getSchema();

  const rules = await db
    .select()
    .from(reminderRules)
    .where(and(eq(reminderRules.entityId, entityId), eq(reminderRules.active, true)));
  if (rules.length === 0) return [];

  // Unpaid = anything not in {'paid', 'void'}. We pull `sent` and
  // `partially_paid` and `draft` (drafts don't get reminders, but
  // we filter them out below).
  const openInvoices = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.entityId, entityId), inArray(invoices.status, ['sent', 'partially_paid'])));

  const inserted = [];
  for (const inv of openInvoices) {
    for (const rule of rules) {
      const scheduledFor = scheduledDateFor(rule, inv.dueDate);
      if (scheduledFor > today) continue;
      const existing = await db
        .select({ id: reminderLog.id })
        .from(reminderLog)
        .where(
          and(
            eq(reminderLog.invoiceId, inv.id),
            eq(reminderLog.ruleId, rule.id),
            eq(reminderLog.scheduledFor, scheduledFor)
          )
        )
        .limit(1);
      if (existing[0]) continue;
      const id = newLogId();
      try {
        await db.insert(reminderLog).values({
          id,
          invoiceId: inv.id,
          ruleId: rule.id,
          scheduledFor,
          channel: 'email',
        });
        inserted.push({ id, invoiceId: inv.id, ruleId: rule.id, scheduledFor });
      } catch (err) {
        // Unique-violation race — another worker beat us to this slot;
        // safe to skip silently.
        if (!/duplicate key/.test(String(err?.message))) throw err;
      }
    }
  }

  if (inserted.length > 0) {
    await audit(
      {
        action: 'reminders.compute',
        actorUserId: actor?.userId || null,
        actorRole: actor?.role || 'system',
        resourceType: 'reminder_log',
        entityId,
        after: { count: inserted.length, asOfDate: today },
      },
      { tx: opts.tx }
    );
  }
  return inserted;
}

async function markReminderSent(id, opts = {}) {
  const db = opts.tx || getDb();
  const { reminderLog } = getSchema();
  await db.update(reminderLog).set({ sentAt: new Date() }).where(eq(reminderLog.id, id));
}

module.exports = {
  createRule,
  scheduledDateFor,
  computeDueReminders,
  markReminderSent,
};
