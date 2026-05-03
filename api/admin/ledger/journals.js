/**
 * GET /api/admin/ledger/journals?entityId=...&limit=50&offset=0&source=...
 * GET /api/admin/ledger/journals?entityId=...&id=jrn_...
 *
 * List journals (paged) or fetch one journal with its lines. Read-only;
 * admin-only.
 */

const { requireSession, applyCors } = require('../../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled } = require('../../_lib/db');
const { listJournals, getJournalDetail } = require('../../_lib/ledger/reports');

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
      rows: [],
    });
  }

  const entityId = req.query?.entityId;
  if (!entityId) return res.status(400).json({ error: 'entityId required' });

  try {
    if (req.query?.id) {
      const detail = await getJournalDetail(entityId, req.query.id);
      if (!detail) return res.status(404).json({ error: 'Journal not found' });
      return res.status(200).json({ ok: true, journal: detail });
    }
    const limit = parseInt(req.query?.limit, 10) || 50;
    const offset = parseInt(req.query?.offset, 10) || 0;
    const source = req.query?.source || undefined;
    const rows = await listJournals(entityId, { limit, offset, source });
    return res.status(200).json({ ok: true, entityId, rows, limit, offset });
  } catch (err) {
    console.error('[admin/ledger/journals] failed:', err);
    return res.status(500).json({ error: err.message });
  }
};
