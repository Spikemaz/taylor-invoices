/**
 * POST /api/admin/ledger/manual-journal
 *   { entityId, date, description, notes?, lines:[{accountCode|accountId, debit, credit, memo?}] }
 *
 * Post a manual journal. Admin-only. Pence amounts. Wraps `postManualJournal`.
 */

const { requireSession, applyCors } = require('../../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled } = require('../../_lib/db');
const { postManualJournal } = require('../../_lib/ledger/posting');

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

  const body = req.body || {};
  const { entityId, date, description, notes, lines } = body;
  if (!entityId) return res.status(400).json({ error: 'entityId required' });
  if (!date) return res.status(400).json({ error: 'date required' });
  if (!Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({ error: 'at least 2 lines required' });
  }

  try {
    const result = await postManualJournal(
      { entityId, date, description, notes, lines, createdBy: session.userId },
      {
        actor: {
          userId: session.userId,
          email: session.email,
          role: session.role,
          ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
          userAgent: req.headers['user-agent'],
        },
      }
    );
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    if (err.code === 'PERIOD_LOCKED') {
      return res.status(409).json({ error: err.message, code: 'PERIOD_LOCKED' });
    }
    console.error('[admin/ledger/manual-journal] failed:', err);
    return res.status(400).json({ error: err.message });
  }
};
