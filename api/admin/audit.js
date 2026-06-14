/**
 * GET /api/admin/audit
 *
 * Read-only admin view of the audit log. Filters: actorUserId, resourceType,
 * resourceId, action, since, until, limit (max 500).
 *
 * Stage 0: returns [] when DB_BACKEND=sheets so the admin UI can call this
 * unconditionally without 500s during the dual-write rollout.
 */

const { requireSession, applyCors } = require('../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled, getDb, getSchema } = require('../_lib/db');
const { sql, and, eq, gte, lte, desc } = require('drizzle-orm');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const session = await requireSession(req, res);
  if (!session) return; // requireSession already responded
  if (session.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  if (!isPostgresEnabled() && !isDualWriteEnabled()) {
    return res.status(200).json({
      ok: true,
      backend: 'sheets',
      message: 'Audit log is Postgres-only — DB_BACKEND=sheets so log is empty here',
      rows: [],
    });
  }

  try {
    const db = getDb();
    const { auditLog } = getSchema();
    const limit = clampInt(req.query?.limit, 50, 1, 500);
    const conds = [];

    if (req.query?.actorUserId) conds.push(eq(auditLog.actorUserId, String(req.query.actorUserId)));
    if (req.query?.resourceType) conds.push(eq(auditLog.resourceType, String(req.query.resourceType)));
    if (req.query?.resourceId) conds.push(eq(auditLog.resourceId, String(req.query.resourceId)));
    if (req.query?.entityId) conds.push(eq(auditLog.entityId, String(req.query.entityId)));
    if (req.query?.action) conds.push(eq(auditLog.action, String(req.query.action)));
    if (req.query?.since) conds.push(gte(auditLog.ts, new Date(String(req.query.since))));
    if (req.query?.until) conds.push(lte(auditLog.ts, new Date(String(req.query.until))));

    const rows = await db
      .select()
      .from(auditLog)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLog.ts))
      .limit(limit);

    return res.status(200).json(jsonSafe({ ok: true, rows, limit }));
  } catch (err) {
    console.error('[admin/audit] failed:', err);
    return res.status(500).json({ error: err.message });
  }
};

// BigInt → string so res.json never throws on serialization. Schema sets
// id mode to 'number' but counts / future bigint cols can still arrive
// as BigInt; this is the cheap belt-and-braces.
function jsonSafe(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = jsonSafe(value[k]);
    return out;
  }
  return value;
}

function clampInt(v, dflt, lo, hi) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
