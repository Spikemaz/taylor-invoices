/**
 * /api/admin/expenses — admin façade for Stage 4 (slice 1).
 *
 *   GET  ?kind=receipts&entityId=...&status=...
 *   GET  ?kind=mileage&entityId=...&taxYear=...
 *   GET  ?kind=mileage_summary&entityId=...&taxYear=...
 *   GET  ?kind=claims&entityId=...&status=...
 *   GET  ?kind=owed&entityId=...
 *
 *   POST { kind:'receipt.create', ... }
 *   POST { kind:'receipt.ocr', id, result }
 *   POST { kind:'receipt.approve', id, patch }
 *   POST { kind:'receipt.reject', id, reason }
 *   POST { kind:'mileage.preview', ... }
 *   POST { kind:'mileage.create', ... }
 *   POST { kind:'claim.create', ... }
 *   POST { kind:'claim.addItem', claimId, item }
 *   POST { kind:'claim.approve', claimId }
 */

const { requireSession, applyCors } = require('../_lib/auth');
const { isPostgresEnabled, isDualWriteEnabled } = require('../_lib/db');
const receiptsLib = require('../_lib/expenses/receipts');
const mileageLib = require('../_lib/expenses/mileage');
const claimsLib = require('../_lib/expenses/claims');

module.exports = async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const session = await requireSession(req, res);
  if (!session) return;
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  if (!isPostgresEnabled() && !isDualWriteEnabled()) {
    return res.status(409).json({ error: 'Stage 4 requires DB_BACKEND=postgres or DB_DUAL_WRITE=1' });
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
      const { kind, entityId, status, taxYear } = req.query || {};
      if (!entityId) return res.status(400).json({ error: 'entityId required' });
      switch (kind) {
        case 'receipts':
          return res.status(200).json({ ok: true, rows: await receiptsLib.listReceipts({ entityId, status }) });
        case 'mileage':
          return res.status(200).json({ ok: true, rows: await mileageLib.listMileageLogs({ entityId, taxYear: taxYear ? Number(taxYear) : undefined }) });
        case 'mileage_summary':
          if (!taxYear) return res.status(400).json({ error: 'taxYear required' });
          return res.status(200).json({ ok: true, ...(await mileageLib.ytdMileageSummary(entityId, Number(taxYear))) });
        case 'claims':
          return res.status(200).json({ ok: true, rows: await claimsLib.listClaims({ entityId, status }) });
        case 'owed':
          return res.status(200).json({ ok: true, ...(await claimsLib.owedToClaimant(entityId)) });
        default:
          return res.status(400).json({ error: 'unknown kind' });
      }
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const body = req.body || {};
    switch (body.kind) {
      case 'receipt.create':   return res.status(200).json({ ok: true, ...(await receiptsLib.createReceipt(body, { actor })) });
      case 'receipt.ocr':      return res.status(200).json({ ok: true, ...(await receiptsLib.recordOcrResult(body.id, body.result || {}, { actor })) });
      case 'receipt.approve':  return res.status(200).json({ ok: true, ...(await receiptsLib.approveReceipt(body.id, body.patch || {}, { actor })) });
      case 'receipt.reject':   return res.status(200).json({ ok: true, ...(await receiptsLib.rejectReceipt(body.id, body.reason, { actor })) });
      case 'mileage.preview':  return res.status(200).json({ ok: true, ...(await mileageLib.previewMileage(body)) });
      case 'mileage.create':   return res.status(200).json({ ok: true, ...(await mileageLib.createMileageLog(body, { actor })) });
      case 'claim.create':     return res.status(200).json({ ok: true, ...(await claimsLib.createClaim(body, { actor })) });
      case 'claim.addItem':    return res.status(200).json({ ok: true, ...(await claimsLib.addItem(body.claimId, body.item || {}, { actor })) });
      case 'claim.approve':    return res.status(200).json({ ok: true, ...(await claimsLib.approveClaim(body.claimId, { actor })) });
      default: return res.status(400).json({ error: 'unknown kind' });
    }
  } catch (err) {
    console.error('[admin/expenses]', err);
    return res.status(500).json({ error: err.message });
  }
};
