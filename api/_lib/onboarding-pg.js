/**
 * Atomic onboarding (Postgres path) — Stage 0 foundations.
 *
 * Wired up but NOT exposed as a public route until the cutover. The legacy
 * `submit.js` keeps serving live booksiq.app. This module exports a function
 * the (eventual) replacement handler will call when DB_BACKEND=postgres.
 *
 * Contract:
 *   - Insert user + entity + audit rows in a single transaction. The audit
 *     row is written via the same `tx` handle so a rollback takes the audit
 *     trail with it (no ghost rows for never-created users).
 *   - This module is intentionally DB-only. Drive resource provisioning
 *     (sheets/folders) is the caller's responsibility and runs AFTER this
 *     function returns successfully — Drive doesn't support transactions, so
 *     making it part of an atomic unit isn't possible. The enqueue-on-Drive-
 *     failure pattern (a `provision_drive` job to retry from the worker)
 *     ships with the cutover handler that wraps this function; here we
 *     guarantee only that the DB is left consistent.
 *
 * This solves the "partial failures leave orphaned Drive folders or
 * unregistered users" issue from the QA report.
 */

const crypto = require('crypto');
const { getDb, getSchema } = require('./db');
const { audit } = require('./audit-log');

/**
 * @param {object} opts
 * @param {object} opts.user           { name, email, phone, address, firstName, middleNames, surname }
 * @param {object} opts.entityType     { self: bool, ltd: bool }
 * @param {object} [opts.selfEmployed] sole-trader entity payload
 * @param {object} [opts.ltdCompany]   ltd-co entity payload
 * @param {string} [opts.consentedAt]  ISO timestamp
 * @param {object} [opts.requestMeta]  { ip, userAgent, requestId } for audit
 *
 * @returns {Promise<{ userId: string, entityIds: string[] }>}
 */
async function atomicOnboard(opts) {
  const { user, entityType, selfEmployed, ltdCompany, consentedAt, requestMeta } = opts;
  validateInput(opts);

  const db = getDb();
  const { users, entities } = getSchema();

  const email = user.email.toLowerCase().trim();
  const userId = `user_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date();

  // The whole "create user + create entities" sequence runs in a single
  // transaction. Either everything lands or nothing does — the orphan rows
  // case from the QA report is impossible here.
  return db.transaction(async (tx) => {
    // Uniqueness check inside the txn — the unique index does the real
    // enforcement, but the explicit check gives us a clean error message.
    const existing = await tx.query.users.findFirst({
      where: (u, { eq, sql }) => sql`lower(${u.email}) = ${email}`,
    });
    if (existing) {
      const err = new Error('An account with this email already exists');
      err.code = 'EMAIL_TAKEN';
      throw err;
    }

    await tx.insert(users).values({
      id: userId,
      email,
      name: user.name,
      role: 'user',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    const entityIds = [];
    if (entityType.self && selfEmployed) {
      const id = `ent_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      entityIds.push(id);
      await tx.insert(entities).values({
        id,
        userId,
        name: selfEmployed.tradingName || user.name,
        type: 'sole_trader',
        tradingName: selfEmployed.tradingName || null,
        defaultCurrency: 'GBP',
        isDefault: !entityType.ltd,
        createdAt: now,
        updatedAt: now,
      });
    }
    if (entityType.ltd && ltdCompany) {
      const id = `ent_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      entityIds.push(id);
      await tx.insert(entities).values({
        id,
        userId,
        name: ltdCompany.companyName,
        type: 'limited',
        tradingName: ltdCompany.companyName,
        companyNumber: ltdCompany.companyNo || null,
        defaultCurrency: 'GBP',
        isDefault: !entityType.self,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Audit inside the txn — must use the `tx` handle, otherwise the audit
    // write would go through the global pool on a separate connection and
    // survive a rollback. We pass `{ tx }` so audit() routes through this
    // transaction; a failed audit insert will roll the whole thing back.
    await audit(
      {
        action: 'user.onboard',
        actorUserId: null, // SYSTEM (signup is unauthenticated)
        resourceType: 'user',
        resourceId: userId,
        after: { email, name: user.name, entityIds },
        metadata: { consentedAt: consentedAt || now.toISOString() },
        ip: requestMeta?.ip,
        userAgent: requestMeta?.userAgent,
        requestId: requestMeta?.requestId,
      },
      { tx }
    );

    return { userId, entityIds };
  });
}

function validateInput(opts) {
  const { user, entityType } = opts || {};
  if (!user?.name || !user?.email || !user?.phone || !user?.address) {
    const e = new Error('Missing required user fields');
    e.code = 'BAD_INPUT';
    throw e;
  }
  if (!entityType?.self && !entityType?.ltd) {
    const e = new Error('At least one business type is required');
    e.code = 'BAD_INPUT';
    throw e;
  }
  if (entityType.self && !opts.selfEmployed) {
    const e = new Error('selfEmployed payload required when entityType.self is true');
    e.code = 'BAD_INPUT';
    throw e;
  }
  if (entityType.ltd && !opts.ltdCompany?.companyName) {
    const e = new Error('ltdCompany.companyName required when entityType.ltd is true');
    e.code = 'BAD_INPUT';
    throw e;
  }
}

module.exports = { atomicOnboard };
