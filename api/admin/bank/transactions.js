/**
 * GET /api/admin/bank/transactions?bankAccountId=...&status=unmatched&limit=100
 *
 * List bank transactions for a bank account. Read-only.
 */

const { requireSession, applyCors } = require('../../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled } = require('../../_lib/db');
const { listTransactions } = require('../../_lib/bank/transactions');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const session = await requireSession(req, res);
  if (!session) return;
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (!isPostgresEnabled() && !isDualWriteEnabled()) {
    return res.status(200).json({ ok: true, rows: [], message: 'Bank feeds inactive' });
  }
  try {
    const { bankAccountId, status, limit, offset } = req.query || {};
    if (!bankAccountId) return res.status(400).json({ error: 'bankAccountId required' });
    const rows = await listTransactions({
      bankAccountId,
      status: status || null,
      limit: Math.min(Number(limit) || 100, 500),
      offset: Number(offset) || 0,
    });
    return res.status(200).json({ ok: true, rows });
  } catch (err) {
    console.error('[admin/bank/transactions]', err);
    return res.status(500).json({ error: err.message });
  }
};
