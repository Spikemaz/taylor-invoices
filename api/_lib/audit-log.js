/**
 * Audit log helper.
 *
 * Records every mutation with: who, when, what, before/after, ip/ua.
 * HMRC defensibility requires this. Stage 0 ships the helper — Stages 1+
 * call it from every mutation.
 *
 * Design notes:
 *  - Writes are best-effort: if Postgres is unreachable we log to stderr but
 *    DO NOT fail the request. Audit logging must never block real work.
 *  - When DB_BACKEND=sheets, falls back to a structured stderr log so we
 *    still have a tail. The Postgres rows become the source of truth once
 *    we cut over.
 *  - JSON snapshots are taken on the caller side (we don't try to be clever
 *    here — caller knows which fields are sensitive and should be redacted).
 */

const { isPostgresEnabled, isDualWriteEnabled, getDb, getSchema } = require('./db');

/**
 * Write an audit entry.
 *
 * @param {object} entry
 * @param {string} entry.action            "invoice.create", "auth.login", ...
 * @param {string} [entry.resourceType]    "invoice" | "entry" | "user" | ...
 * @param {string} [entry.resourceId]
 * @param {string} [entry.entityId]
 * @param {string} [entry.actorUserId]     null = SYSTEM
 * @param {string} [entry.actorEmail]
 * @param {string} [entry.actorRole]
 * @param {string} [entry.onBehalfOfUserId] when admin uses master override
 * @param {string} [entry.ip]
 * @param {string} [entry.userAgent]
 * @param {string} [entry.requestId]
 * @param {object} [entry.before]          previous state snapshot
 * @param {object} [entry.after]           new state snapshot
 * @param {object} [entry.diff]            optional precomputed diff
 * @param {object} [entry.metadata]        anything else
 *
 * @param {object} [opts]
 * @param {object} [opts.tx]   Drizzle transaction handle. If passed, the
 *                             audit row is inserted via `tx` so it shares
 *                             the caller's transaction (rolls back together
 *                             on failure). Without `tx`, the global pool is
 *                             used and the audit row is independent of any
 *                             outer transaction.
 *
 * @returns {Promise<void>}
 */
async function audit(entry, opts = {}) {
  if (!entry || !entry.action) {
    console.warn('[audit] called without action — ignoring');
    return;
  }

  // Always write a structured stderr line so we have a paper trail even when
  // Postgres is off.
  try {
    const stderrLine = {
      type: 'audit',
      ts: new Date().toISOString(),
      action: entry.action,
      actor: entry.actorUserId || 'SYSTEM',
      actorEmail: entry.actorEmail,
      onBehalfOf: entry.onBehalfOfUserId,
      resource: entry.resourceType
        ? `${entry.resourceType}:${entry.resourceId || '-'}`
        : undefined,
      entityId: entry.entityId,
      ip: entry.ip,
    };
    console.log('[audit]', JSON.stringify(stderrLine));
  } catch (_) {
    /* ignore log formatting errors */
  }

  if (!isPostgresEnabled() && !isDualWriteEnabled()) return;

  // If a transaction handle is supplied, write through it so the audit row
  // is part of the caller's atomic unit of work. Otherwise use the global
  // pool — and DO NOT swallow errors silently when the caller passed `tx`,
  // because that would defeat the whole point of putting audit in the txn.
  const useTx = !!opts.tx;
  const dbHandle = useTx ? opts.tx : null;

  try {
    const { auditLog } = getSchema();
    const writer = dbHandle || getDb();
    await writer.insert(auditLog).values({
      action: entry.action,
      resourceType: entry.resourceType || null,
      resourceId: entry.resourceId || null,
      entityId: entry.entityId || null,
      actorUserId: entry.actorUserId || null,
      actorEmail: entry.actorEmail || null,
      actorRole: entry.actorRole || null,
      onBehalfOfUserId: entry.onBehalfOfUserId || null,
      ip: entry.ip || null,
      userAgent: entry.userAgent || null,
      requestId: entry.requestId || null,
      before: entry.before ? safeJson(entry.before) : null,
      after: entry.after ? safeJson(entry.after) : null,
      diff: entry.diff ? safeJson(entry.diff) : null,
      metadata: entry.metadata ? safeJson(entry.metadata) : null,
    });
  } catch (err) {
    if (useTx) {
      // Caller asked for transactional semantics — propagate so the outer
      // transaction rolls back. Defeats "ghost" rows on partial commit.
      throw err;
    }
    // Best-effort otherwise: never let an audit-write failure block the
    // request when the caller didn't ask for atomicity.
    console.error('[audit] db write failed (non-fatal):', err.message);
  }
}

/**
 * Convenience wrapper for actions performed by an authenticated user.
 * Pass the session object from requireSession() and any extras.
 */
function auditFromSession(session, action, extras = {}) {
  return audit({
    action,
    actorUserId: session?.userId,
    actorEmail: session?.email,
    actorRole: session?.role,
    onBehalfOfUserId: session?.onBehalfOf,
    ...extras,
  });
}

/**
 * Strip undefineds and serialize to a structure jsonb can store. Drops
 * cycles and functions. Caller is responsible for redacting secrets.
 */
function safeJson(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (_) {
    return { _note: 'audit safeJson failed', _string: String(obj).slice(0, 500) };
  }
}

module.exports = { audit, auditFromSession };
