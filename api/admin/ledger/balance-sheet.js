/**
 * GET /api/admin/ledger/balance-sheet?entityId=...&asOf=YYYY-MM-DD
 *
 * Balance sheet at a point in time. Read-only; admin-only.
 */

const { requireSession, applyCors } = require('../../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled } = require('../../_lib/db');
const { balanceSheet } = require('../../_lib/ledger/reports');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const session = await requireSession(req, res);
  if (!session) return;
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

  if (!isPostgresEnabled() && !isDualWriteEnabled()) {
    return res.status(200).json({
      ok: true,
      backend: process.env.DB_BACKEND || 'sheets',
      message: 'Ledger reads are inactive (set DB_BACKEND=postgres or DB_DUAL_WRITE=1)',
    });
  }

  const entityId = req.query?.entityId;
  if (!entityId) return res.status(400).json({ error: 'entityId required' });
  const asOf = req.query?.asOf || null;

  try {
    const bs = await balanceSheet(entityId, asOf);
    return res.status(200).json({ ok: true, entityId, ...bs });
  } catch (err) {
    console.error('[admin/ledger/balance-sheet] failed:', err);
    return res.status(500).json({ error: err.message });
  }
};
