/**
 * /api/admin/ledger/accounts
 *   GET    ?entityId=...                              → list chart of accounts
 *   POST   { entityId, code, name, type, ... }        → create custom account
 *   PATCH  { entityId, accountId, name?, description?, archived? }
 *                                                     → rename / archive
 *
 * Admin-only. `code` and `type` are immutable post-creation (renaming would
 * invalidate historical reports). System (template-seeded) accounts can be
 * archived but not deleted.
 */

const { requireSession, applyCors } = require('../../_lib/auth');
const { getDb, getSchema, isPostgresEnabled, isDualWriteEnabled } = require('../../_lib/db');
const { eq } = require('drizzle-orm');
const { createAccount, updateAccount } = require('../../_lib/ledger/accounts');
const { audit } = require('../../_lib/audit-log');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await requireSession(req, res);
  if (!session) return;
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  if (!isPostgresEnabled() && !isDualWriteEnabled()) {
    return res.status(409).json({
      error: 'Ledger is inactive — set DB_BACKEND=postgres or DB_DUAL_WRITE=1.',
    });
  }

  try {
    if (req.method === 'GET') {
      const entityId = req.query?.entityId;
      if (!entityId) return res.status(400).json({ error: 'entityId required' });
      const db = getDb();
      const { accounts } = getSchema();
      const rows = await db
        .select()
        .from(accounts)
        .where(eq(accounts.entityId, entityId))
        .orderBy(accounts.code);
      return res.status(200).json({ ok: true, entityId, rows });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const row = await createAccount(body);
      await audit({
        action: 'ledger.account.create',
        actorUserId: session.userId,
        actorEmail: session.email,
        actorRole: session.role,
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
        userAgent: req.headers['user-agent'],
        resourceType: 'account',
        resourceId: row.id,
        entityId: row.entityId,
        after: { code: row.code, name: row.name, type: row.type },
      });
      return res.status(201).json({ ok: true, account: row });
    }

    if (req.method === 'PATCH') {
      const body = req.body || {};
      const row = await updateAccount(body);
      await audit({
        action: 'ledger.account.update',
        actorUserId: session.userId,
        actorEmail: session.email,
        actorRole: session.role,
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
        userAgent: req.headers['user-agent'],
        resourceType: 'account',
        resourceId: row.id,
        entityId: row.entityId,
        after: { name: row.name, archived: row.archived, description: row.description },
      });
      return res.status(200).json({ ok: true, account: row });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    if (err.code === 'ACCOUNT_CODE_DUPLICATE' || err.code === 'ACCOUNT_NOT_FOUND') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    console.error('[admin/ledger/accounts] failed:', err);
    return res.status(400).json({ error: err.message });
  }
};
