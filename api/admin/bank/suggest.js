/**
 * GET /api/admin/bank/suggest?entityId=...&bankTxId=...
 *
 * Returns the top combined suggestion for an unmatched bank line:
 *   - rule match if any (confidence 100)
 *   - else merchant memory if any (confidence ramps with hit count)
 *   - else null
 *
 * Used by the (future) reconciliation UI's right-hand "suggested
 * category" column.
 */

const { requireSession, applyCors } = require('../../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled } = require('../../_lib/db');
const { suggestCategory } = require('../../_lib/bank/rules');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const session = await requireSession(req, res);
  if (!session) return;
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (!isPostgresEnabled() && !isDualWriteEnabled()) {
    return res.status(409).json({ error: 'Auto-categorisation requires DB_BACKEND=postgres or DB_DUAL_WRITE=1' });
  }
  try {
    const { entityId, bankTxId } = req.query || {};
    if (!entityId) return res.status(400).json({ error: 'entityId required' });
    if (!bankTxId) return res.status(400).json({ error: 'bankTxId required' });
    const s = await suggestCategory(entityId, bankTxId);
    return res.status(200).json({ ok: true, suggestion: s });
  } catch (err) {
    console.error('[admin/bank/suggest]', err);
    return res.status(500).json({ error: err.message });
  }
};
