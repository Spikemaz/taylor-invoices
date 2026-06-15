/**
 * POST /api/admin/ledger/seed   { entityId }
 *
 * Seed the UK chart of accounts for an entity. Idempotent: re-running
 * inserts only the codes that don't yet exist for this entity.
 *
 * Picks the template from the entity's `type` column (`sole_trader` |
 * `limited` | other → falls back to sole-trader).
 */

const { requireSession, applyCors } = require('../../_lib/auth');
const { getDb, getSchema, isPostgresEnabled, isDualWriteEnabled } = require('../../_lib/db');
const { audit } = require('../../_lib/audit-log');
const { seedAccountsForEntity } = require('../../_lib/ledger/accounts');
const { eq } = require('drizzle-orm');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await requireSession(req, res);
  if (!session) return;
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  if (!isPostgresEnabled() && !isDualWriteEnabled()) {
    return res.status(409).json({
      error: 'Ledger writes are inactive — set DB_BACKEND=postgres or DB_DUAL_WRITE=1.',
    });
  }

  const entityId = (req.body && req.body.entityId) || req.query?.entityId;
  if (!entityId) return res.status(400).json({ error: 'entityId required' });

  try {
    const db = getDb();
    const { entities } = getSchema();
    const entRows = await db
      .select()
      .from(entities)
      .where(eq(entities.id, entityId))
      .limit(1);
    if (!entRows[0]) return res.status(404).json({ error: 'Entity not found' });

    const result = await seedAccountsForEntity(entityId, entRows[0].type);

    await audit({
      action: 'ledger.accounts.seed',
      actorUserId: session.userId,
      actorEmail: session.email,
      actorRole: session.role,
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'],
      resourceType: 'entity',
      resourceId: entityId,
      entityId,
      after: result,
    });

    return res.status(200).json({ ok: true, entityId, ...result });
  } catch (err) {
    console.error('[admin/ledger/seed] failed:', err);
    return res.status(500).json({ error: err.message });
  }
};
