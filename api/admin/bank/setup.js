/**
 * POST /api/admin/bank/setup
 *
 * One-shot setup for a CSV-uploaded bank account: creates a
 * `bank_connection` (provider='csv') and a linked `bank_account` pinned
 * to a Chart-of-Accounts code (default 0800).
 *
 * Body: { entityId, name, ledgerAccountCode?, accountNumberLast4?, sortCode?,
 *         openingBalancePence?, openingBalanceDate?, institutionName? }
 *
 * Returns { connectionId, bankAccountId, ledgerAccountId }.
 */

const { requireSession, applyCors } = require('../../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled } = require('../../_lib/db');
const {
  createBankConnection,
  createBankAccount,
} = require('../../_lib/bank/transactions');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const session = await requireSession(req, res);
  if (!session) return;
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (!isPostgresEnabled() && !isDualWriteEnabled()) {
    return res.status(409).json({ error: 'Bank feeds require DB_BACKEND=postgres or DB_DUAL_WRITE=1' });
  }
  try {
    const body = req.body || {};
    if (!body.entityId) return res.status(400).json({ error: 'entityId required' });
    if (!body.name) return res.status(400).json({ error: 'name required' });
    const actor = {
      userId: session.userId,
      email: session.email,
      role: session.role,
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'],
    };
    const conn = await createBankConnection(
      {
        entityId: body.entityId,
        provider: 'csv',
        institutionName: body.institutionName || null,
      },
      { actor }
    );
    const acct = await createBankAccount(
      {
        entityId: body.entityId,
        connectionId: conn.id,
        ledgerAccountCode: body.ledgerAccountCode || '0800',
        name: body.name,
        accountNumberLast4: body.accountNumberLast4,
        sortCode: body.sortCode,
        openingBalancePence: body.openingBalancePence,
        openingBalanceDate: body.openingBalanceDate,
      },
      { actor }
    );
    return res.status(200).json({
      ok: true,
      connectionId: conn.id,
      bankAccountId: acct.id,
      ledgerAccountId: acct.ledgerAccountId,
    });
  } catch (err) {
    console.error('[admin/bank/setup]', err);
    return res.status(500).json({ error: err.message });
  }
};
