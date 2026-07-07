/**
 * IAccountant — idempotent provisioning of the Postgres read-model
 * scaffolding for a logged-in (Sheets-era) BooksIQ user.
 *
 * A user is identified by a signed session (userId, email, name, sheetId,
 * ...). The double-entry read-model needs:
 *   - a `users` row keyed by that userId
 *   - one `entities` row per business type the user trades as
 *     (sole_trader + limited — the canonical dental-hygienist case)
 *   - a seeded UK Chart of Accounts per entity
 *
 * This module creates exactly that, idempotently: re-running is a no-op.
 * It deliberately does NOT use atomicOnboard() (which is for brand-new
 * signups and enforces email-uniqueness / fresh-user invariants).
 *
 * Tenant safety: the caller passes the *verified* session; we only ever
 * write rows keyed to session.userId. No caller-supplied entityId is
 * trusted anywhere in IAccountant.
 */

const crypto = require('crypto');
const { getDb, getSchema } = require('../db');
const { eq, and, sql } = require('drizzle-orm');
const { seedAccountsForEntity } = require('../ledger/accounts');

// The entity types every hygienist account is provisioned with.
const PROVISIONED_TYPES = ['sole_trader', 'limited'];

function newEntityId() {
  return `ent_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function defaultEntityName(type, session) {
  const who = session && session.name ? String(session.name).trim() : '';
  if (type === 'sole_trader') return who ? `${who} (Sole Trader)` : 'Sole Trader';
  if (type === 'limited') return who ? `${who} Ltd` : 'Limited Company';
  return type;
}

async function upsertUser(tx, session) {
  const { users } = getSchema();
  const now = new Date();
  const row = {
    id: session.userId,
    email: session.email || `${session.userId}@unknown.local`,
    name: session.name || session.email || session.userId,
    status: 'active',
    sheetId: session.sheetId || null,
    driveFolderId: session.driveFolderId || null,
    backupSheetId: session.backupSheetId || null,
    backupFolderId: session.backupFolderId || null,
    updatedAt: now,
  };
  await tx
    .insert(users)
    .values(row)
    .onConflictDoUpdate({
      target: users.id,
      set: {
        email: row.email,
        name: row.name,
        sheetId: row.sheetId,
        driveFolderId: row.driveFolderId,
        backupSheetId: row.backupSheetId,
        backupFolderId: row.backupFolderId,
        updatedAt: now,
      },
    });
}

async function ensureEntity(tx, userId, type, session) {
  const { entities } = getSchema();
  const existing = await tx
    .select()
    .from(entities)
    .where(and(eq(entities.userId, userId), eq(entities.type, type)))
    .limit(1);
  if (existing[0]) return { entity: existing[0], created: false };

  const row = {
    id: newEntityId(),
    userId,
    name: defaultEntityName(type, session),
    type,
    isDefault: type === 'sole_trader',
  };
  await tx.insert(entities).values(row);
  return { entity: row, created: true };
}

/**
 * Ensure the user, their two entities, and seeded charts of accounts all
 * exist. Idempotent and safe to call on every IAccountant load.
 *
 * @param {object} session  verified session payload from requireSession()
 * @returns {Promise<{userId:string, entities:Array<{id,type,name,created,accountsSeeded}>}>}
 */
async function ensureAccountantUserAndEntities(session) {
  if (!session || !session.userId) {
    throw new Error('ensureAccountantUserAndEntities: a valid session is required');
  }
  const db = getDb();
  const entitiesOut = await db.transaction(async (tx) => {
    // Serialize provisioning per-user so concurrent dashboard/refresh calls
    // can't race select-then-insert and create duplicate entities. The lock
    // is transaction-scoped — auto-released on commit/rollback.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${session.userId})::int8)`);
    await upsertUser(tx, session);
    const out = [];
    for (const type of PROVISIONED_TYPES) {
      const { entity, created } = await ensureEntity(tx, session.userId, type, session);
      const seed = await seedAccountsForEntity(entity.id, type, { tx });
      out.push({
        id: entity.id,
        type,
        name: entity.name,
        created,
        accountsSeeded: seed.inserted,
      });
    }
    return out;
  });
  return { userId: session.userId, entities: entitiesOut };
}

module.exports = { ensureAccountantUserAndEntities, PROVISIONED_TYPES };
