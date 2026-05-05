/**
 * /api/admin/tax-vat — Stage 7 admin façade for VAT + MTD.
 *
 *   GET  ?kind=registration&entityId=...
 *   GET  ?kind=return&entityId=...&periodStart=...&periodEnd=...&scheme=...
 *   GET  ?kind=returns&entityId=...
 *   GET  ?kind=threshold&entityId=...&asOfDate=...
 *   GET  ?kind=obligations&entityId=...
 *
 *   POST { kind:'register', entityId, vatNumber, scheme, registrationDate, ... }
 *   POST { kind:'capture', journalLineId, entityId, side, vatRatePct, grossPence|netPence|netPence+vatPence }
 *   POST { kind:'submit', entityId, periodStart, periodEnd, periodKey, signedByUserId }
 *   POST { kind:'sync_obligations', entityId, from }
 *
 * Admin-only and gated behind DB_BACKEND=postgres or DB_DUAL_WRITE=1
 * — same envelope as Stage 5/6.
 */

const { requireSession, applyCors } = require('../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled } = require('../_lib/db');
const vat = require('../_lib/tax/vat');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const session = await requireSession(req, res);
  if (!session) return;
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (!isPostgresEnabled() && !isDualWriteEnabled()) {
    return res.status(409).json({ error: 'Stage 7 requires DB_BACKEND=postgres or DB_DUAL_WRITE=1' });
  }
  const actor = {
    userId: session.userId,
    email: session.email,
    role: session.role,
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
  };
  try {
    if (req.method === 'GET') {
      const { kind, entityId, periodStart, periodEnd, scheme, asOfDate, taxYear, region } = req.query || {};
      switch (kind) {
        case 'registration':
          if (!entityId) return res.status(400).json({ error: 'entityId required' });
          return res.status(200).json({ ok: true, registration: await vat.getActiveRegistration(entityId) });
        case 'return':
          if (!entityId || !periodStart || !periodEnd) {
            return res.status(400).json({ error: 'entityId + periodStart + periodEnd required' });
          }
          return res.status(200).json({
            ok: true,
            ...(await vat.computeReturn({ entityId, periodStart, periodEnd, scheme })),
          });
        case 'returns':
          if (!entityId) return res.status(400).json({ error: 'entityId required' });
          return res.status(200).json({ ok: true, returns: await vat.listReturns(entityId) });
        case 'threshold':
          if (!entityId) return res.status(400).json({ error: 'entityId required' });
          return res.status(200).json({
            ok: true,
            ...(await vat.getThresholdState({
              entityId,
              asOfDate,
              taxYear: taxYear ? Number(taxYear) : 2025,
              region: region || 'rUK',
            })),
          });
        case 'obligations':
          if (!entityId) return res.status(400).json({ error: 'entityId required' });
          return res.status(200).json({ ok: true, obligations: await vat.listObligations(entityId) });
        default:
          return res.status(400).json({ error: 'unknown kind' });
      }
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body || {};
    switch (body.kind) {
      case 'register':
        return res.status(200).json({ ok: true, ...(await vat.registerForVAT(body, { actor })) });
      case 'capture':
        return res.status(200).json({ ok: true, ...(await vat.captureLineVat(body, { actor })) });
      case 'submit':
        return res.status(200).json({ ok: true, ...(await vat.submitReturn(body, { actor })) });
      case 'sync_obligations':
        return res.status(200).json({ ok: true, ...(await vat.syncObligations(body, { actor })) });
      default:
        return res.status(400).json({ error: 'unknown kind' });
    }
  } catch (err) {
    const code = err.code === 'VAT_RETURN_DUPLICATE' ? 409 : 500;
    return res.status(code).json({ error: err.message, code: err.code });
  }
};
