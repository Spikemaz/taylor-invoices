/**
 * Stage 9 — Invoicing dashboard metrics.
 *
 * Two functions, both pulling straight from `invoices`:
 *
 *   receivablesAging({ entityId, asOfDate })
 *     buckets unpaid invoices by overdue age. Reuses the same bucket
 *     boundaries as the Stage 8 `agedDebtors` report (current,
 *     1-30, 31-60, 61-90, 90+).
 *
 *   averageDaysToPay({ entityId, lookbackDays })
 *     for each contact, mean (paidAt - issueDate) across invoices
 *     fully paid in the lookback window. Returns the leaderboard
 *     sorted slowest-first.
 *
 * The Stage 8 report `agedDebtors` already exists for the trial-
 * balance side; this dashboard view is the *invoice-row* slant — it
 * groups by contact and pulls invoice-level metadata (invoice number,
 * due date) that the GL-only report doesn't have.
 */

const { and, eq, inArray, isNotNull } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');

function toDateString(d) {
  if (!d) throw new Error('date required');
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  throw new Error(`Invalid date: ${d}`);
}

function bucketForAge(days) {
  if (days <= 0) return 'current';
  if (days <= 30) return '1_30';
  if (days <= 60) return '31_60';
  if (days <= 90) return '61_90';
  return 'over_90';
}

function diffDays(a, b) {
  // both ISO date strings
  const ad = new Date(`${a}T00:00:00Z`).getTime();
  const bd = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((ad - bd) / (1000 * 60 * 60 * 24));
}

async function receivablesAging({ entityId, asOfDate }, opts = {}) {
  const today = toDateString(asOfDate);
  const db = opts.tx || getDb();
  const { invoices, contacts } = getSchema();

  const open = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.entityId, entityId), inArray(invoices.status, ['sent', 'partially_paid'])));

  const buckets = { current: 0, '1_30': 0, '31_60': 0, '61_90': 0, over_90: 0 };
  let totalPence = 0;
  const byContact = new Map();

  for (const inv of open) {
    const ageDays = diffDays(today, inv.dueDate);
    const bkt = bucketForAge(ageDays);
    const outstandingBase = Math.round((Number(inv.totalPence) - Number(inv.paidPence)) * Number(inv.fxRateToBase));
    buckets[bkt] += outstandingBase;
    totalPence += outstandingBase;
    if (inv.contactId) {
      const c = byContact.get(inv.contactId) || { contactId: inv.contactId, totalPence: 0, count: 0 };
      c.totalPence += outstandingBase;
      c.count += 1;
      byContact.set(inv.contactId, c);
    }
  }

  // Resolve contact names for the byContact map.
  const ids = [...byContact.keys()];
  const names = ids.length
    ? await db.select({ id: contacts.id, name: contacts.name }).from(contacts).where(inArray(contacts.id, ids))
    : [];
  const nameMap = new Map(names.map((r) => [r.id, r.name]));
  const byContactList = [...byContact.values()]
    .map((c) => ({ ...c, name: nameMap.get(c.contactId) || null }))
    .sort((a, b) => b.totalPence - a.totalPence);

  return {
    asOfDate: today,
    totalPence,
    buckets,
    byContact: byContactList,
  };
}

async function averageDaysToPay({ entityId, lookbackDays = 365 }, opts = {}) {
  const db = opts.tx || getDb();
  const { invoices, contacts } = getSchema();
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const paidRows = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.entityId, entityId),
        eq(invoices.status, 'paid'),
        isNotNull(invoices.paidAt)
      )
    );

  const byContact = new Map();
  for (const inv of paidRows) {
    if (!inv.paidAt) continue;
    const paidDate = toDateString(new Date(inv.paidAt));
    if (paidDate < cutoff) continue;
    const days = diffDays(paidDate, inv.issueDate);
    const key = inv.contactId || '__no_contact__';
    const c = byContact.get(key) || { contactId: inv.contactId, totalDays: 0, count: 0 };
    c.totalDays += days;
    c.count += 1;
    byContact.set(key, c);
  }

  const ids = [...byContact.keys()].filter((k) => k !== '__no_contact__');
  const names = ids.length
    ? await db.select({ id: contacts.id, name: contacts.name }).from(contacts).where(inArray(contacts.id, ids))
    : [];
  const nameMap = new Map(names.map((r) => [r.id, r.name]));

  const list = [...byContact.values()]
    .map((c) => ({
      contactId: c.contactId,
      name: c.contactId ? nameMap.get(c.contactId) || null : null,
      averageDaysToPay: c.count === 0 ? 0 : c.totalDays / c.count,
      invoiceCount: c.count,
    }))
    .sort((a, b) => b.averageDaysToPay - a.averageDaysToPay);

  const totalCount = list.reduce((a, x) => a + x.invoiceCount, 0);
  const portfolioAvg =
    totalCount === 0
      ? 0
      : list.reduce((a, x) => a + x.averageDaysToPay * x.invoiceCount, 0) / totalCount;

  return {
    lookbackDays,
    portfolioAverageDaysToPay: portfolioAvg,
    leaderboard: list, // slowest-first
  };
}

module.exports = { receivablesAging, averageDaysToPay };
