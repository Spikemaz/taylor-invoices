/**
 * POST /api/admin/bank/match
 *
 * Resolve an unmatched bank transaction. Three actions:
 *   - { action: 'invoice', bankTxId, invoiceId, customerName? }
 *       Posts an invoice_payment journal and links matchedJournalId.
 *   - { action: 'categorise', bankTxId, accountCode, vendorOrPayer? }
 *       Posts a fresh expense (out) or generic income (in) journal.
 *   - { action: 'ignore',     bankTxId, reason? }
 *       Marks the line ignored without posting anything.
 *
 * Returns { ok: true, journalId? }.
 */

const { requireSession, applyCors } = require('../../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled } = require('../../_lib/db');
const {
  matchTransactionToInvoice,
  categoriseTransaction,
  ignoreTransaction,
  suggestMatches,
} = require('../../_lib/bank/transactions');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS, GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const session = await requireSession(req, res);
  if (!session) return;
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (!isPostgresEnabled() && !isDualWriteEnabled()) {
    return res.status(409).json({ error: 'Bank feeds require DB_BACKEND=postgres or DB_DUAL_WRITE=1' });
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
      const id = req.query?.bankTxId;
      if (!id) return res.status(400).json({ error: 'bankTxId required' });
      const suggestions = await suggestMatches(id);
      return res.status(200).json({ ok: true, suggestions });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body || {};
    if (!body.bankTxId) return res.status(400).json({ error: 'bankTxId required' });
    if (body.action === 'invoice') {
      const r = await matchTransactionToInvoice(
        { bankTxId: body.bankTxId, invoiceId: body.invoiceId, customerName: body.customerName },
        { actor }
      );
      return res.status(200).json({ ok: true, journalId: r.journalId });
    }
    if (body.action === 'categorise') {
      const r = await categoriseTransaction(
        { bankTxId: body.bankTxId, accountCode: body.accountCode, vendorOrPayer: body.vendorOrPayer },
        { actor }
      );
      return res.status(200).json({ ok: true, journalId: r.journalId });
    }
    if (body.action === 'ignore') {
      await ignoreTransaction(body.bankTxId, body.reason || null, { actor });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'unknown action; expected invoice|categorise|ignore' });
  } catch (err) {
    console.error('[admin/bank/match]', err);
    return res.status(500).json({ error: err.message });
  }
};
