/**
 * Stage 9 — Contacts (customers / suppliers).
 *
 * Lightweight CRUD over the `contacts` table. Contacts are the spine
 * for invoices, quotes, recurring templates, statements and reminders;
 * every customer-facing artefact pivots on `contactId`.
 *
 * Identity / dedupe is the caller's responsibility — two contacts with
 * the same name in different entities is fine, and even within one
 * entity (e.g. "John Smith Ltd" + "John Smith Sole Trader") is
 * legitimate. The lib exposes a `findByName` helper for callers that
 * want to detect duplicates before insert.
 */

const cryptoNode = require('crypto');
const { and, eq } = require('drizzle-orm');
const { getDb, getSchema } = require('../db');
const { audit } = require('../audit-log');

function newContactId() {
  return `con_${cryptoNode.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

const VALID_TYPES = new Set(['customer', 'supplier', 'both']);

async function createContact(input, opts = {}) {
  const {
    entityId,
    type = 'customer',
    name,
    email,
    phone,
    addressLine1,
    addressLine2,
    city,
    postcode,
    country = 'GB',
    defaultCurrency = 'GBP',
    paymentTermsDays = 30,
    notes,
    actor,
  } = input;
  if (!entityId) throw new Error('createContact: entityId required');
  if (!name || !name.trim()) throw new Error('createContact: name required');
  if (!VALID_TYPES.has(type)) throw new Error(`createContact: bad type ${type}`);
  if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0) {
    throw new Error('createContact: paymentTermsDays must be a non-negative integer');
  }
  const db = opts.tx || getDb();
  const { contacts } = getSchema();
  const id = newContactId();
  await db.insert(contacts).values({
    id,
    entityId,
    type,
    name: name.trim(),
    email: email || null,
    phone: phone || null,
    addressLine1: addressLine1 || null,
    addressLine2: addressLine2 || null,
    city: city || null,
    postcode: postcode || null,
    country,
    defaultCurrency,
    paymentTermsDays,
    notes: notes || null,
    createdBy: actor?.userId || null,
  });
  await audit(
    {
      action: 'contact.create',
      actorUserId: actor?.userId,
      actorEmail: actor?.email,
      actorRole: actor?.role,
      resourceType: 'contact',
      resourceId: id,
      entityId,
      after: { name: name.trim(), type, defaultCurrency, paymentTermsDays },
    },
    { tx: opts.tx }
  );
  return { id };
}

async function updateContact(id, patch, opts = {}) {
  if (!id) throw new Error('updateContact: id required');
  const db = opts.tx || getDb();
  const { contacts } = getSchema();
  const allowed = [
    'type',
    'name',
    'email',
    'phone',
    'addressLine1',
    'addressLine2',
    'city',
    'postcode',
    'country',
    'defaultCurrency',
    'paymentTermsDays',
    'notes',
    'archived',
  ];
  const updates = {};
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) updates[k] = patch[k];
  }
  if (updates.type && !VALID_TYPES.has(updates.type)) {
    throw new Error(`updateContact: bad type ${updates.type}`);
  }
  updates.updatedAt = new Date();
  await db.update(contacts).set(updates).where(eq(contacts.id, id));
  await audit(
    {
      action: 'contact.update',
      actorUserId: patch.actor?.userId,
      resourceType: 'contact',
      resourceId: id,
      after: updates,
    },
    { tx: opts.tx }
  );
}

async function getContact(id, opts = {}) {
  const db = opts.tx || getDb();
  const { contacts } = getSchema();
  const rows = await db.select().from(contacts).where(eq(contacts.id, id)).limit(1);
  return rows[0] || null;
}

async function findByName({ entityId, name }, opts = {}) {
  const db = opts.tx || getDb();
  const { contacts } = getSchema();
  return db
    .select()
    .from(contacts)
    .where(and(eq(contacts.entityId, entityId), eq(contacts.name, name)));
}

async function listContacts({ entityId, type, includeArchived = false }, opts = {}) {
  const db = opts.tx || getDb();
  const { contacts } = getSchema();
  const conds = [eq(contacts.entityId, entityId)];
  if (type) conds.push(eq(contacts.type, type));
  if (!includeArchived) conds.push(eq(contacts.archived, false));
  return db
    .select()
    .from(contacts)
    .where(conds.length > 1 ? and(...conds) : conds[0]);
}

async function archiveContact(id, opts = {}) {
  return updateContact(id, { archived: true, actor: opts.actor }, opts);
}

module.exports = {
  createContact,
  updateContact,
  getContact,
  findByName,
  listContacts,
  archiveContact,
};
