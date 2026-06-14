/**
 * POST /api/admin/bank/import
 *
 * Parse a CSV statement (auto-detects the bank format) and idempotently
 * insert rows into `bank_transactions` for the given bank account.
 *
 * Body: { bankAccountId, entityId, csv: <raw string>, format?: 'starling'|...,
 *         mapping?: { date, amount, debit, credit, description, ... } }
 *
 * Returns { format, inserted, skipped, parseSkipped: [...] }.
 */

const { requireSession, applyCors } = require('../../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled } = require('../../_lib/db');
const { parseStatementCsv } = require('../../_lib/bank/csv-parsers');
const { importTransactions } = require('../../_lib/bank/transactions');

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
    if (!body.bankAccountId) return res.status(400).json({ error: 'bankAccountId required' });
    if (!body.entityId) return res.status(400).json({ error: 'entityId required' });
    if (typeof body.csv !== 'string' || !body.csv.trim()) {
      return res.status(400).json({ error: 'csv (string) required' });
    }
    const parsed = parseStatementCsv(body.csv, { format: body.format, mapping: body.mapping });
    const actor = {
      userId: session.userId,
      email: session.email,
      role: session.role,
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'],
    };
    const result = await importTransactions(
      {
        bankAccountId: body.bankAccountId,
        entityId: body.entityId,
        rows: parsed.rows,
      },
      { actor }
    );
    return res.status(200).json({
      ok: true,
      format: parsed.format,
      inserted: result.inserted,
      skipped: result.skipped,
      parseSkipped: parsed.skipped,
    });
  } catch (err) {
    console.error('[admin/bank/import]', err);
    return res.status(500).json({ error: err.message });
  }
};
