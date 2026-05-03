/**
 * /api/admin/ledger/periods
 *   GET    ?entityId=...                            → list periods (open + locked)
 *   POST   { entityId, label, startDate, endDate, lockNow? }
 *                                                   → create (and optionally lock) a period
 *   PATCH  { entityId, periodId, action: 'lock'|'unlock', reason? }
 *                                                   → close or re-open a period
 *
 * Closing a period prevents new journals dated within [start,end]. The DB
 * trigger `journal_lines_period_lock_trg` is the backstop; the posting
 * library checks first for a friendlier error.
 */

const { requireSession, applyCors } = require('../../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled } = require('../../_lib/db');
const {
  upsertPeriod,
  lockPeriod,
  unlockPeriod,
  listPeriods,
} = require('../../_lib/ledger/periods');

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

  const actor = {
    userId: session.userId,
    email: session.email,
    role: session.role,
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'],
  };

  try {
    if (req.method === 'GET') {
      const entityId = req.query?.entityId;
      if (!entityId) return res.status(400).json({ error: 'entityId required' });
      const rows = await listPeriods(entityId);
      return res.status(200).json({ ok: true, entityId, rows });
    }

    if (req.method === 'POST') {
      const { entityId, label, startDate, endDate, lockNow } = req.body || {};
      if (!entityId || !label || !startDate || !endDate) {
        return res
          .status(400)
          .json({ error: 'entityId, label, startDate, endDate required' });
      }
      const period = await upsertPeriod({ entityId, label, startDate, endDate });
      if (lockNow) {
        const locked = await lockPeriod(entityId, period.id, { actor });
        return res.status(201).json({ ok: true, period: locked });
      }
      return res.status(201).json({ ok: true, period });
    }

    if (req.method === 'PATCH') {
      const { entityId, periodId, action } = req.body || {};
      if (!entityId || !periodId || !action) {
        return res.status(400).json({ error: 'entityId, periodId, action required' });
      }
      if (action === 'lock') {
        const row = await lockPeriod(entityId, periodId, { actor });
        return res.status(200).json({ ok: true, period: row });
      }
      if (action === 'unlock') {
        const row = await unlockPeriod(entityId, periodId, { actor });
        return res.status(200).json({ ok: true, period: row });
      }
      return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[admin/ledger/periods] failed:', err);
    return res.status(400).json({ error: err.message });
  }
};
